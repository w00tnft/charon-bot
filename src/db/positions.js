import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';
import { toCanonicalRoute } from '../learning/weights.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export async function recoverOpenPositions() {
  const open = db.prepare(`SELECT * FROM dry_run_positions WHERE status = 'open'`).all();
  if (open.length === 0) {
    console.log('[recovery] No open positions to recover');
    return [];
  }
  console.log(`[recovery] Found ${open.length} open position(s) — checking prices...`);

  const { fetchJupiterAsset } = await import('../enrichment/jupiter.js');
  const results = [];

  for (const pos of open) {
    const sym = pos.symbol || pos.mint.slice(0, 8);
    try {
      const asset = await fetchJupiterAsset(pos.mint, { useCache: false }).catch(() => null);
      const currentPrice = asset?.usdPrice || null;

      if (!currentPrice || !pos.entry_price) {
        console.log(`[recovery] ${sym} — no price data, closing safely`);
        db.prepare(`
          UPDATE dry_run_positions
          SET status='closed', exit_reason='RECOVERY_NO_PRICE',
              pnl_percent=0, pnl_sol=0, exit_class='neutral', closed_at_ms=?
          WHERE id=?
        `).run(Date.now(), pos.id);
        results.push({ symbol: sym, action: 'CLOSED', reason: 'no price', pnl: 0 });
        continue;
      }

      const entryPrice = Number(pos.entry_price);
      const pnl = (currentPrice - entryPrice) / entryPrice * 100;
      const pnlSol = Number(pos.size_sol || 0.03) * (pnl / 100);

      let exitReason = null;
      if (pnl <= -30) exitReason = 'NUCLEAR_RECOVERY';
      else if (pnl <= -15) exitReason = 'SL_RECOVERY';
      else if (pnl >= 25) exitReason = 'TP_RECOVERY';

      if (exitReason) {
        const exitClass = pnl >= 25 ? 'win' : 'loss';
        db.prepare(`
          UPDATE dry_run_positions
          SET status='closed', exit_reason=?,
              pnl_percent=?, pnl_sol=?,
              exit_price=?, exit_class=?, closed_at_ms=?
          WHERE id=?
        `).run(exitReason, pnl, pnlSol, currentPrice, exitClass, Date.now(), pos.id);
        console.log(`[recovery] ${sym}: ${pnl.toFixed(1)}% → ${exitReason}`);
        results.push({ symbol: sym, action: 'CLOSED', reason: exitReason, pnl });
      } else {
        console.log(`[recovery] ${sym}: ${pnl.toFixed(1)}% — keeping open`);
        results.push({ symbol: sym, action: 'KEPT', reason: 'within range', pnl });
      }
    } catch (err) {
      console.error(`[recovery] ${sym} error:`, err.message);
      results.push({ symbol: sym, action: 'ERROR', reason: err.message, pnl: 0 });
    }
  }
  return results;
}

export async function closeStuckPositions(olderThanMs = 30 * 60_000) {
  const cutoff = now() - olderThanMs;
  const stuck = db.prepare(`
    SELECT id, mint, entry_price, size_sol FROM dry_run_positions
    WHERE status = 'open' AND opened_at_ms < ?
  `).all(cutoff);
  if (!stuck.length) return 0;

  const { fetchJupiterAsset } = await import('../enrichment/jupiter.js');
  const closeAt = now();
  let closed = 0;
  for (const pos of stuck) {
    let pnlPct = 0;
    let pnlSol = 0;
    try {
      const asset = await fetchJupiterAsset(pos.mint, { useCache: false }).catch(() => null);
      const currentPrice = asset?.usdPrice ?? 0;
      const entryPrice = Number(pos.entry_price ?? 0);
      if (currentPrice > 0 && entryPrice > 0) {
        pnlPct = (currentPrice - entryPrice) / entryPrice * 100;
        pnlSol = Number(pos.size_sol) * pnlPct / 100;
      }
    } catch {
      // fail-safe — keep 0 PnL if price unavailable
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_reason = 'STARTUP_CLEANUP',
          exit_class = 'neutral', pnl_percent = ?, pnl_sol = ?
      WHERE id = ? AND status = 'open'
    `).run(closeAt, pnlPct, pnlSol, pos.id);
    closed++;
  }
  if (closed > 0) console.log(`[startup] closed ${closed} stuck dry_run position(s) (open > ${olderThanMs / 60000}min)`);
  return closed;
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const baseSize = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const ROUTE_SIZES = { smart_money: 0.02, dual_source: 0.03, pumpportal_survivor: 0.03, webhook: 0.03 };
  const canonRoute = toCanonicalRoute(candidate.signals?.route);
  const sizeSol = ROUTE_SIZES[canonRoute] ?? baseSize;
  const sym = candidate.token?.symbol || candidate.token?.mint?.slice(0, 8) || '?';
  console.log(`[size] $${sym} route: ${canonRoute} → ${sizeSol} SOL`);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    const signalRoute = candidate.signals?.route || null;
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, signal_route, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      signalRoute,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const signalRoute = candidate.signals?.route || null;
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, signal_route, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      signalRoute,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}
