import { db } from './connection.js';
import { now } from '../utils.js';

export function isBlacklisted(mint, deployer) {
  if (mint) {
    const row = db.prepare("SELECT id FROM blacklist WHERE mint = ? AND reason = 'rug' LIMIT 1").get(mint);
    if (row) return { type: 'token' };
  }
  if (deployer) {
    const row = db.prepare("SELECT id FROM blacklist WHERE deployer = ? AND reason = 'deployer_banned' LIMIT 1").get(deployer);
    if (row) return { type: 'deployer' };
  }
  return null;
}

export function blacklistToken(mint, deployer, pnlPercent) {
  const ts = now();
  db.prepare(`
    INSERT OR IGNORE INTO blacklist (mint, deployer, reason, pnl_percent, banned_at_ms)
    VALUES (?, ?, 'rug', ?, ?)
  `).run(mint, deployer || null, pnlPercent, ts);
  if (deployer) {
    db.prepare(`
      INSERT OR IGNORE INTO blacklist (mint, deployer, reason, pnl_percent, banned_at_ms)
      VALUES (?, ?, 'deployer_banned', ?, ?)
    `).run(mint, deployer, pnlPercent, ts);
    console.log(`[blacklist] deployer banned: ${deployer.slice(0, 8)}…`);
  }
  console.log(`[blacklist] token banned: ${mint.slice(0, 8)}…`);
}

export function whitelistDeployer(deployer, mint, pnlPercent) {
  if (!deployer) return;
  db.prepare(`
    INSERT OR IGNORE INTO whitelist (deployer, mint, reason, pnl_percent, whitelisted_at_ms)
    VALUES (?, ?, 'won', ?, ?)
  `).run(deployer, mint || null, pnlPercent, now());
  console.log(`[whitelist] known winner deployer: ${deployer.slice(0, 8)}…`);
}

export function isWhitelisted(deployer) {
  if (!deployer) return false;
  const row = db.prepare('SELECT id FROM whitelist WHERE deployer = ? LIMIT 1').get(deployer);
  return Boolean(row);
}

export function getBlacklist() {
  const tokens = db.prepare(`
    SELECT mint, deployer, pnl_percent, banned_at_ms
    FROM blacklist WHERE reason = 'rug'
    ORDER BY banned_at_ms DESC LIMIT 20
  `).all();
  const deployers = db.prepare(`
    SELECT deployer, COUNT(*) AS rug_count, MIN(pnl_percent) AS worst_pnl, MAX(banned_at_ms) AS latest_ms
    FROM blacklist WHERE reason = 'deployer_banned'
    GROUP BY deployer ORDER BY latest_ms DESC LIMIT 10
  `).all();
  return { tokens, deployers };
}
