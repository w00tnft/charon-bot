import { db } from './connection.js';
import { setSetting, numSetting } from './settings.js';
import { now } from '../utils.js';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isDueForCleanup() {
  const last = numSetting('last_cleanup_ms', 0);
  return Date.now() - last >= CLEANUP_INTERVAL_MS;
}

export function runCleanup() {
  const cutoff30d = now() - 30 * 24 * 60 * 60 * 1000;

  // signal_events and decision_logs: keep 30 days
  const r1 = db.prepare('DELETE FROM signal_events WHERE at_ms < ?').run(cutoff30d);
  const r2 = db.prepare('DELETE FROM decision_logs WHERE at_ms < ?').run(cutoff30d);

  // capital_snapshots: keep 7 days (used only for sparkline)
  const r3 = db.prepare(
    "DELETE FROM capital_snapshots WHERE snapshot_at < datetime('now', '-7 days')"
  ).run();

  // candidates: keep 30 days (candidate_json can be large)
  const r4 = db.prepare(
    'DELETE FROM candidates WHERE created_at_ms < ?'
  ).run(cutoff30d);

  const total = r1.changes + r2.changes + r3.changes + r4.changes;
  if (total > 0) {
    console.log(
      `[cleanup] removed ${r1.changes} signal_events, ` +
      `${r2.changes} decision_logs, ` +
      `${r3.changes} capital_snapshots, ` +
      `${r4.changes} candidates`
    );
  } else {
    console.log('[cleanup] nothing to remove');
  }

  setSetting('last_cleanup_ms', String(now()));
}
