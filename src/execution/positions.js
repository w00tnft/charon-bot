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
import { sendPositionExit, sendPartialExit, sendTelegram } from '../telegram/send.js';
import { blacklistToken, whitelistDeployer } from '../db/blacklist.js';
import { escapeHtml, short } from '../format.js';
import { autoRunLearning } from '../learning/commands.js';

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
  if (reason === 'TRAILING_STOP' || reason === 'TP' || reason === 'TRAILING_TP') return pnl > 0 ? 'win' : 'loss';
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

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
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

  // ── New partial-exit + trailing-stop system ────────────────────────────────
  if (strat?.partial_exit_pct != null) {
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
    const dryExitClass = classifyExit(exitReason, pnlPercent, Boolean(position.partial_tp_done) || partialFired);
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_class = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, dryExitClass, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason,
      json({ pnlPercent, pnlSol }));
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
    partialFired,
  };
}

const DRY_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

async function maybeAutoLearn() {
  const { count: total } = db.prepare("SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = 'closed'").get();
  if (total === 0) return;
  const milestone = Math.floor(total / 25) * 25;
  if (milestone === 0) return;
  const last = numSetting('last_auto_learn_count', 0);
  if (milestone <= last) return;
  setSetting('last_auto_learn_count', milestone);
  console.log(`[learning] auto-triggered at ${total} closed positions`);
  await autoRunLearning(milestone);
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
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  let anyExit = false;
  for (const position of positions) {
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

    // Dry-run positions that can't be priced (dead token, no liquidity) are closed
    // after 2 hours so they don't permanently block the max_open_positions gate.
    if (!result && position.execution_mode !== 'live') {
      const ageMs = now() - position.opened_at_ms;
      if (ageMs >= DRY_RUN_TIMEOUT_MS) {
        db.prepare(`
          UPDATE dry_run_positions
          SET status = 'closed', closed_at_ms = ?, exit_reason = 'DRY_RUN_TIMEOUT', pnl_percent = 0, pnl_sol = 0,
              exit_class = 'loss'
          WHERE id = ?
        `).run(now(), position.id);
        console.log(`[position] ${position.id} (${position.symbol || position.mint.slice(0, 8)}) auto-closed after ${Math.round(ageMs / 60000)}m — no price data`);
        await sendPositionExit({ ...position, exitReason: 'DRY_RUN_TIMEOUT', pnlPercent: 0, pnl_percent: 0, pnlSol: 0, pnl_sol: 0 }).catch(() => {});
        anyExit = true;
      }
    }
  }
  if (anyExit) await maybeAutoLearn().catch(err => console.log(`[learning] auto-trigger error: ${err.message}`));
}
