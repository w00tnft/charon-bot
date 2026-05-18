import axios from 'axios';
import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { HELIUS_API_KEY } from '../config.js';

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

async function fetchWalletSwaps(address, { verbose = false } = {}) {
  // Primary: Helius enhanced transactions API (no Cloudflare blocking)
  if (HELIUS_API_KEY) {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions`;
    if (verbose) console.log(`[smart] calling: ${url}?api-key=***&limit=10&type=SWAP`);
    try {
      const r = await axios.get(url, {
        params: { 'api-key': HELIUS_API_KEY, limit: 10, type: 'SWAP' },
        timeout: 5_000,
      });
      const txs = r.data || [];
      if (verbose) {
        console.log(`[smart] test response: status=200 length=${txs.length} firstTx=${JSON.stringify(txs[0] || {}).slice(0, 120)}`);
      }
      return { source: 'helius', txs };
    } catch (err) {
      if (verbose) console.log(`[smart] test response: status=${err.response?.status || 'err'} ${err.message}`);
      else console.log(`[smart] helius ${address.slice(0, 8)}: ${err.response?.status || ''} ${err.message}`);
    }
  }

  // Fallback: Solscan public API
  try {
    const r = await axios.get('https://public-api.solscan.io/account/transactions', {
      params: { account: address, limit: 10 },
      headers: { Accept: 'application/json' },
      timeout: 5_000,
    });
    return { source: 'solscan', txs: r.data || [] };
  } catch (err) {
    console.log(`[smart] solscan ${address.slice(0, 8)}: ${err.response?.status || ''} ${err.message}`);
  }

  return { source: null, txs: [] };
}

function parseHeliusSwaps(txs, walletAddress, cutoff) {
  const results = [];
  for (const tx of txs) {
    const ts = Number(tx.timestamp || 0) * 1000;
    if (ts < cutoff) continue;
    if (tx.type !== 'SWAP') continue;

    // Token received by wallet in this swap
    const received = (tx.tokenTransfers || []).find(
      t => t.toUserAccount === walletAddress && t.mint
    );
    if (!received) continue;

    // SOL spent from wallet (lamports → SOL)
    const solSpentLam = (tx.nativeTransfers || [])
      .filter(t => t.fromUserAccount === walletAddress)
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    results.push({
      mint: received.mint,
      symbol: received.tokenSymbol || '',
      buyAmount: solSpentLam / 1e9,
    });
  }
  return results;
}

export async function pollSmartWallets() {
  console.log('[smart] poll tick');

  if (!HELIUS_API_KEY) {
    console.log('[smart] poll skipped — HELIUS_API_KEY not set');
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

  for (const { address, label } of wallets) {
    try {
      const cutoff = now() - 60_000;
      const { source, txs } = await fetchWalletSwaps(address);
      const swaps = source === 'helius' ? parseHeliusSwaps(txs, address, cutoff) : [];
      console.log(`[smart] ${label}: ${swaps.length} recent swap(s) via ${source || 'none'}`);

      for (const { mint, symbol, buyAmount } of swaps) {
        const key = `${address}:${mint}`;
        if (seenSmartSignals.has(key)) continue;
        seenSmartSignals.set(key, now());

        console.log(`[smart] ${label} bought $${symbol || mint.slice(0, 8)} — ${buyAmount.toFixed(3)} SOL`);

        db.prepare(
          'UPDATE smart_wallets SET total_trades = total_trades + 1, last_seen = ? WHERE address = ?'
        ).run(new Date().toISOString(), address);

        if (candidateHandler) {
          await candidateHandler({
            mint,
            route: 'smart_money',
            source: 'smart_money',
            trendingToken: { address: mint, symbol, seenAt: now() },
            smartMoneySignal: { walletLabel: label, walletAddress: address, buyAmount },
          }).catch(err => console.log(`[smart] pipeline error: ${err.message}`));
        }
      }
    } catch (err) {
      console.log(`[smart] ${label} (${address.slice(0, 8)}…): ${err.message}`);
    }
  }
}

export async function testSmartMoneyConnection() {
  if (!HELIUS_API_KEY) {
    console.log('[smart] test skipped — HELIUS_API_KEY not set');
    return;
  }
  const first = db.prepare(
    "SELECT address, label FROM smart_wallets WHERE active = 1 AND address IS NOT NULL LIMIT 1"
  ).get();
  if (!first) {
    console.log('[smart] test skipped — no wallets in smart_wallets table');
    return;
  }
  console.log(`[smart] testing Helius connection for ${first.label} (${first.address.slice(0, 8)}…)`);
  await fetchWalletSwaps(first.address, { verbose: true });
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
