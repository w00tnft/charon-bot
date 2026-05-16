import { db } from '../db/connection.js';
import { now } from '../utils.js';

export function toCanonicalRoute(route) {
  if (!route) return 'single_source';
  const r = String(route).toLowerCase();
  const hasFee = r.includes('fee');
  const hasGraduated = r.includes('graduated');
  const hasTrending = r.includes('trending');
  const sourceCount = [hasFee, hasGraduated, hasTrending].filter(Boolean).length;
  if (sourceCount >= 2) return 'multi_source';
  if (hasFee) return 'fee_claim';
  if (hasGraduated) return 'graduated';
  if (hasTrending) return 'trending';
  return 'single_source';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function recalculateWeights() {
  const positions = db.prepare(`
    SELECT pnl_percent, snapshot_json
    FROM dry_run_positions
    WHERE status = 'closed'
      AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
  `).all();

  const byRoute = new Map();
  for (const pos of positions) {
    let route = 'single_source';
    try {
      const snap = JSON.parse(pos.snapshot_json || '{}');
      const rawRoute = snap.candidate?.signals?.route || snap.candidate?.signals?.label || '';
      route = toCanonicalRoute(rawRoute);
    } catch { /* malformed snapshot — skip */ }
    const pnl = Number(pos.pnl_percent || 0);
    const row = byRoute.get(route) || { wins: 0, losses: 0, pnlSum: 0, count: 0 };
    row.count += 1;
    row.wins += pnl > 0 ? 1 : 0;
    row.losses += pnl < 0 ? 1 : 0;
    row.pnlSum += pnl;
    byRoute.set(route, row);
  }

  const upsert = db.prepare(`
    INSERT INTO route_weights (route, win_count, loss_count, avg_pnl_pct, weight, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(route) DO UPDATE SET
      win_count = excluded.win_count,
      loss_count = excluded.loss_count,
      avg_pnl_pct = excluded.avg_pnl_pct,
      weight = excluded.weight,
      updated_at_ms = excluded.updated_at_ms
  `);

  const results = [];
  for (const [route, row] of byRoute.entries()) {
    if (row.count === 0) continue;
    const winRate = row.wins / row.count;
    const avgPnl = row.pnlSum / row.count;
    const weight = clamp(winRate * (avgPnl / 100), 0.5, 2.0);
    upsert.run(route, row.wins, row.losses, avgPnl, weight, now());
    results.push({ route, weight, winRate: winRate * 100, avgPnl, count: row.count });
  }

  if (results.length > 0) {
    console.log('[weights] ' + results.map(r => `${r.route}: ${r.weight.toFixed(2)}x`).join(' | '));
  }
  return results;
}

export function getRouteWeight(route) {
  const canonical = toCanonicalRoute(route);
  const row = db.prepare('SELECT weight FROM route_weights WHERE route = ?').get(canonical);
  return row ? Number(row.weight) : 1.0;
}

export function allRouteWeights() {
  return db.prepare('SELECT * FROM route_weights ORDER BY weight DESC').all();
}
