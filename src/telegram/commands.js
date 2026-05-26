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
import { sendTelegram, sendBatch, sendPositionOpen, safeSend } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { getBlacklist } from '../db/blacklist.js';
import { sendDailyReport } from './report.js';
import { runLearning, sendLessons } from '../learning/commands.js';
import { autoStatusText } from '../learning/autotuner.js';
import { addSmartWallet, removeSmartWallet, getSmartWallets, smartWalletStats } from '../feeds/smartmoney.js';

// Returns the pivot timestamp in ms (from PIVOT_DATE env var), or null if not set.
// PIVOT_DATE can be an ISO string ("2026-05-20T14:30:00Z") or a Unix ms number.
function pivotMs() {
  const raw = process.env.PIVOT_DATE;
  if (!raw) return null;
  const n = Number(raw);
  if (!isNaN(n) && n > 0) return n;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return safeSend(chatId, filtersText());
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return safeSend(chatId, strategyMenuText(), strategyKeyboard());
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen'];
    if (!valid.includes(id)) {
      return safeSend(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return safeSend(chatId, strategyMenuText(), strategyKeyboard());
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\n\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct');
    }
    const strat = strategyById(id);
    if (!strat) return safeSend(chatId, `Strategy "${id}" not found.`);
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
    return safeSend(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`);
  }
  if (text.startsWith('/blacklist')) return sendBlacklistReport(chatId);
  if (text.startsWith('/report')) {
    await safeSend(chatId, 'Generating report...');
    try {
      await sendDailyReport();
    } catch (err) {
      console.error('[report] crash:', err);
      await sendTelegram('⚠️ Report failed: ' + escapeHtml(err.message)).catch(() => {});
    }
    return;
  }
  if (text.startsWith('/summary')) return sendSummary(chatId);
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/autostatus')) return safeSend(chatId, autoStatusText());
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return safeSend(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return safeSend(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    addSmartWallet(label, address);
    return safeSend(chatId, `Added ${label} to smart money tracking`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return safeSend(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    removeSmartWallet(label);
    return safeSend(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/resetstats')) {
    const isSelective = text.includes('selective');
    const isConfirm = text.includes('confirm');

    if (isSelective && !isConfirm) {
      // Selective reset warning
      const posBefore = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions").get().c;
      const tradesBefore = db.prepare("SELECT COUNT(*) AS c FROM dry_run_trades").get().c;
      const lessonsBefore = db.prepare("SELECT COUNT(*) AS c FROM learning_lessons").get().c;
      const blCount = db.prepare("SELECT COUNT(*) AS c FROM blacklist").get().c;
      const swCount = db.prepare("SELECT COUNT(*) AS c FROM smart_wallets WHERE active = 1").get().c;
      return safeSend(chatId,
        'SELECTIVE RESET — will wipe trade history, keep smart memory\n\n' +
        'Will WIPE:\n' +
        `  Positions: ${posBefore} | Trades: ${tradesBefore}\n` +
        '  Capital snapshots\n' +
        '  Route weights (reset to 1.0x)\n\n' +
        'Will KEEP:\n' +
        `  Lessons: ${lessonsBefore} | Blacklist: ${blCount}\n` +
        `  Smart wallets: ${swCount} | Strategies\n\n` +
        'Send /resetstats selective confirm to proceed.'
      );
    }

    if (isSelective && isConfirm) {
      console.log('[resetstats] selective confirm received');
      // Selective reset — wipe trades, keep learning
      const tradesBefore = db.prepare("SELECT COUNT(*) AS c FROM dry_run_trades").get().c;
      const lessonsBefore = db.prepare("SELECT COUNT(*) AS c FROM learning_lessons WHERE status = 'active'").get().c;
      const blCount = db.prepare("SELECT COUNT(*) AS c FROM blacklist").get().c;
      const swCount = db.prepare("SELECT COUNT(*) AS c FROM smart_wallets WHERE active = 1").get().c;

      db.prepare('DELETE FROM dry_run_positions').run();
      db.prepare('DELETE FROM dry_run_trades').run();
      db.prepare('DELETE FROM capital_snapshots').run();
      db.prepare(`
        UPDATE route_weights SET weight = 1.0, win_count = 0, loss_count = 0,
          avg_pnl_pct = 0, updated_at_ms = ?
      `).run(Date.now());
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('starting_capital_sol', '1.0')").run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_auto_learn_count', '0')").run();

      return safeSend(chatId,
        'SELECTIVE RESET DONE\n\n' +
        `Wiped: Trades: ${tradesBefore} | Capital: reset | Route weights: reset\n` +
        `Kept: Lessons: ${lessonsBefore} active | Blacklist: ${blCount} | Smart wallets: ${swCount}\n\n` +
        'Clean history, smart memory! Learning fires at 25 closes.'
      );
    }

    if (!isConfirm) {
      // Full reset warning
      return safeSend(chatId,
        'WARNING: This will delete all trading history.\n\n' +
        'Will clear:\n' +
        '  All positions, trades, lessons, decisions\n' +
        '  Signal events, capital snapshots\n' +
        '  Route weights (reset to 1.0x)\n\n' +
        'Will keep:\n' +
        '  Blacklist, whitelist, smart wallets\n' +
        '  Strategy config, TP/SL rules\n\n' +
        'Send /resetstats confirm to proceed.\n' +
        'Or send /resetstats selective to keep smart memory.'
      );
    }

    // Full reset
    const posBefore = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions").get().c;
    const lessonsBefore = db.prepare("SELECT COUNT(*) AS c FROM learning_lessons").get().c;
    const blCount = db.prepare("SELECT COUNT(*) AS c FROM blacklist").get().c;
    const swCount = db.prepare("SELECT COUNT(*) AS c FROM smart_wallets WHERE active = 1").get().c;

    db.prepare('DELETE FROM dry_run_positions').run();
    db.prepare('DELETE FROM dry_run_trades').run();
    db.prepare('DELETE FROM capital_snapshots').run();
    db.prepare('DELETE FROM learning_runs').run();
    db.prepare('DELETE FROM learning_lessons').run();
    db.prepare('DELETE FROM llm_decisions').run();
    db.prepare('DELETE FROM llm_batches').run();
    db.prepare('DELETE FROM decision_logs').run();
    db.prepare('DELETE FROM signal_events').run();
    db.prepare('DELETE FROM candidates').run();
    db.prepare('DELETE FROM trade_intents').run();

    db.prepare(`
      UPDATE route_weights SET weight = 1.0, win_count = 0, loss_count = 0,
        avg_pnl_pct = 0, updated_at_ms = ?
    `).run(Date.now());

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('starting_capital_sol', '1.0')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_auto_learn_count', '0')").run();

    return safeSend(chatId,
      'STATS RESET COMPLETE\n\n' +
      'Cleared:\n' +
      `  Positions: ${posBefore} deleted\n` +
      `  Lessons: ${lessonsBefore} deleted\n` +
      '  Route weights: reset to 1.0x\n' +
      '  Capital: reset to 1.0 SOL\n\n' +
      'Kept:\n' +
      `  Blacklist: ${blCount} entries\n` +
      `  Smart wallets: ${swCount} wallets\n` +
      '  Strategy config: unchanged\n\n' +
      'Fresh start! Learning activates at 25 closed positions.'
    );
  }
  if (text.startsWith('/dbexport')) {
    const rows = db.prepare(`
      SELECT
        symbol, pnl_percent, exit_reason,
        signal_route, execution_mode,
        opened_at_ms, closed_at_ms
      FROM dry_run_positions
      WHERE status != 'open'
      ORDER BY opened_at_ms DESC
      LIMIT 200
    `).all();

    if (!rows.length) return safeSend(chatId, 'No closed positions found.');

    const avg = arr => arr.length
      ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)
      : 'N/A';

    const modes = {};
    for (const r of rows) {
      const m = r.execution_mode || 'unknown';
      if (!modes[m]) modes[m] = { total: 0, wins: 0, pnl: [] };
      modes[m].total++;
      if (r.pnl_percent > 0) modes[m].wins++;
      modes[m].pnl.push(r.pnl_percent);
    }

    const exits = {};
    for (const r of rows) {
      const e = r.exit_reason || 'unknown';
      if (!exits[e]) exits[e] = { count: 0, pnl: [] };
      exits[e].count++;
      exits[e].pnl.push(r.pnl_percent);
    }

    const routes = {};
    for (const r of rows) {
      const rt = r.signal_route || 'unknown';
      if (!routes[rt]) routes[rt] = { total: 0, wins: 0, pnl: [] };
      routes[rt].total++;
      if (r.pnl_percent > 0) routes[rt].wins++;
      routes[rt].pnl.push(r.pnl_percent);
    }

    const worst = [...rows]
      .sort((a, b) => a.pnl_percent - b.pnl_percent)
      .slice(0, 5);

    let msg = 'TRADE ANALYSIS\n\n';

    msg += 'BY MODE:\n';
    for (const [m, d] of Object.entries(modes)) {
      const wr = ((d.wins / d.total) * 100).toFixed(0);
      msg += `${m}: ${d.total} trades | ${wr}% WR | avg ${avg(d.pnl)}%\n`;
    }

    msg += '\nBY EXIT:\n';
    for (const [e, d] of Object.entries(exits)) {
      msg += `${e}: ${d.count}x | avg ${avg(d.pnl)}%\n`;
    }

    const trailData = exits['TRAIL_STOP'];
    if (trailData) {
      const stratRow = db.prepare("SELECT config_json FROM strategies WHERE id='degen'").get();
      const fixedTpPct = stratRow ? (JSON.parse(stratRow.config_json || '{}').take_profit_pct ?? 25) : 25;
      const avgTrailPnl = Number(avg(trailData.pnl));
      const bonus = (avgTrailPnl - fixedTpPct).toFixed(1);
      msg += `\nTRAIL BONUS vs TP (+${fixedTpPct}%): ${bonus > 0 ? '+' : ''}${bonus}% avg extra captured\n`;
    }

    // Cost simulation analysis
    const costRows2 = db.prepare(`
      SELECT exit_reason, entry_slippage_pct, exit_slippage_pct, gas_cost_sol, exit_gas_sol, gross_pnl_pct, net_pnl_pct
      FROM dry_run_positions WHERE status != 'open' AND gross_pnl_pct != 0
    `).all();
    if (costRows2.length > 0) {
      const avgES = costRows2.reduce((s, r) => s + Number(r.entry_slippage_pct || 0), 0) / costRows2.length;
      const avgXS = costRows2.reduce((s, r) => s + Number(r.exit_slippage_pct || 0), 0) / costRows2.length;
      const totalG = costRows2.reduce((s, r) => s + Number(r.gas_cost_sol || 0) + Number(r.exit_gas_sol || 0), 0);
      const avgGross = costRows2.reduce((s, r) => s + Number(r.gross_pnl_pct || 0), 0) / costRows2.length;
      const avgNet   = costRows2.reduce((s, r) => s + Number(r.net_pnl_pct || 0), 0) / costRows2.length;
      const drag = avgES + avgXS + (totalG / costRows2.length / 0.03 * 100);
      msg += '\nCOST ANALYSIS:\n';
      msg += `Avg entry slip: ${avgES.toFixed(2)}% | Avg exit slip: ${avgXS.toFixed(2)}%\n`;
      msg += `Total gas: ${totalG.toFixed(4)} SOL | Avg drag: ~${drag.toFixed(2)}% per trade\n`;
      msg += `GROSS avg: ${avg(costRows2.map(r => r.gross_pnl_pct))}% → NET avg: ${avg(costRows2.map(r => r.net_pnl_pct))}%\n`;
      // Per exit type slip
      const slipByExit = {};
      for (const r of costRows2) {
        const k = r.exit_reason || 'unknown';
        if (!slipByExit[k]) slipByExit[k] = [];
        slipByExit[k].push(Number(r.exit_slippage_pct || 0));
      }
      msg += '\nSlippage by exit:\n';
      for (const [k, vals] of Object.entries(slipByExit)) {
        msg += `${k}: ${avg(vals)}% avg exit slip\n`;
      }
    }

    msg += '\nBY ROUTE:\n';
    for (const [rt, d] of Object.entries(routes)) {
      const wr = ((d.wins / d.total) * 100).toFixed(0);
      msg += `${rt}: ${d.total} trades | ${wr}% WR | avg ${avg(d.pnl)}%\n`;
    }

    msg += '\nWORST 5:\n';
    for (const r of worst) {
      msg += `${r.symbol || '?'}: ${r.pnl_percent?.toFixed(1)}% (${r.exit_reason || '?'})\n`;
    }

    msg += `\nTotal closed: ${rows.length}`;
    return safeSend(chatId, msg);
  }
  if (text.startsWith('/backtest')) {
    await safeSend(chatId, 'Starting backtest... This may take 2-5 minutes.');
    try {
      const { runBacktest, formatBacktestReport } = await import('../backtest/engine.js');
      const results = await runBacktest({
        onProgress: async (msg) => {
          await safeSend(chatId, msg);
        },
      });
      const report = formatBacktestReport(results);
      await safeSend(chatId, report);
    } catch (err) {
      console.error('[backtest] error:', err);
      await safeSend(chatId, `Backtest failed: ${err.message}`);
    }
    return;
  }
  if (text.startsWith('/drystat')) {
    const isAccel = process.env.ACCELERATED_DRY_RUN === 'true';
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const pivot = pivotMs();

    const statsAll = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN exit_class = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN exit_class = 'neutral' THEN 1 ELSE 0 END) AS neutrals,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl,
        COALESCE(SUM(pnl_sol), 0) AS total_pnl_sol
      FROM dry_run_positions WHERE status = 'closed' AND source != 'backtest'
    `).get();

    const stats24h = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl
      FROM dry_run_positions WHERE status = 'closed' AND closed_at_ms > ? AND source != 'backtest'
    `).get(dayAgo);

    const statsWeek = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins
      FROM dry_run_positions WHERE status = 'closed' AND closed_at_ms > ? AND source != 'backtest'
    `).get(weekAgo);

    const statsPivot = pivot ? db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN exit_class = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN exit_class = 'neutral' THEN 1 ELSE 0 END) AS neutrals,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl,
        COALESCE(SUM(pnl_sol), 0) AS total_pnl_sol
      FROM dry_run_positions WHERE status = 'closed' AND source != 'backtest' AND closed_at_ms > ?
    `).get(pivot) : null;

    const totalTrades = statsAll?.total || 0;
    const winRate = totalTrades > 0 ? Math.round((statsAll.wins / totalTrades) * 100) : null;
    const dailyTrades = stats24h?.total || 0;
    const daysTo50 = dailyTrades > 0 ? Math.ceil((50 - totalTrades) / dailyTrades) : null;
    const wr24h = stats24h?.total > 0 ? Math.round((stats24h.wins / stats24h.total) * 100) : null;
    const wrWeek = statsWeek?.total > 0 ? Math.round((statsWeek.wins / statsWeek.total) * 100) : null;

    const routeBreakdown = db.prepare(`
      SELECT signal_route, COUNT(*) AS c,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS w,
        ROUND(AVG(pnl_percent), 1) AS avg_pnl
      FROM dry_run_positions
      WHERE status = 'closed' AND source != 'backtest' AND signal_route IS NOT NULL
      GROUP BY signal_route ORDER BY c DESC LIMIT 5
    `).all();

    const routeLines = routeBreakdown.map(r => {
      const wr = r.c > 0 ? Math.round(r.w / r.c * 100) : 0;
      return `▸ ${escapeHtml(r.signal_route)}: ${r.c} trades | ${wr}% win | ${r.avg_pnl > 0 ? '+' : ''}${r.avg_pnl}% avg`;
    });

    const pFmt = (n) => n != null ? (n > 0 ? '+' : '') + n + '%' : '—';
    const solFmt = (n) => (Number(n) >= 0 ? '+' : '') + Number(n || 0).toFixed(4);

    const pivotSection = statsPivot ? [
      '',
      `🔄 <b>SINCE PIVOT</b> (post mid-cap, ${new Date(pivot).toISOString().slice(0, 10)})`,
      `▸ Trades: <b>${statsPivot.total || 0}</b>`,
      `▸ Win rate: <b>${statsPivot.total > 0 ? Math.round(statsPivot.wins / statsPivot.total * 100) + '%' : '—'}</b> (target: 48%)`,
      `▸ W/L/N: <b>${statsPivot.wins || 0}</b>/${statsPivot.losses || 0}/${statsPivot.neutrals || 0}`,
      `▸ Avg PnL: <b>${pFmt(statsPivot.avg_pnl)}</b>`,
      `▸ Total PnL: <b>${solFmt(statsPivot.total_pnl_sol)} SOL</b>`,
    ] : [];

    const lines = [
      '📊 <b>DRY-RUN STATS</b>',
      `🚀 Mode: <b>${isAccel ? 'ACCELERATED' : 'Normal'}</b>`,
      '━━━━━━━━━━━━━━━━',
      '',
      '📈 <b>ALL-TIME</b>',
      `▸ Trades: <b>${totalTrades}</b>`,
      `▸ Win rate: <b>${winRate != null ? winRate + '%' : '—'}</b> (target: 48%)`,
      `▸ W/L/N: <b>${statsAll?.wins || 0}</b>/${statsAll?.losses || 0}/${statsAll?.neutrals || 0}`,
      `▸ Avg PnL: <b>${pFmt(statsAll?.avg_pnl)}</b>`,
      `▸ Total PnL: <b>${solFmt(statsAll?.total_pnl_sol)} SOL</b>`,
      ...pivotSection,
      '',
      '🕐 <b>LAST 24H</b>',
      `▸ Trades: <b>${stats24h?.total || 0}</b>`,
      `▸ Win rate: <b>${wr24h != null ? wr24h + '%' : '—'}</b>`,
      `▸ Avg PnL: <b>${pFmt(stats24h?.avg_pnl)}</b>`,
      '',
      '📅 <b>LAST 7 DAYS</b>',
      `▸ Trades: <b>${statsWeek?.total || 0}</b>`,
      `▸ Win rate: <b>${wrWeek != null ? wrWeek + '%' : '—'}</b>`,
      '',
      routeBreakdown.length > 0 ? '🛣️ <b>BY SIGNAL ROUTE</b>' : '',
      ...routeLines,
      '',
      daysTo50 != null && totalTrades < 50
        ? `⏰ Est. days to 50 trades: <b>~${daysTo50}d</b> (${dailyTrades}/day)`
        : totalTrades >= 50 ? '✅ 50-trade threshold reached' : '⏰ Not enough daily data yet',
    ].filter(l => l !== '').join('\n');

    return safeSend(chatId, lines);
  }
  if (text.startsWith('/filterstat')) {
    const { getFilterStats } = await import('../filters/candidateFilter.js');
    const stats = getFilterStats();

    const top = (reasons, n = 3) =>
      Object.entries(reasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([r, c]) => `  · ${escapeHtml(r)}: ${c}`)
        .join('\n') || '  (none)';

    const total = stats.total || 0;
    const lines = [
      '🔍 <b>FILTER STATS</b>',
      `Total evaluated: <b>${total}</b>`,
      '',
      '🟡 <b>Layer 1</b> (liquidity/age/auth/mcap)',
      `▸ Passed: <b>${stats.layer1Pass}</b> | Failed: <b>${stats.layer1Fail}</b>`,
      top(stats.layer1Reasons),
      '',
      '🟠 <b>Layer 2</b> (momentum/holders/vol)',
      `▸ Passed: <b>${stats.layer2Pass}</b> | Failed: <b>${stats.layer2Fail}</b>`,
      top(stats.layer2Reasons),
      '',
      '🔴 <b>Layer 3</b> (Jupiter routing)',
      `▸ Passed: <b>${stats.layer3Pass}</b> | Failed: <b>${stats.layer3Fail}</b>`,
      top(stats.layer3Reasons),
      '',
      `✅ Final pass rate: <b>${total > 0 ? Math.round(stats.layer3Pass / total * 100) : 0}%</b>`,
      '<i>Stats reset on bot restart</i>',
    ].join('\n');

    return safeSend(chatId, lines);
  }
  if (text.startsWith('/golivewhen')) {
    const REQUIRED_WIN_RATE = 48;
    const REQUIRED_TRADES = 50;

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl,
        COALESCE(SUM(pnl_sol), 0) AS total_pnl
      FROM dry_run_positions WHERE status = 'closed' AND source != 'backtest'
    `).get();

    const recentStats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins
      FROM (SELECT exit_class FROM dry_run_positions
        WHERE status = 'closed' AND source != 'backtest'
        ORDER BY closed_at_ms DESC LIMIT 20)
    `).get();

    const weeklyRate = db.prepare(`
      SELECT COUNT(*) AS total
      FROM dry_run_positions
      WHERE status = 'closed' AND source != 'backtest'
        AND closed_at_ms > ?
    `).get(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const total = stats?.total || 0;
    const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : null;
    const recent20Wr = recentStats?.total >= 20
      ? Math.round((recentStats.wins / recentStats.total) * 100) : null;
    const tradesNeeded = Math.max(0, REQUIRED_TRADES - total);
    const weeklyTrades = weeklyRate?.total || 0;
    const daysToTarget = weeklyTrades > 0 ? Math.ceil(tradesNeeded / (weeklyTrades / 7)) : null;

    const winRateOk = winRate !== null && winRate >= REQUIRED_WIN_RATE;
    const tradesOk = total >= REQUIRED_TRADES;
    const recentOk = recent20Wr !== null && recent20Wr >= REQUIRED_WIN_RATE;

    const status = winRateOk && tradesOk && recentOk
      ? '✅ <b>READY TO GO LIVE</b>'
      : '⏳ <b>NOT READY YET</b>';

    const lines = [
      '🎯 <b>GO LIVE CHECKLIST</b>',
      status,
      '━━━━━━━━━━━━━━━━',
      '',
      `${tradesOk ? '✅' : '❌'} Trades: <b>${total}/${REQUIRED_TRADES}</b>${tradesNeeded > 0 ? ` (need ${tradesNeeded} more)` : ''}`,
      `${winRateOk ? '✅' : '❌'} Win rate: <b>${winRate != null ? winRate + '%' : '—'}/${REQUIRED_WIN_RATE}%</b>`,
      `${recentOk ? '✅' : '❌'} Recent 20: <b>${recent20Wr != null ? recent20Wr + '%' : '—'}/${REQUIRED_WIN_RATE}%</b>`,
      '',
      '📊 <b>TREND</b>',
      `▸ Avg PnL: <b>${stats?.avg_pnl != null ? (stats.avg_pnl > 0 ? '+' : '') + stats.avg_pnl + '%' : '—'}</b>`,
      `▸ Total PnL: <b>${Number(stats?.total_pnl || 0) >= 0 ? '+' : ''}${Number(stats?.total_pnl || 0).toFixed(4)} SOL</b>`,
      `▸ Weekly trade rate: <b>${weeklyTrades} trades/week</b>`,
      daysToTarget != null && tradesNeeded > 0
        ? `▸ Est. time to 50 trades: <b>~${daysToTarget} days</b>`
        : tradesNeeded === 0 ? '▸ Trade count achieved ✅' : '▸ Not enough data for estimate',
      '',
      winRateOk && tradesOk && recentOk
        ? '🚀 All criteria met — consider going live!'
        : '💡 Keep accumulating dry-run trades. Use /drystat for details.',
    ].join('\n');

    return safeSend(chatId, lines);
  }
  if (text.startsWith('/clearpositions')) {
    const { closeStuckPositions } = await import('../db/positions.js');
    const cleared = await closeStuckPositions(0); // 0ms = close ALL open dry_run positions
    return safeSend(chatId, `Cleared ${cleared} stuck position(s). Slots are now free.`);
  }
  if (text.startsWith('/walletlist')) return sendSmartWalletList(chatId);
  if (text.startsWith('/walletstats')) return sendSmartWalletStats(chatId);
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
      return safeSend(chatId, `Usage: /setfilter <name> <value>\n\n${filtersText()}`);
    }
    setSetting(key, value === 'off' ? '0' : value);
    return safeSend(chatId, filtersText());
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return safeSend(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await safeSend(chatId, candidateSummary(row.candidate, decision), {
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  await safeSend(chatId, `POSITIONS\n\n${text}`, { disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return safeSend(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await safeSend(chatId, formatPosition(row), { disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return safeSend(chatId, 'Open position not found.');
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
  await safeSend(chatId, `${label} #${id}: ${reason} ${fmtPct(pnlPercent)}`);
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return safeSend(chatId, 'Invalid value.');
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
  if (!row) return safeSend(chatId, 'Position not found.');
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

export async function sendSmartWalletList(chatId) {
  const wallets = getSmartWallets();
  const lines = ['👛 <b>SMART MONEY WALLETS</b>', ''];
  if (wallets.length === 0) {
    lines.push('No wallets yet. Use /walletadd &lt;label&gt; &lt;address&gt;');
  } else {
    for (const w of wallets) {
      const status = w.active ? '✅' : '⏸';
      const addr = w.address ? `<code>${w.address.slice(0, 8)}…</code>` : '<i>no address</i>';
      lines.push(`▸ ${escapeHtml(w.label)}: ${addr} ${status}`);
    }
  }
  return safeSend(chatId, lines.join('\n'));
}

export async function sendSmartWalletStats(chatId) {
  const stats = smartWalletStats();
  const lines = ['📊 <b>SMART MONEY PERFORMANCE</b>', ''];
  if (stats.length === 0) {
    lines.push('No wallets tracked yet.');
  } else {
    for (const w of stats) {
      const decisive = w.wins + w.losses;
      const wr = decisive > 0 ? Math.round((w.wins / decisive) * 100) : 0;
      lines.push(`▸ ${escapeHtml(w.label)}: ${w.signals} signals, ${wr}% win (${w.wins}W/${w.losses}L)`);
    }
  }
  return safeSend(chatId, lines.join('\n'));
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'report', description: 'Generate daily performance report' },
    { command: 'blacklist', description: 'Show blacklisted tokens and banned deployers' },
    { command: 'summary', description: 'Trading summary: win rate, PnL, best/worst trades' },
    { command: 'pnl', description: 'PnL breakdown by route and totals' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'autostatus', description: 'Auto-tuner status: route weights, tune timestamps, win rate trend' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Add smart money wallet to track' },
    { command: 'walletlist', description: 'List smart money wallets' },
    { command: 'walletstats', description: 'Smart money wallet performance stats' },
    { command: 'walletremove', description: 'Remove wallet from tracking' },
    { command: 'wallets', description: 'List saved wallets (exposure view)' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await safeSend(chatId, mainMenuText(), {
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
  return safeSend(chatId, lines.join('\n'));
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
  return safeSend(chatId, lines.join('\n'));
}

export async function sendPnl(chatId, query = null) {
  const pivot = pivotMs();
  const startingSol = numSetting('starting_capital_sol', 1.0);
  const closed = db.prepare("SELECT pnl_percent, pnl_sol, exit_class, snapshot_json, closed_at_ms FROM dry_run_positions WHERE status = 'closed'").all();
  if (!closed.length) {
    const text = `PNL\n\nNo closed positions yet.\nStarting balance: ${fmtSol(startingSol)} SOL`;
    return query ? editMenuMessage(query, text, navKeyboard()) : safeSend(chatId, text);
  }

  function calcStats(positions) {
    const wins     = positions.filter(p => (p.exit_class || (Number(p.pnl_percent || 0) > 0 ? 'win' : 'loss')) === 'win');
    const neutrals = positions.filter(p => p.exit_class === 'neutral');
    const losses   = positions.filter(p => (p.exit_class || (Number(p.pnl_percent || 0) > 0 ? 'win' : 'loss')) === 'loss');
    const total    = positions.length;
    const totalSol = positions.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);
    const avgPnl   = total > 0 ? positions.reduce((s, p) => s + Number(p.pnl_percent || 0), 0) / total : null;
    const winRate  = total > 0 ? Math.round(wins.length / total * 100) : null;
    const net      = wins.length - losses.length;
    return { wins, neutrals, losses, total, totalSol, avgPnl, winRate, net };
  }

  const allStats   = calcStats(closed);
  const pivotStats = pivot ? calcStats(closed.filter(p => Number(p.closed_at_ms || 0) > pivot)) : null;

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

  const { wins, neutrals, losses, total, totalSol, avgPnl, winRate, net } = allStats;
  const netIcon = net > 0 ? '✅' : net < 0 ? '⚠️' : '➡️';
  const pct = n => `${Math.round(n / total * 100)}%`;
  const currentBalance = startingSol + totalSol;

  const pivotSection = pivotStats ? [
    '',
    `🔄 <b>SINCE PIVOT</b> (post mid-cap, ${new Date(pivot).toISOString().slice(0, 10)})`,
    `Trades: <b>${pivotStats.total}</b> | Win rate: <b>${pivotStats.winRate != null ? pivotStats.winRate + '%' : '—'}</b> | Avg PnL: <b>${pivotStats.avgPnl != null ? (pivotStats.avgPnl > 0 ? '+' : '') + pivotStats.avgPnl.toFixed(1) + '%' : '—'}</b>`,
    `✅ <b>${pivotStats.wins.length}</b> · ⚖️ <b>${pivotStats.neutrals.length}</b> · ❌ <b>${pivotStats.losses.length}</b> · Net: <b>${pivotStats.net > 0 ? '+' : ''}${pivotStats.net}</b>`,
    `PnL SOL: <b>${pivotStats.totalSol >= 0 ? '+' : ''}${fmtSol(pivotStats.totalSol)} SOL</b>`,
  ] : [];

  // Cost simulation breakdown (only shown when data exists)
  const costRows = db.prepare(`
    SELECT entry_slippage_pct, exit_slippage_pct, gas_cost_sol, exit_gas_sol, gross_pnl_pct, net_pnl_pct
    FROM dry_run_positions WHERE status = 'closed' AND gross_pnl_pct != 0
  `).all();
  const hasCostData = costRows.length > 0;
  const avgEntrySlip = hasCostData ? costRows.reduce((s, r) => s + Number(r.entry_slippage_pct || 0), 0) / costRows.length : 0;
  const avgExitSlip  = hasCostData ? costRows.reduce((s, r) => s + Number(r.exit_slippage_pct || 0), 0) / costRows.length : 0;
  const totalGasSol  = hasCostData ? costRows.reduce((s, r) => s + Number(r.gas_cost_sol || 0) + Number(r.exit_gas_sol || 0), 0) : 0;
  const avgGrossPnl  = hasCostData ? costRows.reduce((s, r) => s + Number(r.gross_pnl_pct || 0), 0) / costRows.length : null;
  const avgNetPnl    = hasCostData ? costRows.reduce((s, r) => s + Number(r.net_pnl_pct || 0), 0) / costRows.length : null;
  const costSection = hasCostData ? [
    '',
    '<b>COSTS (sim)</b>',
    `Avg entry slip: <b>${avgEntrySlip.toFixed(2)}%</b> | Avg exit slip: <b>${avgExitSlip.toFixed(2)}%</b>`,
    `Total gas paid: <b>${totalGasSol.toFixed(4)} SOL</b>`,
    `Gross avg PnL: <b>${avgGrossPnl !== null ? fmtPct(avgGrossPnl) : '—'}</b> → NET: <b>${avgNetPnl !== null ? fmtPct(avgNetPnl) : '—'}</b>`,
  ] : [];

  const lines = [
    '📊 <b>PnL</b>',
    '',
    `💰 Starting: <b>${fmtSol(startingSol)} SOL</b> → Current: <b>${fmtSol(currentBalance)} SOL</b> (${totalSol >= 0 ? '+' : ''}${fmtSol(totalSol)} SOL)`,
    '',
    '<b>ALL TIME</b>',
    `Trades: <b>${total}</b> | Win rate: <b>${winRate != null ? winRate + '%' : '—'}</b> | Avg PnL: <b>${avgPnl != null ? (avgPnl > 0 ? '+' : '') + avgPnl.toFixed(1) + '%' : '—'}</b>`,
    `✅ Wins: <b>${wins.length}</b> (${pct(wins.length)}) · ⚖️ Neutral: <b>${neutrals.length}</b> (${pct(neutrals.length)}) · ❌ Losses: <b>${losses.length}</b> (${pct(losses.length)})`,
    `Net score: <b>${net > 0 ? '+' : ''}${net}</b> ${netIcon}`,
    ...pivotSection,
    ...costSection,
    '',
    '<b>By route:</b>',
    ...routeLines,
  ];
  const text = lines.join('\n');
  return query ? editMenuMessage(query, text, navKeyboard()) : safeSend(chatId, text);
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

