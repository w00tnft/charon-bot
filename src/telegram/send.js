import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting } from '../db/settings.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, positionButtons, intentButtons } from './menus.js';
import { batchById } from '../db/decisions.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function probeTelegram() {
  const targets = [
    { label: `TELEGRAM_CHAT_ID env (${TELEGRAM_CHAT_ID})`, id: TELEGRAM_CHAT_ID },
    { label: '@FiferPigHouse (username)', id: '@FiferPigHouse' },
  ];

  // Deduplicate if env is already the username
  const seen = new Set();
  const unique = targets.filter(t => {
    const k = String(t.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let succeeded = false;
  for (const { label, id } of unique) {
    try {
      await bot.sendMessage(id, '✅ <b>Charon connected</b> — Telegram delivery confirmed.', {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
      });
      console.log(`[telegram] probe OK with ${label}`);
      if (String(id) !== String(TELEGRAM_CHAT_ID)) {
        console.log(`[telegram] ⚠️  Fix: set TELEGRAM_CHAT_ID=${id} in Railway`);
      }
      succeeded = true;
      break;
    } catch (err) {
      const detail = err.response?.body || err.message;
      console.log(`[telegram] probe FAILED for ${label}: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
    }
  }

  if (!succeeded) {
    console.log('[telegram] ⚠️  All probe targets failed. Check: bot is admin of channel, TELEGRAM_BOT_TOKEN is correct, channel exists.');
  }
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

export async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!position) return;

  const isDryRun = position.execution_mode !== 'live';
  let snapshot = {};
  try { snapshot = JSON.parse(position.snapshot_json || '{}'); } catch { /* */ }
  const candidate = snapshot.candidate || {};
  const safety = candidate.safety || {};
  const signals = candidate.signals || {};
  const metrics = candidate.metrics || {};
  const token = candidate.token || {};

  const safetyScore = safety.score ?? null;
  const safetyPassed = safety.passed ?? true;
  const deployerHistory = safety.deployerHistory || {};
  const rugCount = deployerHistory.rugCount ?? 0;
  const walletAgeDays = deployerHistory.walletAgeDays;

  const safetyFlags = safety.flags || [];
  const lpBurned = safetyFlags.some(f => /LP burned/i.test(f));
  const mintRevoked = safetyFlags.some(f => /mint revoked/i.test(f));
  const devMatch = safetyFlags.find(f => /dev holding ([\d.]+)%/i.test(f));
  const devPct = devMatch ? Number(devMatch.match(/([\d.]+)%/)[1]) : null;
  const top10Match = safetyFlags.find(f => /top10 holders ([\d.]+)%/i.test(f));
  const top10Pct = top10Match ? Number(top10Match.match(/([\d.]+)%/)[1]) : null;

  const srcCount = [signals.hasFeeClaim, signals.hasGraduated, signals.hasTrending].filter(Boolean).length;
  const sourceLine = srcCount > 0
    ? `${srcCount} signal${srcCount > 1 ? 's' : ''}`
    : escapeHtml(signals.label || signals.route || 'unknown');

  const stratId = position.strategy_id || snapshot.strategy || '';
  const maxHoldMs = candidate.strategy?.max_hold_ms || snapshot.candidate?.filters?.strategy?.max_hold_ms || 0;
  const maxHoldMin = position.max_hold_ms
    ? Math.round(position.max_hold_ms / 60000)
    : maxHoldMs ? Math.round(maxHoldMs / 60000) : null;

  const symbol = escapeHtml(position.symbol || token.symbol || short(position.mint));
  const header = isDryRun ? '⚡ <b>CHARON DRY-RUN SIGNAL</b>' : '⚡ <b>CHARON LIVE SIGNAL</b>';

  const lines = [
    header,
    `🪙 Token: <b>$${symbol}</b>`,
    `<code>${position.mint}</code>`,
    `📊 McAp: <b>${fmtUsd(position.entry_mcap || metrics.marketCapUsd)}</b>`,
    `🔗 Sources: <b>${sourceLine}</b>`,
  ];

  if (safetyScore !== null) {
    const safetyIcon = safetyPassed ? '✅' : '⚠️';
    lines.push(`🛡️ Safety Score: <b>${safetyScore}/100 ${safetyIcon}</b>`);
    const details = [];
    details.push(`Deployer: ${rugCount === 0 ? 'Clean (0 rugs) ✅' : `${rugCount} rug${rugCount !== 1 ? 's' : ''} ⚠️`}${walletAgeDays != null ? ` · ${walletAgeDays}d old` : ''}`);
    details.push(`LP: ${lpBurned ? 'Burned ✅' : 'Not burned ⚠️'}`);
    details.push(`Mint: ${mintRevoked ? 'Revoked ✅' : 'Not revoked ⚠️'}`);
    if (devPct != null) details.push(`Dev Holding: ${devPct}%${devPct > 10 ? ' ⚠️' : ' ✅'}`);
    if (top10Pct != null) details.push(`Top 10: ${top10Pct}%${top10Pct > 30 ? ' ⚠️' : ' ✅'}`);
    details.forEach((d, i) => lines.push(`${i === details.length - 1 ? '└' : '├'} ${d}`));
  }

  lines.push(`📈 Strategy: <b>${escapeHtml(stratId || 'degen')}</b>`);
  if (maxHoldMin) lines.push(`⏱️ Max Hold: <b>${maxHoldMin} min</b>`);
  lines.push(`🎯 Target: <b>+${position.tp_percent}%</b>`);
  lines.push(`🛑 Stop Loss: <b>${position.sl_percent}%</b>`);

  const gmgnUrl = token.gmgnUrl || gmgnLink(position.mint);
  const twitterHandle = token.twitter ? token.twitter.replace(/^@/, '') : null;
  const buttons = [[{ text: '📈 Chart', url: gmgnUrl }]];
  if (twitterHandle) buttons[0].push({ text: '🐦 Twitter', url: `https://twitter.com/${twitterHandle}` });

  await sendTelegram(lines.join('\n'), { reply_markup: { inline_keyboard: buttons } });
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  await sendTelegram(`🏁 <b>${label}: ${escapeHtml(position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
}

export async function sendTradeIntent(intentId, candidate, decision) {
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}
