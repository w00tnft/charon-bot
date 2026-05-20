import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { fetchDexScreenerTrending, fetchSolanaTrackerGraduated, fetchTokenData } from '../data/tokenData.js';
import { runCandidateFilter } from '../filters/candidateFilter.js';
import { sendTelegram } from '../telegram/send.js';
import { escapeHtml } from '../format.js';

const BACKTEST_LOOKBACK_HOURS = Number(process.env.BACKTEST_LOOKBACK_HOURS || 72);
const MAX_CANDIDATES          = Number(process.env.BACKTEST_MAX_CANDIDATES || 300);

// Simulate TP/SL outcome from entry price + price movement data
// Uses current price and h1 price change to reconstruct entry
function simulateOutcome(tokenData, strategy) {
  const tp  = strategy.tp_percent  || 25;
  const sl  = strategy.sl_percent  || -15;
  const nuke = strategy.emergency_stop_pct || -40;
  const maxHoldMs = strategy.max_hold_ms || 14_400_000;

  const currentPrice   = tokenData.dex?.priceUsd || 0;
  const priceChange1h  = tokenData.dex?.priceChange1h || 0;

  if (!currentPrice) return null;

  // Reconstruct estimated entry price 1h ago
  const estimatedEntryPrice = priceChange1h !== 0
    ? currentPrice / (1 + priceChange1h / 100)
    : currentPrice;

  if (!estimatedEntryPrice) return null;

  // Simulate PnL from entry using 1h and 6h price changes as checkpoints
  const change6h  = tokenData.dex?.priceChange6h || 0;
  const change24h = tokenData.dex?.priceChange24h || 0;

  // Check price checkpoints in order
  const checkpoints = [priceChange1h, change6h, change24h];
  let outcome = 'time';
  let pnlPercent = change24h; // default to 24h if no TP/SL hit

  for (const chg of checkpoints) {
    if (chg >= tp) { outcome = 'TP'; pnlPercent = tp; break; }
    if (chg <= nuke) { outcome = 'NUCLEAR'; pnlPercent = nuke; break; }
    if (chg <= sl) { outcome = 'SL'; pnlPercent = sl; break; }
  }

  const exitClass = pnlPercent > 0 ? 'win' : pnlPercent < -5 ? 'loss' : 'neutral';
  const sizeSol   = strategy.position_size_sol || 0.03;
  const pnlSol    = sizeSol * pnlPercent / 100;

  return {
    entryPrice: estimatedEntryPrice,
    exitPrice: estimatedEntryPrice * (1 + pnlPercent / 100),
    pnlPercent: Math.round(pnlPercent * 10) / 10,
    pnlSol: Math.round(pnlSol * 10000) / 10000,
    exitReason: outcome,
    exitClass,
    holdMs: outcome === 'time' ? maxHoldMs : Math.round(Math.random() * maxHoldMs * 0.75),
  };
}

// Store simulated position in positions table
function storeBacktestPosition(mint, tokenData, outcome, strategy) {
  try {
    const sym = tokenData.dex?.symbol || mint.slice(0, 8);
    const name = tokenData.dex?.name || sym;
    const entryMs = now() - outcome.holdMs - Math.round(Math.random() * 3_600_000);
    const closedMs = entryMs + outcome.holdMs;

    db.prepare(`
      INSERT OR IGNORE INTO dry_run_positions (
        mint, symbol, status, opened_at_ms, closed_at_ms, size_sol,
        entry_price, entry_mcap, exit_price, exit_mcap,
        exit_reason, exit_class, pnl_percent, pnl_sol,
        signal_route, source, execution_mode, candidate_id
      ) VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backtest', 'backtest', 'dry_run', NULL)
    `).run(
      mint, sym, entryMs, closedMs,
      strategy.position_size_sol || 0.03,
      outcome.entryPrice, tokenData.marketCapUsd || 0,
      outcome.exitPrice, tokenData.marketCapUsd ? tokenData.marketCapUsd * (1 + outcome.pnlPercent / 100) : 0,
      outcome.exitReason, outcome.exitClass,
      outcome.pnlPercent, outcome.pnlSol,
    );
  } catch (err) {
    console.log(`[backtest] DB insert error for ${mint.slice(0, 8)}: ${err.message}`);
  }
}

// ── Main backtest runner ─────────────────────────────────────────────────────
export async function runBacktest({ onProgress = null } = {}) {
  const startMs = Date.now();
  console.log('[backtest] Starting backtest engine...');

  // 1. Load active strategy
  const degenRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'degen'").get();
  const strategy = degenRow ? JSON.parse(degenRow.config_json) : {
    tp_percent: 25, sl_percent: -15, emergency_stop_pct: -40,
    max_hold_ms: 14_400_000, position_size_sol: 0.03,
  };

  // 2. Fetch candidates from DexScreener + Solana Tracker
  if (onProgress) await onProgress('Fetching token candidates from DexScreener + Solana Tracker...');
  console.log('[backtest] Fetching candidate tokens...');

  const [dexTrending, stGraduated] = await Promise.allSettled([
    fetchDexScreenerTrending(),
    fetchSolanaTrackerGraduated(),
  ]);

  const allMints = new Set([
    ...(dexTrending.status === 'fulfilled' ? dexTrending.value : []),
    ...(stGraduated.status === 'fulfilled' ? stGraduated.value : []),
  ]);

  const candidateList = [...allMints].slice(0, MAX_CANDIDATES);
  console.log(`[backtest] Found ${candidateList.length} candidates (DexScreener: ${dexTrending.value?.length ?? 0}, SolanaTracker: ${stGraduated.value?.length ?? 0})`);

  if (onProgress) await onProgress(`Found ${candidateList.length} candidates — running filters...`);

  // 3. Run each candidate through the filter pipeline
  const results = {
    total: candidateList.length,
    layer1Fail: 0, layer2Fail: 0, layer3Fail: 0,
    passed: 0,
    trades: [],
    wins: 0, losses: 0, neutrals: 0,
    totalPnlSol: 0,
  };

  const DELAY_MS = 200; // avoid rate limits
  for (let i = 0; i < candidateList.length; i++) {
    const mint = candidateList[i];

    try {
      const filter = await runCandidateFilter(mint, { skipLayer3: true }); // skip L3 for speed

      if (!filter.passed) {
        if (filter.layer === 1) results.layer1Fail++;
        else if (filter.layer === 2) results.layer2Fail++;
        else if (filter.layer === 3) results.layer3Fail++;
        continue;
      }

      results.passed++;
      const tokenData = filter.tokenData;

      // Simulate trade outcome
      const outcome = simulateOutcome(tokenData, strategy);
      if (!outcome) continue;

      storeBacktestPosition(mint, tokenData, outcome, strategy);
      results.trades.push({
        mint: mint.slice(0, 8),
        symbol: tokenData.dex?.symbol || mint.slice(0, 8),
        pnlPercent: outcome.pnlPercent,
        exitReason: outcome.exitReason,
        exitClass: outcome.exitClass,
      });

      if (outcome.exitClass === 'win') results.wins++;
      else if (outcome.exitClass === 'loss') results.losses++;
      else results.neutrals++;
      results.totalPnlSol += outcome.pnlSol;

    } catch (err) {
      console.log(`[backtest] Error processing ${mint.slice(0, 8)}: ${err.message}`);
    }

    if (i % 20 === 0 && onProgress) {
      await onProgress(`Processed ${i + 1}/${candidateList.length} — ${results.passed} passed filters...`);
    }

    // Rate limit delay
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  const winRate = results.trades.length > 0 ? Math.round(results.wins / results.trades.length * 100) : 0;

  console.log(`[backtest] Complete: ${results.passed}/${results.total} passed | ${results.trades.length} simulated | win rate: ${winRate}% | PnL: ${results.totalPnlSol.toFixed(4)} SOL | ${elapsed}s`);

  return { ...results, winRate, elapsed };
}

// ── Format backtest report for Telegram ─────────────────────────────────────
export function formatBacktestReport(results) {
  const { total, layer1Fail, layer2Fail, layer3Fail, passed, trades, wins, losses, neutrals, totalPnlSol, winRate, elapsed } = results;

  const topTrades = [...trades]
    .sort((a, b) => b.pnlPercent - a.pnlPercent)
    .slice(0, 5);

  const tradeLines = topTrades.map(t => {
    const icon = t.exitClass === 'win' ? '✅' : t.exitClass === 'loss' ? '❌' : '⚖️';
    return `${icon} $${escapeHtml(t.symbol)} — <b>${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%</b> (${t.exitReason})`;
  });

  const pnlStr = totalPnlSol >= 0 ? `+${totalPnlSol.toFixed(4)}` : totalPnlSol.toFixed(4);

  return [
    '🔬 <b>BACKTEST REPORT</b>',
    `📅 ${new Date().toUTCString().slice(0, 16)}`,
    '━━━━━━━━━━━━━━━━',
    '',
    '🔍 <b>FILTER PIPELINE</b>',
    `▸ Candidates scanned: <b>${total}</b>`,
    `▸ Layer 1 rejected: <b>${layer1Fail}</b> (liquidity/age/auth/mcap)`,
    `▸ Layer 2 rejected: <b>${layer2Fail}</b> (momentum/holders/vol)`,
    `▸ Layer 3 rejected: <b>${layer3Fail}</b> (Jupiter routing)`,
    `▸ Passed all filters: <b>${passed}</b> (${total > 0 ? Math.round(passed / total * 100) : 0}%)`,
    '',
    '📊 <b>SIMULATED OUTCOMES</b>',
    `▸ Total trades: <b>${trades.length}</b>`,
    `▸ Win rate: <b>${winRate}%</b>`,
    `▸ Wins: <b>${wins}</b> | Losses: <b>${losses}</b> | Neutral: <b>${neutrals}</b>`,
    `▸ Simulated PnL: <b>${pnlStr} SOL</b>`,
    '',
    trades.length > 0 ? '🏆 <b>TOP 5 SIMULATED TRADES</b>' : '',
    ...tradeLines,
    '',
    `⏱ Completed in ${elapsed}s`,
    '━━━━━━━━━━━━━━━━',
    winRate >= 48
      ? '✅ <b>TARGET MET</b> — win rate ≥ 48%'
      : `⚠️ Win rate ${winRate}% — target is 48%`,
  ].filter(l => l !== undefined).join('\n');
}
