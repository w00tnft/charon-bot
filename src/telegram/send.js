import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting, strategyById } from '../db/settings.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, positionButtons, intentButtons } from './menus.js';
import { batchById } from '../db/decisions.js';

export function stripHtml(text) {
  return String(text ?? '')
    .replace(/<\/?b>/gi, '')
    .replace(/<\/?i>/gi, '')
    .replace(/<\/?code>/gi, '')
    .replace(/<\/?pre>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export async function safeSend(chatId, text, opts = {}) {
  try {
    const { parse_mode, ...options } = opts;
    await bot.sendMessage(chatId, stripHtml(text), options);
  } catch (err) {
    console.error('[telegram] send failed:', err.message);
  }
}

export async function sendTelegram(text, extra = {}) {
  const { parse_mode, ...safeExtra } = extra;
  return bot.sendMessage(TELEGRAM_CHAT_ID, stripHtml(text), {
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...safeExtra,
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
      await bot.sendMessage(id, 'Charon connected — Telegram delivery confirmed.', {
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
  return bot.sendMessage(chatId, stripHtml(lines.filter(Boolean).join('\n')), {
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
  const strat = strategyById(stratId) || {};

  const symbol = escapeHtml(position.symbol || token.symbol || short(position.mint));
  const header = isDryRun ? '⚡ <b>CHARON DRY-RUN SIGNAL</b>' : '⚡ <b>CHARON LIVE SIGNAL</b>';

  const lines = [
    header,
    '',
    `🪙 Token: <b>$${symbol}</b>`,
    `📋 CA: <code>${position.mint}</code>`,
    `📊 McAp: <b>${fmtUsd(position.entry_mcap || metrics.marketCapUsd)}</b>`,
    `🔗 Sources: <b>${sourceLine}</b>`,
  ];

  if (safetyScore !== null) {
    const safetyIcon = safetyPassed ? '✅' : '⚠️';
    lines.push('');
    lines.push(`🛡️ Safety Score: <b>${safetyScore}/100 ${safetyIcon}</b>`);
    const details = [];
    details.push(`Deployer: ${rugCount === 0 ? 'Clean (0 rugs) ✅' : `${rugCount} rug${rugCount !== 1 ? 's' : ''} ⚠️`}${walletAgeDays != null ? ` · ${walletAgeDays}d old` : ''}`);
    details.push(`LP: ${lpBurned ? 'Burned ✅' : 'Not burned ⚠️'}`);
    details.push(`Mint: ${mintRevoked ? 'Revoked ✅' : 'Not revoked ⚠️'}`);
    if (devPct != null) details.push(`Dev Holding: ${devPct}%${devPct > 10 ? ' ⚠️' : ' ✅'}`);
    if (top10Pct != null) details.push(`Top 10: ${top10Pct}%${top10Pct > 30 ? ' ⚠️' : ' ✅'}`);
    details.forEach((d, i) => lines.push(`${i === details.length - 1 ? '└' : '├'} ${d}`));
  }

  lines.push('');
  lines.push(`📈 Strategy: <b>${escapeHtml(stratId || 'degen')}</b>`);

  if (strat.exit_type === 'full') {
    // Full-exit system: flat TP, no runner
    const tpPct = strat.take_profit_pct ?? 15;
    const hardPct = strat.hard_stop_pct ?? 25;
    const emergencyPct = strat.emergency_stop_pct ?? 25;
    const maxHoldMin = strat.max_hold_ms ? Math.round(strat.max_hold_ms / 60000) : null;
    const sizeSol = strat.position_size_sol ?? 0.05;
    lines.push(`🎯 TP: <b>+${tpPct}% full exit</b>`);
    lines.push(`🛑 Stop: <b>−${hardPct}%</b> | Emergency: <b>−${emergencyPct}%</b>`);
    if (maxHoldMin) lines.push(`⏱️ Max: <b>${maxHoldMin}min</b> | 💰 Size: <b>${sizeSol} SOL</b>`);
  } else if (strat.partial_exit_pct != null) {
    // New partial-exit + trailing-stop system
    const exitPct = strat.partial_exit_pct ?? 30;
    const exitSize = Math.round((strat.partial_exit_size ?? 0.60) * 100);
    const trailPct = strat.trailing_stop_pct ?? 20;
    const hardPct = strat.hard_stop_pct ?? 25;
    const maxHoldMin = strat.max_hold_ms ? Math.round(strat.max_hold_ms / 60000) : null;
    lines.push(`💰 Partial Exit: <b>+${exitPct}% → sell ${exitSize}%</b>`);
    lines.push(`🔔 Trailing Stop: <b>−${trailPct}% from ATH</b>`);
    lines.push(`🛑 Hard Stop: <b>−${hardPct}% from entry</b>`);
    if (maxHoldMin) lines.push(`⏱️ Max Hold: <b>${maxHoldMin} min</b>`);
  } else {
    // Legacy fixed TP/SL system
    const maxHoldMs = strat.max_hold_ms || 0;
    const maxHoldMin = maxHoldMs ? Math.round(maxHoldMs / 60000) : null;
    if (maxHoldMin) lines.push(`⏱️ Max Hold: <b>${maxHoldMin} min</b>`);
    lines.push(`🎯 Target: <b>+${position.tp_percent}%</b>`);
    lines.push(`🛑 Stop Loss: <b>${position.sl_percent}%</b>`);
  }

  // Sim costs (dry-run only)
  const entrySlip = Number(position.entry_slippage_pct || 0);
  const gasCost = Number(position.gas_cost_sol || 0);
  const effectiveSol = Number(position.effective_position_sol || 0);
  if (isDryRun && entrySlip > 0) {
    lines.push('');
    lines.push(`🔬 <b>Sim costs:</b> slip: ${entrySlip.toFixed(2)}% | gas: ${gasCost.toFixed(6)} SOL | eff: ${effectiveSol.toFixed(4)} SOL`);
  }

  const gmgnUrl = token.gmgnUrl || gmgnLink(position.mint);
  const twitterHandle = token.twitter ? token.twitter.replace(/^@/, '') : null;
  const buttons = [[{ text: '📈 Chart', url: gmgnUrl }]];
  if (twitterHandle) buttons[0].push({ text: '🐦 Twitter', url: `https://twitter.com/${twitterHandle}` });

  await sendTelegram(lines.join('\n'), { reply_markup: { inline_keyboard: buttons } });
}

export async function sendPartialExit(position, pnlPercent, partialExitSize, trailingStopPct) {
  const symbol = escapeHtml(position.symbol || short(position.mint));
  const sizePct = Math.round((partialExitSize ?? 0.6) * 100);
  const trail = Math.round(trailingStopPct ?? 20);
  const isDryRun = position.execution_mode !== 'live';
  const header = isDryRun ? '💰 <b>PARTIAL EXIT (dry-run)</b>' : '💰 <b>PARTIAL EXIT — Capital Recovered</b>';
  await sendTelegram([
    header,
    '',
    `🪙 Token: <b>$${symbol}</b>`,
    `📋 CA: <code>${position.mint}</code>`,
    `📊 PnL at exit: <b>+${pnlPercent.toFixed(1)}%</b>`,
    `💵 Sold: <b>${sizePct}%</b> of position`,
    '🎲 Remainder riding with house money',
    `📈 Trailing stop now active: ATH −${trail}%`,
  ].join('\n'));
}

export async function sendTrailActivated(position, activationPrice, pnlPercent, trailPct) {
  const symbol = escapeHtml(position.symbol || short(position.mint));
  const entryPrice = Number(position.entry_price || 0);
  const trailStop = activationPrice * (1 - trailPct);
  await sendTelegram([
    `🚀 <b>TRAIL ACTIVATED</b> — $${symbol}`,
    '',
    `📥 Entry:      <b>${entryPrice > 0 ? '$' + entryPrice.toFixed(6) : '?'}</b>`,
    `📍 Current:    <b>$${activationPrice.toFixed(6)} (+${pnlPercent.toFixed(1)}%)</b>`,
    `🛑 Trail stop: <b>$${trailStop.toFixed(6)}</b> (−${(trailPct * 100).toFixed(0)}% from peak)`,
    `Letting it run... 🚀`,
  ].join('\n')).catch(() => {});
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  const reason = position.exitReason || position.exit_reason || '';
  const cls = position.exit_class || 'loss';
  const clsPrefix = cls === 'win' ? '🏆 WIN' : cls === 'neutral' ? '⚖️ NEUTRAL' : '💀 LOSS';

  if (reason === 'TRAIL_STOP') {
    const symbol = escapeHtml(position.symbol || short(position.mint));
    const entryPrice = Number(position.entry_price || 0);
    const peakPrice = Number(position.trail_peak_price || 0);
    const exitPnl = Number(position.pnl_percent ?? position.pnlPercent ?? 0);
    const peakPnl = entryPrice > 0 && peakPrice > 0
      ? (peakPrice / entryPrice - 1) * 100
      : null;
    const fixedTpPct = strategyById(position.strategy_id)?.take_profit_pct ?? 25;
    const lines = [
      `🔔 <b>${clsPrefix} — Trail Stop (${label})</b>`,
      '',
      `🪙 Token: <b>$${symbol}</b>`,
      `📋 CA: <code>${position.mint}</code>`,
      '',
      `📥 Entry:  <b>${entryPrice > 0 ? '$' + entryPrice.toFixed(6) : '?'}</b>`,
      peakPnl !== null ? `📈 Peak:   <b>+${peakPnl.toFixed(1)}%</b>` : null,
      `📤 Exit:   <b>${fmtPct(exitPnl)}</b>`,
      `💰 Locked: <b>+${exitPnl.toFixed(1)}%</b> (vs fixed TP +${fixedTpPct}%)`,
    ].filter(Boolean);
    await sendTelegram(lines.join('\n'));
    return;
  }

  if (reason === 'TRAILING_STOP') {
    const symbol = escapeHtml(position.symbol || short(position.mint));
    const athMcap = Number(position.high_water_mcap || position.exit_mcap || 0);
    const exitMcap = Number(position.exit_mcap || position.mcap || 0);
    const dropPct = athMcap > 0 && exitMcap > 0
      ? ((exitMcap / athMcap) - 1) * 100
      : null;
    const lines = [
      `🔔 <b>${clsPrefix} — Trailing Stop (${label})</b>`,
      '',
      `🪙 Token: <b>$${symbol}</b>`,
      `📋 CA: <code>${position.mint}</code>`,
    ];
    if (athMcap > 0) lines.push(`📈 ATH McAp: <b>${fmtUsd(athMcap)}</b>`);
    if (dropPct !== null) lines.push(`📉 Drop from ATH: <b>${dropPct.toFixed(1)}%</b>`);
    lines.push(`💰 Final PnL: <b>${fmtPct(position.pnl_percent ?? position.pnlPercent)}</b>`);
    await sendTelegram(lines.join('\n'));
    return;
  }

  if (reason === 'HARD_SL') {
    const symbol = escapeHtml(position.symbol || short(position.mint));
    const lines = [
      `🛑 <b>${clsPrefix} — Hard Stop (${label})</b>`,
      '',
      `🪙 Token: <b>$${symbol}</b>`,
      `📋 CA: <code>${position.mint}</code>`,
      `💸 PnL: <b>${fmtPct(position.pnl_percent ?? position.pnlPercent)}</b>`,
    ];
    await sendTelegram(lines.join('\n'));
    return;
  }

  // For dry-run exits, append cost breakdown if simulation data exists
  const isDryRun = position.execution_mode !== 'live';
  const grossPnl = Number(position.gross_pnl_pct ?? position.pnl_percent ?? position.pnlPercent ?? 0);
  const netPnl = Number(position.net_pnl_pct ?? grossPnl);
  const entrySlip = Number(position.entry_slippage_pct || 0);
  const exitSlip = Number(position.exit_slippage_pct || 0);
  const exitGas = Number(position.exit_gas_sol || 0);
  const posSize = Number(position.size_sol || 0.03);
  const hasCosts = isDryRun && (entrySlip > 0 || exitSlip > 0 || exitGas > 0);

  if (hasCosts) {
    const gasCostPct = posSize > 0 ? (exitGas / posSize) * 100 : 0;
    const holdMs = position.closed_at_ms && position.opened_at_ms
      ? Number(position.closed_at_ms) - Number(position.opened_at_ms)
      : 0;
    const holdMin = holdMs > 0 ? Math.round(holdMs / 60000) : null;
    const symbol = escapeHtml(position.symbol || short(position.mint));
    const lines = [
      `🏁 <b>${clsPrefix} — ${escapeHtml(reason)} (${label})</b>`,
      '',
      `🪙 <b>$${symbol}</b>  <code>${position.mint}</code>`,
      '',
      `📥 Entry:          <b>${Number(position.entry_price || 0) > 0 ? '$' + Number(position.entry_price).toFixed(6) : '?'}</b>`,
      `📤 Exit:           <b>${Number(position.exit_price || 0) > 0 ? '$' + Number(position.exit_price).toFixed(6) : '?'}</b>`,
      '',
      `📊 Gross PnL:      <b>${fmtPct(grossPnl)}</b>`,
      `📉 Entry slip:     <b>−${entrySlip.toFixed(2)}%</b>`,
      `📉 Exit slip:      <b>−${exitSlip.toFixed(2)}%</b>`,
      `⛽ Gas (2 txns):   <b>−${gasCostPct.toFixed(2)}%</b>`,
      '──────────────────────────',
      `💰 NET PnL:        <b>${fmtPct(netPnl)}</b>`,
      `💎 NET SOL:        <b>${(posSize * netPnl / 100 >= 0 ? '+' : '') + (posSize * netPnl / 100).toFixed(4)} SOL</b>`,
      holdMin ? `⏱️ Hold: <b>${holdMin}m</b>` : null,
    ].filter(Boolean);
    await sendTelegram(lines.join('\n'));
    return;
  }

  await sendTelegram(`🏁 <b>${clsPrefix} — ${escapeHtml(reason)} (${label})</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
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
