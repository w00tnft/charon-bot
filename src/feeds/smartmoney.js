import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { GMGN_API_KEY } from '../config.js';
import { gmgnFetch } from '../enrichment/gmgn.js';

let candidateHandler = null;
export function setCandidateHandler(fn) { candidateHandler = fn; }

// Deduplicate: don't fire the same wallet+mint twice per 10 minutes
const seenSmartSignals = new Map(); // `${address}:${mint}` → timestamp

function pruneSeenSmartSignals() {
  const cutoff = now() - 10 * 60_000;
  for (const [k, ts] of seenSmartSignals) {
    if (ts < cutoff) seenSmartSignals.delete(k);
  }
}

export async function pollSmartWallets() {
  console.log('[smart] poll tick');
  if (!GMGN_API_KEY) {
    console.log('[smart] poll skipped — GMGN_API_KEY not set');
    return;
  }

  const wallets = db.prepare(
    "SELECT address, label FROM smart_wallets WHERE active = 1 AND address IS NOT NULL AND address != ''"
  ).all();
  if (wallets.length === 0) {
    console.log('[smart] poll skipped — no active wallets in smart_wallets table');
    return;
  }

  pruneSeenSmartSignals();

  let firstWallet = true;
  for (const { address, label } of wallets) {
    try {
      const res = await gmgnFetch(`/defi/quotation/v1/wallet_activity/sol`, {
        params: { wallet: address, limit: 10, type: 'buy' },
      });

      // Log raw response for first wallet each poll cycle to aid debugging
      if (firstWallet) {
        firstWallet = false;
        const keys = res ? Object.keys(res) : [];
        const actCount = (res?.data?.activities || res?.activities || []).length;
        console.log(`[smart] debug ${label}: keys=${keys.join(',') || 'none'} activities=${actCount}`);
      }

      const activities = res?.data?.activities || res?.activities || [];
      const cutoff = now() - 60_000;

      for (const act of activities) {
        const actTs = Number(act.timestamp || act.block_time || act.time || 0) * 1000;
        if (actTs < cutoff) continue;

        const mint = act.token?.address || act.token_address || act.address || act.mint;
        if (!mint) continue;

        const key = `${address}:${mint}`;
        if (seenSmartSignals.has(key)) continue;
        seenSmartSignals.set(key, now());

        const symbol = act.token?.symbol || act.symbol || '';
        const buyAmount = Number(act.cost_sol || act.amount_sol || act.sol_amount || act.total_sol || 0);

        console.log(`[smart] ${label} bought $${symbol} — ${buyAmount.toFixed(3)} SOL`);

        // Increment signal count
        db.prepare(
          'UPDATE smart_wallets SET total_trades = total_trades + 1, last_seen = ? WHERE address = ?'
        ).run(new Date().toISOString(), address);

        if (candidateHandler) {
          await candidateHandler({
            mint,
            route: 'smart_money',
            source: 'smart_money',
            trendingToken: {
              address: mint,
              symbol,
              seenAt: now(),
            },
            smartMoneySignal: { walletLabel: label, walletAddress: address, buyAmount },
          }).catch(err => console.log(`[smart] pipeline error: ${err.message}`));
        }
      }
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404) {
        console.log(`[smart] ${label} (${address.slice(0, 8)}…): ${status || ''} ${err.message}`);
      }
    }
  }
}

export function getSmartWallets() {
  return db.prepare('SELECT * FROM smart_wallets ORDER BY label').all();
}

export function addSmartWallet(label, address) {
  db.prepare(`
    INSERT INTO smart_wallets (label, address, added_at, last_seen)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(label) DO UPDATE SET address = excluded.address, active = 1
  `).run(label, address, new Date().toISOString());
}

export function removeSmartWallet(label) {
  db.prepare('DELETE FROM smart_wallets WHERE label = ?').run(label);
}

export function smartWalletStats() {
  // Query positions whose snapshot_json contains a smart_money source per wallet label
  const wallets = db.prepare('SELECT * FROM smart_wallets ORDER BY label').all();
  const results = [];
  for (const w of wallets) {
    if (!w.address) { results.push({ ...w, signals: 0, wins: 0, losses: 0 }); continue; }
    const pat = `%"walletLabel":"${w.label}"%`;
    const signals = Number(db.prepare(
      "SELECT COUNT(*) AS c FROM dry_run_positions WHERE snapshot_json LIKE ?"
    ).get(pat)?.c ?? 0);
    const wins = Number(db.prepare(
      "SELECT COUNT(*) AS c FROM dry_run_positions WHERE snapshot_json LIKE ? AND exit_class = 'win'"
    ).get(pat)?.c ?? 0);
    const losses = Number(db.prepare(
      "SELECT COUNT(*) AS c FROM dry_run_positions WHERE snapshot_json LIKE ? AND exit_class = 'loss'"
    ).get(pat)?.c ?? 0);
    results.push({ ...w, signals, wins, losses });
  }
  return results;
}
