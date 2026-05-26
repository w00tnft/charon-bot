import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById, setSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit, sendPartialExit, sendTelegram, sendTrailActivated } from '../telegram/send.js';
import { blacklistToken, whitelistDeployer } from '../db/blacklist.js';
import { escapeHtml, short } from '../format.js';
import { autoRunLearning } from '../learning/commands.js';
import { recordLoss } from '../utils/mintCooldown.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

export function classifyExit(exitReason, pnlPercent, partialDone) {
  const reason = (exitReason || '').toUpperCase();
  const pnl = Number(pnlPercent || 0);
  if (reason === 'HARD_SL' || reason === 'SL' || pnl < 0) return 'loss';
  if (partialDone) return 'win';
  if (reason === 'TRAIL_STOP' || reason === 'TRAILING_STOP' || reason === 'TP' || reason === 'TRAILING_TP') return pnl > 0 ? 'win' : 'loss';
  if (pnl >= 30) return 'win';
  if (pnl > 0) return 'neutral';
  return 'loss';
}

const sellInProgress = new Set();

async function doLiveSell(position, reason, price, mcap) {
  if (sellInProgress.has(position.id)) return null;
  sellInProgress.add(position.id);
  try {
    return await executeLiveSell(position, reason);
  } finally {
    sellInProgress.delete(position.id);
  }
}

const PANIC_EXIT_REASONS = new Set(['HARD_SL', 'EMERGENCY_STOP', 'NUCLEAR_STOP', 'SL_RECOVERY', 'NUCLEAR_RECOVERY', 'LIQUIDITY_EMERGENCY']);

function simulateExitSlippage(liquidityUsd, sizeSol, exitReason) {
  if (process.env.SIMULATE_COSTS === 'false') return 0;
  const liq = liquidityUsd > 0 ? liquidityUsd : 100_000;
  const sizeUsd = sizeSol * 150;
  const baseImpact = (sizeUsd / liq) * 100;
  const panic = PANIC_EXIT_REASONS.has(exitReason) ? 2.5 : 1.2;
  const mevImpact = liq < 50_000 ? Math.random() * 2.0 : Math.random() * 0.5;
  return Math.min((baseImpact * panic) + mevImpact, 5.0);
}

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  // Only use live Jupiter mcap for PnL — never fall back to stored values.
  // Falling back to entry_mcap/high_water makes a rugged token look like 0% loss.
  const liveMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  if (!liveMcap || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null; // no live price → handled by no-price fallback path
  }
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = liveMcap;
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }

  const strat = strategyById(position.strategy_id);
  let exitReason = null;
  let closed = false;
  let partialFired = false;
  let netPnlPct = pnlPercent;
  let grossPnlPct = pnlPercent;
  let exitSlippagePct = 0;
  let exitGasSol = 0;
  let liquidityAtExit = 0;

  // ── Liquidity emergency check ──────────────────────────────────────────────
  if (position.execution_mode !== 'live') {
    const currentLiq = Number(asset?.liquidity || 0);
    liquidityAtExit = currentLiq;
    const liqEmergency = Number(process.env.LIQUIDITY_EMERGENCY_USD) || 10_000;
    const liqWarning = Number(process.env.LIQUIDITY_WARNING_USD) || 20_000;
    const sym = position.symbol || position.mint.slice(0, 8);
    if (currentLiq > 0 && currentLiq < liqEmergency) {
      console.log(`[liquidity] $${sym} EMERGENCY — dropped to $${Math.round(currentLiq / 1000)}k — force closing`);
      exitReason = 'LIQUIDITY_EMERGENCY';
    } else if (currentLiq > 0 && currentLiq < liqWarning) {
      console.log(`[liquidity] $${sym} WARNING — low at $${Math.round(currentLiq / 1000)}k`);
    }
  }

  // ── Full-exit system (degen: TP at flat %, no runner) ─────────────────────
  if (strat?.exit_type === 'full') {
    const tpPct = strat.take_profit_pct ?? 15;
    const hardStopPct = Math.abs(strat.hard_stop_pct ?? 25);
    const emergencyPct = Math.abs(strat.emergency_stop_pct ?? 25);
    const maxHoldMs = strat.max_hold_ms ?? 0;

    db.prepare('UPDATE dry_run_positions SET high_water_mcap = ?, high_water_price = ?, pnl_percent = ? WHERE id = ?')
      .run(highWaterMcap, highWaterPrice, pnlPercent, position.id);

    if (!exitReason && maxHoldMs > 0 && (now() - position.opened_at_ms) >= maxHoldMs) {
      exitReason = 'MAX_HOLD';
    }
    if (!exitReason && pnlPercent <= -emergencyPct) {
      console.log(`[position] EMERGENCY $${position.symbol} ${pnlPercent.toFixed(1)}% ❌`);
      exitReason = 'EMERGENCY_STOP';
    }
    if (!exitReason && pnlPercent <= -hardStopPct) {
      console.log(`[position] HARD STOP $${position.symbol} ${pnlPercent.toFixed(1)}% ❌`);
      exitReason = 'HARD_SL';
    }
    // ── Profit-lock trailing stop (replaces flat TP when TRAIL_ENABLED) ─────
    const trailEnabled = process.env.TRAIL_ENABLED !== 'false';
    const trailPct = Number(process.env.TRAIL_PCT) || 0.10;

    if (!exitReason) {
      if (!trailEnabled) {
        if (pnlPercent >= tpPct) {
          console.log(`[position] TP HIT $${position.symbol} +${pnlPercent.toFixed(1)}% ✅`);
          exitReason = 'TP';
        }
      } else if (!position.trail_active) {
        if (pnlPercent >= tpPct) {
          const activationPrice = Number(asset?.usdPrice) || price;
          db.prepare(`
            UPDATE dry_run_positions
            SET trail_active = 1, trail_peak_price = ?, trail_activated_at_ms = ?
            WHERE id = ?
          `).run(activationPrice, now(), position.id);
          console.log(`[trail] $${position.symbol} ACTIVATED at +${pnlPercent.toFixed(1)}% — peak: ${activationPrice}`);
          sendTrailActivated(position, activationPrice, pnlPercent, trailPct).catch(() => {});
        }
      } else {
        const peakPrice = Number(position.trail_peak_price);
        const livePrice = Number(asset?.usdPrice) || 0;
        if (livePrice > 0 && peakPrice > 0) {
          if (livePrice > peakPrice) {
            db.prepare('UPDATE dry_run_positions SET trail_peak_price = ? WHERE id = ?').run(livePrice, position.id);
            console.log(`[trail] $${position.symbol} new peak: ${livePrice} (+${pnlPercent.toFixed(1)}%)`);
          } else {
            const trailStop = peakPrice * (1 - trailPct);
            if (livePrice <= trailStop) {
              console.log(`[trail] $${position.symbol} TRAIL STOP hit — peak: ${peakPrice} exit: ${livePrice} (+${pnlPercent.toFixed(1)}%)`);
              exitReason = 'TRAIL_STOP';
            } else {
              console.log(`[trail] $${position.symbol} holding — ${((livePrice / peakPrice - 1) * 100).toFixed(1)}% from peak`);
            }
          }
        }
      }
    }

  // ── New partial-exit + trailing-stop system ────────────────────────────────
  } else if (strat?.partial_exit_pct != null) {
    const partialExitPct = strat.partial_exit_pct;
    const partialExitSize = strat.partial_exit_size ?? 0.60;
    const trailingStopPct = strat.trailing_stop_pct ?? 20;
    const hardStopPct = Math.abs(strat.hard_stop_pct ?? 25);
    const maxHoldMs = strat.max_hold_ms ?? 0;
    const partialDone = Boolean(position.partial_tp_done);

    db.prepare('UPDATE dry_run_positions SET high_water_mcap = ?, high_water_price = ? WHERE id = ?')
      .run(highWaterMcap, highWaterPrice, position.id);

    // Max hold (checked first — clean exit even in profit)
    if (!exitReason && maxHoldMs > 0 && (now() - position.opened_at_ms) >= maxHoldMs) {
      exitReason = 'MAX_HOLD';
    }

    // Hard SL (always active, even after partial exit)
    if (!exitReason && pnlPercent <= -hardStopPct) {
      exitReason = 'HARD_SL';
    }

    // Partial exit (phase 1 — fire once when +partial_exit_pct% reached)
    if (!exitReason && !partialDone && pnlPercent >= partialExitPct) {
      db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
      console.log(`[position] ${position.id} partial exit at ${pnlPercent.toFixed(1)}% (${Math.round(partialExitSize * 100)}% sell)`);
      partialFired = true;

      if (position.execution_mode === 'live' && position.token_amount_raw) {
        try {
          const sellAmount = Math.floor(Number(position.token_amount_raw) * partialExitSize);
          if (sellAmount > 0) {
            const sell = await doLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_EXIT', price, mcap);
            if (sell) {
              const remaining = Number(position.token_amount_raw) - sellAmount;
              db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
              db.prepare(`
                INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
                VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_EXIT', ?)
              `).run(position.id, position.mint, now(), price, mcap,
                position.size_sol * partialExitSize, sellAmount,
                json({ pnlPercent, partialExitSize, remaining }));
            }
          }
        } catch (err) {
          console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
        }
      }
    }

    // Trailing stop (phase 2 — only active after partial exit)
    if (!exitReason && (partialDone || partialFired)) {
      const trailingStopMcap = highWaterMcap * (1 - trailingStopPct / 100);
      if (Number(mcap) <= trailingStopMcap) {
        exitReason = 'TRAILING_STOP';
      }
    }

  // ── Legacy fixed TP/SL system (sniper, dip_buy, smart_money) ──────────────
  } else {
    const tpHit = pnlPercent >= Number(position.tp_percent);
    const slHit = pnlPercent <= Number(position.sl_percent);
    const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);
    const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
    const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));

    if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
      exitReason = 'MAX_HOLD';
    }
    if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
      db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
      console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}%`);
      if (position.execution_mode === 'live' && position.token_amount_raw) {
        try {
          const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
          if (sellAmount > 0) {
            const sell = await doLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP', price, mcap);
            if (sell) {
              const remaining = Number(position.token_amount_raw) - sellAmount;
              db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
              db.prepare(`
                INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
                VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
              `).run(position.id, position.mint, now(), price, mcap,
                position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
                json({ pnlPercent, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
            }
          }
        } catch (err) {
          console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
        }
      }
    }
    if (!exitReason) {
      if (slHit) exitReason = 'SL';
      else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
      else if (trailingHit) exitReason = 'TRAILING_TP';
    }

    db.prepare(`
      UPDATE dry_run_positions
      SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
      WHERE id = ?
    `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, position.id);
  }

  // ── Execute exit ───────────────────────────────────────────────────────────
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  if (exitReason && autoExit && position.execution_mode === 'live') {
    const sell = await doLiveSell(position, exitReason, price, mcap);
    if (!sell) return { ...position, exitReason: null };
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    const liveExitClass = classifyExit(exitReason, finalPnlPercent, Boolean(position.partial_tp_done) || partialFired);
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?, exit_class = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, liveExitClass, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason,
      json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    // Simulate exit costs for dry-run positions
    const GAS_SOL_BASE = 0.000005;
    const PRIORITY_FEE_SOL = Number(process.env.PRIORITY_FEE_LAMPORTS || 50000) / 1e9;
    exitGasSol = GAS_SOL_BASE + PRIORITY_FEE_SOL;
    const currentLiq = liquidityAtExit > 0 ? liquidityAtExit : Number(asset?.liquidity || 0);
    exitSlippagePct = simulateExitSlippage(currentLiq, Number(position.size_sol), exitReason);
    const gasCostPct = (exitGasSol / Number(position.size_sol)) * 100;
    const entrySlipPct = Number(position.entry_slippage_pct || 0);
    grossPnlPct = pnlPercent;
    netPnlPct = grossPnlPct - entrySlipPct - exitSlippagePct - gasCostPct;
    const netPnlSol = Number(position.size_sol) * netPnlPct / 100;
    const sym = position.symbol || position.mint.slice(0, 8);
    console.log(`[sim] $${sym} exit — gross: ${grossPnlPct.toFixed(2)}% | entry slip: -${entrySlipPct.toFixed(2)}% | exit slip: -${exitSlippagePct.toFixed(2)}% | gas: -${gasCostPct.toFixed(2)}% | NET: ${netPnlPct.toFixed(2)}%`);
    finalPnlPercent = pnlPercent; // keep gross in pnl_percent for compatibility
    finalPnlSol = pnlSol;
    const dryExitClass = classifyExit(exitReason, pnlPercent, Boolean(position.partial_tp_done) || partialFired);
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_class = ?,
          gross_pnl_pct = ?, net_pnl_pct = ?, exit_slippage_pct = ?, exit_gas_sol = ?, liquidity_at_exit = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, dryExitClass,
           grossPnlPct, netPnlPct, exitSlippagePct, exitGasSol, currentLiq, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason,
      json({ pnlPercent, pnlSol, grossPnlPct, netPnlPct, exitSlippagePct, exitGasSol }));
    closed = true;
  }

  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
    exit_class: closed
      ? classifyExit(exitReason, finalPnlPercent, Boolean(position.partial_tp_done) || partialFired)
      : position.exit_class,
    gross_pnl_pct: closed ? grossPnlPct : position.gross_pnl_pct,
    net_pnl_pct: closed ? netPnlPct : position.net_pnl_pct,
    exit_slippage_pct: closed ? exitSlippagePct : position.exit_slippage_pct,
    liquidity_at_exit: closed ? liquidityAtExit : position.liquidity_at_exit,
    partialFired,
  };
}

const DRY_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const ABSOLUTE_MAX_HOLD_MS = 25 * 60_000; // 25 min — hard ceiling for all dry-run positions

async function maybeAutoLearn() {
  const { count: total } = db.prepare("SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = 'closed'").get();
  if (total === 0) return;
  const batchSize = process.env.ACCELERATED_DRY_RUN === 'true' ? 10 : 25;
  const milestone = Math.floor(total / batchSize) * batchSize;
  if (milestone === 0) return;
  const last = numSetting('last_auto_learn_count', 0);
  if (milestone <= last) return;
  setSetting('last_auto_learn_count', milestone);
  console.log(`[learning] auto-triggered at ${total} closed positions (batch: ${batchSize})`);
  await autoRunLearning(milestone);
}

function recordCapitalSnapshot() {
  try {
    const baseSol = numSetting('starting_capital_sol', 1.0);
    const { s: totalPnl } = db.prepare("SELECT COALESCE(SUM(pnl_sol),0) AS s FROM dry_run_positions WHERE status='closed'").get();
    const capital = baseSol + Number(totalPnl);
    const { c: tradeNumber } = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE status='closed'").get();
    db.prepare('INSERT INTO capital_snapshots (capital_sol, trade_number) VALUES (?, ?)').run(capital, tradeNumber);
  } catch (err) {
    console.log(`[report] snapshot error: ${err.message}`);
  }
}

function extractDeployer(result) {
  try {
    const snap = JSON.parse(result.snapshot_json || '{}');
    return snap.candidate?.token?.deployerAddress
      || snap.candidate?.safety?.deployerAddress
      || null;
  } catch {
    return null;
  }
}

async function maybeUpdateReputation(result) {
  const deployer = extractDeployer(result);
  const pnl = result.pnl_percent ?? result.pnlPercent ?? 0;
  const symbol = result.symbol || short(result.mint);

  const lossReasons = ['HARD_SL', 'SL', 'EMERGENCY_STOP', 'NUCLEAR_STOP', 'SL_RECOVERY', 'NUCLEAR_RECOVERY', 'LIQUIDITY_EMERGENCY'];
  if (result.exit_class === 'loss' && lossReasons.includes(result.exitReason)) {
    recordLoss(result.mint);
  }

  if (result.exit_class === 'loss' && (result.exitReason === 'HARD_SL' || result.exitReason === 'SL')) {
    blacklistToken(result.mint, deployer, pnl);
    const deployerShort = deployer ? deployer.slice(0, 8) + '…' : 'unknown';
    await sendTelegram([
      '🚫 <b>BLACKLISTED</b>',
      '',
      `🪙 Token: <b>$${escapeHtml(symbol)}</b>`,
      `📋 CA: <code>${result.mint}</code>`,
      `👛 Deployer: <code>${deployerShort}</code>`,
      `💀 Reason: Hard stop hit (${pnl.toFixed(1)}%)`,
      deployer ? '⛔ This deployer is now banned' : '',
    ].filter(l => l !== '').join('\n')).catch(() => {});
  } else if (result.exit_class === 'win') {
    whitelistDeployer(deployer, result.mint, pnl);
  }
}

export async function monitorPositions() {
  const positions = openPositions();

  // Aggressive time-limit enforcement: close any dry_run position past max_hold_ms
  // BEFORE attempting price refresh, so dead tokens don't block slots.
  // Falls back to ABSOLUTE_MAX_HOLD_MS when strat is null (legacy/migrated positions).
  for (const position of positions) {
    if (position.execution_mode === 'live') continue;
    const strat = strategyById(position.strategy_id);
    const maxHoldMs = strat?.max_hold_ms > 0 ? strat.max_hold_ms : ABSOLUTE_MAX_HOLD_MS;
    const ageMs = now() - position.opened_at_ms;
    if (ageMs >= maxHoldMs) {
      // Fetch current price to record real PnL instead of 0
      let pnlPct = 0;
      let pnlSol = 0;
      let exitClass = 'neutral';
      try {
        const asset = await fetchJupiterAsset(position.mint, { useCache: false }).catch(() => null);
        const currentPrice = asset?.usdPrice ?? 0;
        const entryPrice = Number(position.entry_price ?? 0);
        if (currentPrice > 0 && entryPrice > 0) {
          pnlPct = (currentPrice - entryPrice) / entryPrice * 100;
          pnlSol = Number(position.size_sol) * pnlPct / 100;
          exitClass = classifyExit('MAX_HOLD', pnlPct, Boolean(position.partial_tp_done));
        }
      } catch {
        // fail-safe — keep 0 PnL if price fetch fails
      }
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_reason = 'MAX_HOLD', pnl_percent = ?, pnl_sol = ?,
            exit_class = ?
        WHERE id = ? AND status = 'open'
      `).run(now(), pnlPct, pnlSol, exitClass, position.id);
      console.log(`[position] ${position.id} (${position.symbol || position.mint.slice(0, 8)}) MAX_HOLD force-closed after ${Math.round(ageMs / 60000)}m — pnl: ${pnlPct.toFixed(1)}%`);
      await sendPositionExit({ ...position, exitReason: 'MAX_HOLD', pnlPercent: pnlPct, pnl_percent: pnlPct, pnlSol, pnl_sol: pnlSol, exit_class: exitClass }).catch(() => {});
    }
  }

  // Re-fetch open positions after time-limit sweep
  const activePositions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && activePositions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  let anyExit = false;
  for (const position of activePositions) {
    const sym = position.symbol || position.mint.slice(0, 8);
    const lastPnl = Number(position.pnl_percent || 0);
    const ageMins = Math.round((now() - position.opened_at_ms) / 60000);
    console.log(`[monitor] $${sym} pnl: ${lastPnl.toFixed(1)}% age: ${ageMins}m`);

    // Pre-cycle emergency: fire on stored pnl before even fetching price
    if (position.execution_mode !== 'live' && lastPnl !== 0) {
      const preStrat = strategyById(position.strategy_id);
      const preEmergencyPct = Math.abs(preStrat?.emergency_stop_pct ?? 25);
      if (lastPnl <= -preEmergencyPct) {
        db.prepare(`
          UPDATE dry_run_positions
          SET status = 'closed', closed_at_ms = ?, exit_reason = 'EMERGENCY_STOP',
              pnl_percent = ?, pnl_sol = ?, exit_class = 'loss'
          WHERE id = ? AND status = 'open'
        `).run(now(), lastPnl, Number(position.size_sol) * lastPnl / 100, position.id);
        console.log(`[position] PRE-CYCLE EMERGENCY $${sym} — stored pnl ${lastPnl.toFixed(1)}% <= -${preEmergencyPct}% ❌`);
        await sendPositionExit({ ...position, exitReason: 'EMERGENCY_STOP', pnlPercent: lastPnl, pnl_percent: lastPnl, exit_class: 'loss' }).catch(() => {});
        anyExit = true;
        continue;
      }
    }

    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.partialFired && !result?.exitReason) {
      const strat = strategyById(position.strategy_id);
      const notified = db.prepare('SELECT partial_exit_notified FROM dry_run_positions WHERE id = ?').get(position.id);
      if (!notified?.partial_exit_notified) {
        db.prepare('UPDATE dry_run_positions SET partial_exit_notified = 1 WHERE id = ?').run(position.id);
        await sendPartialExit(result, result.pnlPercent, strat?.partial_exit_size, strat?.trailing_stop_pct).catch(err =>
          console.log(`[position] partial exit notify failed: ${err.message}`));
      }
    }
    if (result?.exitReason) {
      await sendPositionExit(result);
      anyExit = true;
      await maybeUpdateReputation(result).catch(err =>
        console.log(`[blacklist] reputation update error: ${err.message}`));
    }

    // Dry-run positions that can't be priced (dead token, no liquidity):
    // Force-close at max_hold_ms (strategy time limit) even without price data,
    // or fall back to 2-hour hard timeout.
    if (!result && position.execution_mode !== 'live') {
      const strat = strategyById(position.strategy_id);

      // Emergency stop using last stored PnL when price is unavailable
      if (strat?.exit_type === 'full') {
        const emergencyPct = Math.abs(strat.emergency_stop_pct ?? 25);
        const lastPnl = Number(position.pnl_percent || 0);
        if (lastPnl <= -emergencyPct) {
          db.prepare(`
            UPDATE dry_run_positions
            SET status = 'closed', closed_at_ms = ?, exit_reason = 'EMERGENCY_STOP',
                pnl_percent = ?, pnl_sol = ?, exit_class = 'loss'
            WHERE id = ?
          `).run(now(), lastPnl, Number(position.size_sol) * lastPnl / 100, position.id);
          console.log(`[position] EMERGENCY FORCE CLOSE $${position.symbol} — price unknown, assumed > -${emergencyPct}% loss ❌`);
          await sendPositionExit({ ...position, exitReason: 'EMERGENCY_STOP', pnlPercent: lastPnl, pnl_percent: lastPnl, exit_class: 'loss' }).catch(() => {});
          anyExit = true;
          continue;
        }
      }

      const ageMs = now() - position.opened_at_ms;
      const maxHoldMs = strat?.max_hold_ms > 0 ? strat.max_hold_ms : DRY_RUN_TIMEOUT_MS;
      const timeoutMs = Math.min(maxHoldMs + 5 * 60_000, DRY_RUN_TIMEOUT_MS); // max_hold + 5min grace, floor at 2h
      if (ageMs >= timeoutMs) {
        const reason = ageMs >= DRY_RUN_TIMEOUT_MS ? 'DRY_RUN_TIMEOUT' : 'MAX_HOLD_NO_PRICE';
        db.prepare(`
          UPDATE dry_run_positions
          SET status = 'closed', closed_at_ms = ?, exit_reason = ?, pnl_percent = 0, pnl_sol = 0,
              exit_class = 'loss'
          WHERE id = ?
        `).run(now(), reason, position.id);
        console.log(`[position] ${position.id} (${position.symbol || position.mint.slice(0, 8)}) force-closed after ${Math.round(ageMs / 60000)}m — ${reason}`);
        await sendPositionExit({ ...position, exitReason: reason, pnlPercent: 0, pnl_percent: 0, pnlSol: 0, pnl_sol: 0 }).catch(() => {});
        anyExit = true;
      }
    }
  }
  if (anyExit) {
    await maybeAutoLearn().catch(err => console.log(`[learning] auto-trigger error: ${err.message}`));
    recordCapitalSnapshot();
  }
}
