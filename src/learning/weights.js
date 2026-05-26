import { db } from '../db/connection.js';
import { now } from '../utils.js';

const LESSON_OVERRIDES = {
  // Proven winners — keep boost
  pumpportal_survivor:    1.3,   // proven from 222 trades
  fee_trending:           1.2,   // +6.2% avg PnL — consistent performer
  fee_graduated:          1.1,   // slight edge
  // Neutral — let auto-tuner learn fresh
  fee_claim:              1.0,
  graduated:              1.0,
  trending:               1.0,
  single_source:          1.0,
  // Historically poor
  fee_graduated_trending: 0.3,   // avoid — -3.8% avg PnL
  graduated_trending:     0.1,   // historically bad
  // Disabled — set to 0 so they never score
  dual_source:            0.0,
  webhook:                0.0,
};

export function toCanonicalRoute(route) {
  if (!route) return 'single_source';
  const r = String(route).toLowerCase();
  if (r.includes('pumpportal')) return 'pumpportal_survivor';
  if (r.includes('webhook') || r.includes('helius')) return 'webhook';
  const hasFee = r.includes('fee');
  const hasGraduated = r.includes('graduated');
  const hasTrending = r.includes('trending');
  if (hasFee && hasGraduated && hasTrending) return 'fee_graduated_trending';
  if (hasFee && hasTrending) return 'fee_trending';
  if (hasFee && hasGraduated) return 'fee_graduated';
  if (hasGraduated && hasTrending) return 'graduated_trending';
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
    SELECT pnl_percent, exit_class, snapshot_json
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
    // Fallback for positions that predate the exit_class column
    const exitClass = pos.exit_class || (pnl > 0 ? 'win' : 'loss');
    const row = byRoute.get(route) || { wins: 0, neutrals: 0, losses: 0, pnlSum: 0, count: 0 };
    row.count += 1;
    row.wins += exitClass === 'win' ? 1 : 0;
    row.neutrals += exitClass === 'neutral' ? 1 : 0;
    row.losses += exitClass === 'loss' ? 1 : 0;
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

    // Insufficient data — use lesson override weight to avoid ignoring known signal quality
    if (row.count < 10) {
      const overrideWeight = LESSON_OVERRIDES[route] ?? 1.0;
      upsert.run(route, row.wins, row.losses, row.pnlSum / row.count, overrideWeight, now());
      results.push({ route, weight: overrideWeight, winRate: 0, avgPnl: row.pnlSum / row.count, count: row.count, wins: row.wins, neutrals: row.neutrals, losses: row.losses, insufficient: true });
      continue;
    }

    const decisive = row.wins + row.losses; // neutrals excluded from win rate
    const winRate = decisive > 0 ? row.wins / decisive : 0.5;
    const neutralRate = row.neutrals / row.count;
    const avgPnl = row.pnlSum / row.count;
    const weight = clamp(
      (winRate * (avgPnl / 100)) - (neutralRate * 0.1),
      0.75, 1.5,
    );
    upsert.run(route, row.wins, row.losses, avgPnl, weight, now());
    results.push({ route, weight, winRate: winRate * 100, avgPnl, count: row.count, wins: row.wins, neutrals: row.neutrals, losses: row.losses });
  }

  if (results.length > 0) {
    console.log('[weights] ' + results.map(r =>
      r.insufficient
        ? `${r.route}: ${r.weight.toFixed(2)}x (insufficient data — ${r.count}/10 trades)`
        : `${r.route}: ${r.weight.toFixed(2)}x`
    ).join(' | '));
  }
  return results;
}

export function getRouteWeight(route) {
  const canonical = toCanonicalRoute(route);
  const row = db.prepare('SELECT weight FROM route_weights WHERE route = ?').get(canonical);
  if (row) return Number(row.weight);
  return LESSON_OVERRIDES[canonical] ?? 1.0;
}

export function allRouteWeights() {
  return db.prepare('SELECT * FROM route_weights ORDER BY weight DESC').all();
}

export function seedRouteWeightOverrides() {
  if (process.env.RESET_LESSONS === 'true') {
    const KEEP_ROUTES = ['pumpportal_survivor', 'fee_trending', 'fee_graduated'];
    db.prepare('DELETE FROM learning_lessons').run();
    db.prepare(
      `DELETE FROM route_weights WHERE route NOT IN (${KEEP_ROUTES.map(() => '?').join(',')})`
    ).run(...KEEP_ROUTES);
    console.log('[weights] RESET_LESSONS=true — lessons wiped, keeping proven routes');
    console.log('[weights] Set RESET_LESSONS=false after deploy');
  }

  const upsert = db.prepare(`
    INSERT INTO route_weights (route, win_count, loss_count, avg_pnl_pct, weight, updated_at_ms)
    VALUES (?, 0, 0, 0, ?, ?)
    ON CONFLICT(route) DO UPDATE SET weight = excluded.weight, updated_at_ms = excluded.updated_at_ms
  `);
  const ts = Date.now();
  for (const [route, weight] of Object.entries(LESSON_OVERRIDES)) {
    upsert.run(route, weight, ts);
  }
  console.log('[weights] lesson overrides seeded: ' +
    Object.entries(LESSON_OVERRIDES).map(([r, w]) => `${r}: ${w}x`).join(' | '));
}
