import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json } from '../utils.js';
import { escapeHtml, fmtPct, fmtSol } from '../format.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { getBlacklist } from '../db/blacklist.js';
import { runLearning, sendLessons } from '../learning/commands.js';

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\n\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd']);
    const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/blacklist')) return sendBlacklistReport(chatId);
  if (text.startsWith('/summary')) return sendSummary(chatId);
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_fee_claim_sol',
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trending_min_volume_usd',
      'trending_min_swaps',
      'trending_max_rug_ratio',
      'trending_max_bundler_rate',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
      'max_open_positions',
      'dry_run_buy_sol',
      'default_tp_percent',
      'default_sl_percent',
      'default_trailing_enabled',
      'default_trailing_percent',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'blacklist', description: 'Show blacklisted tokens and banned deployers' },
    { command: 'summary', description: 'Trading summary: win rate, PnL, best/worst trades' },
    { command: 'pnl', description: 'PnL breakdown by route and totals' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

export async function sendBlacklistReport(chatId) {
  const { tokens, deployers } = getBlacklist();
  const ago = ms => {
    const mins = Math.round((Date.now() - ms) / 60000);
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  };
  const lines = ['🚫 <b>CHARON BLACKLIST</b>', ''];
  if (tokens.length === 0 && deployers.length === 0) {
    lines.push('No blacklisted tokens or deployers yet.');
  } else {
    lines.push(`<b>Tokens: ${tokens.length}</b>`);
    for (const t of tokens) {
      const sym = t.mint.slice(0, 8);
      lines.push(`• <code>${sym}…</code> — ${t.pnl_percent != null ? t.pnl_percent.toFixed(1) + '%' : '?'} (${ago(t.banned_at_ms)})`);
    }
    if (deployers.length > 0) {
      lines.push('');
      lines.push(`<b>Deployers: ${deployers.length}</b>`);
      for (const d of deployers) {
        lines.push(`• <code>${d.deployer.slice(0, 8)}…</code> — ${d.rug_count} rug${d.rug_count !== 1 ? 's' : ''} (${ago(d.latest_ms)})`);
      }
    }
  }
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

export async function sendSummary(chatId) {
  const closed = db.prepare("SELECT * FROM dry_run_positions WHERE status = 'closed' ORDER BY pnl_percent DESC").all();
  if (!closed.length) {
    return bot.sendMessage(chatId, '📊 <b>Summary</b>\n\nNo closed positions yet.', { parse_mode: 'HTML' });
  }
  const total = closed.length;
  const wins = closed.filter(p => (p.exit_class || (Number(p.pnl_percent || 0) > 0 ? 'win' : 'loss')) === 'win');
  const neutrals = closed.filter(p => p.exit_class === 'neutral');
  const losses = closed.filter(p => (p.exit_class || (Number(p.pnl_percent || 0) > 0 ? 'win' : 'loss')) === 'loss');
  const netScore = wins.length - losses.length;
  const netIcon = netScore > 0 ? '✅' : netScore < 0 ? '⚠️' : '➡️';
  const avgPnl = closed.reduce((s, p) => s + Number(p.pnl_percent || 0), 0) / total;
  const best = closed[0];
  const worst = closed[closed.length - 1];
  const lessonCount = db.prepare("SELECT COUNT(*) AS count FROM learning_lessons WHERE status = 'active'").get().count;
  const pct = n => `${Math.round(n / total * 100)}%`;

  const lines = [
    '📊 <b>Trading Summary</b>',
    '',
    `Closed positions: <b>${total}</b>`,
    `✅ Wins: <b>${wins.length}</b> (${pct(wins.length)})`,
    `⚖️ Neutral: <b>${neutrals.length}</b> (${pct(neutrals.length)})`,
    `❌ Losses: <b>${losses.length}</b> (${pct(losses.length)})`,
    `Net score: <b>${netScore > 0 ? '+' : ''}${netScore}</b> ${netIcon}`,
    `Avg PnL: <b>${fmtPct(avgPnl)}</b>`,
    '',
    `Best trade: <b>${escapeHtml(best.symbol || best.mint.slice(0, 8))}…</b> ${fmtPct(Number(best.pnl_percent))}`,
    `Worst trade: <b>${escapeHtml(worst.symbol || worst.mint.slice(0, 8))}…</b> ${fmtPct(Number(worst.pnl_percent))}`,
    '',
    `Active lessons: <b>${lessonCount}</b>`,
  ];
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

export async function sendPnl(chatId, query = null) {
  const closed = db.prepare("SELECT pnl_percent, pnl_sol, snapshot_json FROM dry_run_positions WHERE status = 'closed'").all();
  if (!closed.length) {
    const text = '📊 <b>PnL</b>\n\nNo closed positions yet.';
    return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }

  const totalPnlSol = closed.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);
  const pnlWins = closed.filter(p => (p.exit_class || (Number(p.pnl_percent || 0) > 0 ? 'win' : 'loss')) === 'win');
  const pnlNeutrals = closed.filter(p => p.exit_class === 'neutral');
  const pnlLosses = closed.filter(p => (p.exit_class || (Number(p.pnl_percent || 0) > 0 ? 'win' : 'loss')) === 'loss');
  const netScore = pnlWins.length - pnlLosses.length;
  const netIcon = netScore > 0 ? '✅' : netScore < 0 ? '⚠️' : '➡️';
  const total = closed.length;
  const pct = n => `${Math.round(n / total * 100)}%`;

  const byRoute = new Map();
  for (const pos of closed) {
    let snap = {};
    try { snap = JSON.parse(pos.snapshot_json || '{}'); } catch { /* */ }
    const route = snap.candidate?.signals?.route || snap.candidate?.signals?.label || 'unknown';
    const exitClass = pos.exit_class || (Number(pos.pnl_percent || 0) > 0 ? 'win' : 'loss');
    const row = byRoute.get(route) || { route, count: 0, wins: 0, neutrals: 0, pnlSum: 0 };
    row.count += 1;
    row.wins += exitClass === 'win' ? 1 : 0;
    row.neutrals += exitClass === 'neutral' ? 1 : 0;
    row.pnlSum += Number(pos.pnl_percent || 0);
    byRoute.set(route, row);
  }
  const routeLines = [...byRoute.values()]
    .sort((a, b) => b.pnlSum - a.pnlSum)
    .map(r => `• ${escapeHtml(r.route)}: ${r.wins}W/${r.neutrals}N/${r.count - r.wins - r.neutrals}L · avg ${fmtPct(r.pnlSum / r.count)}`);

  const lines = [
    '📊 <b>PnL</b>',
    '',
    `Total SOL: <b>${fmtSol(totalPnlSol)} SOL</b>`,
    `Trades: <b>${total}</b>`,
    `✅ Wins: <b>${pnlWins.length}</b> (${pct(pnlWins.length)}) · ⚖️ Neutral: <b>${pnlNeutrals.length}</b> (${pct(pnlNeutrals.length)}) · ❌ Losses: <b>${pnlLosses.length}</b> (${pct(pnlLosses.length)})`,
    `Net score: <b>${netScore > 0 ? '+' : ''}${netScore}</b> ${netIcon}`,
    '',
    '<b>By route:</b>',
    ...routeLines,
  ];
  const text = lines.join('\n');
  return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

