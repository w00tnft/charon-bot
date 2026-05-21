import { webhookEmitter } from './heliusListener.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { openPositions } from '../db/positions.js';
import { escapeHtml } from '../format.js';

const MIN_MCAP_USD = 500_000;
const MAX_MCAP_USD = 5_000_000;
const POSITION_SIZE_SOL = 0.03;
const GAS_BUFFER_SOL = 0.01;

const recentSignals = new Map();
const DEDUP_WINDOW_MS = 30_000;

function isDuplicate(mint, solAmount) {
  const key = `${mint}-${Math.round(solAmount * 10)}`;
  const last = recentSignals.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  recentSignals.set(key, Date.now());
  for (const [k, t] of recentSignals.entries()) {
    if (Date.now() - t > DEDUP_WINDOW_MS) recentSignals.delete(k);
  }
  return false;
}

let candidateHandler = null;

export function setSignalCandidateHandler(fn) { candidateHandler = fn; }

export function attachSignalHandler() {
  webhookEmitter.on('signal', ({ mint, solAmount, sourceWallet, timestamp }) => {
    processWebhookSignal({ mint, solAmount, sourceWallet, timestamp })
      .catch(err => console.log(`[signal] handler error for ${mint.slice(0, 8)}: ${err.message}`));
  });
  console.log('[signal] Webhook signal handler attached');
}

async function processWebhookSignal({ mint: rawMint, solAmount, sourceWallet, timestamp }) {
  const mint = rawMint.replace(/[^a-zA-Z0-9]/g, '');
  if (mint !== rawMint) console.log(`[signal] sanitized mint: ${rawMint} → ${mint}`);
  const sym = mint.slice(0, 8);

  if (isDuplicate(mint, solAmount)) {
    console.log(`[signal] dedup — skipping repeat signal for ${sym}`);
    return;
  }

  // 1. Validate token is still in mid-cap range
  const asset = await fetchJupiterAsset(mint).catch(() => null);
  const mcap = Number(asset?.mcap || asset?.fdv || 0);
  if (!mcap || mcap < MIN_MCAP_USD || mcap > MAX_MCAP_USD) {
    console.log(`[signal] ${sym} skipped — mcap $${Math.round(mcap / 1000)}k outside $500k–$5M range`);
    return;
  }

  // 2. Check we don't already hold this token
  const existing = openPositions().find(p => p.mint === mint);
  if (existing) {
    console.log(`[signal] ${sym} skipped — already holding position #${existing.id}`);
    return;
  }

  // 3. Check wallet balance (best-effort — proceed if check fails)
  try {
    const { liveWalletPubkey } = await import('../liveExecutor.js');
    if (liveWalletPubkey) {
      const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const { SOLANA_RPC_URL } = await import('../config.js');
      const conn = new Connection(SOLANA_RPC_URL, 'confirmed');
      const bal = await conn.getBalance(new PublicKey(liveWalletPubkey));
      const balSol = bal / LAMPORTS_PER_SOL;
      if (balSol < POSITION_SIZE_SOL + GAS_BUFFER_SOL) {
        console.log(`[signal] ${sym} skipped — insufficient balance ${balSol.toFixed(4)} SOL (need ${POSITION_SIZE_SOL + GAS_BUFFER_SOL})`);
        return;
      }
    }
  } catch (err) {
    console.log(`[signal] balance check failed for ${sym}: ${err.message} — proceeding`);
  }

  const name = escapeHtml(asset?.name || sym);
  console.log(`[WEBHOOK SIGNAL] ${name} (${sym}…) — ${solAmount.toFixed(3)} SOL buy detected — executing`);

  if (!candidateHandler) {
    console.log(`[signal] no candidate handler set — signal dropped`);
    return;
  }

  await candidateHandler({
    mint,
    route: 'webhook',
    source: 'helius_webhook',
    trendingToken: {
      address: mint,
      name: asset?.name || '',
      symbol: asset?.symbol || '',
      market_cap: mcap,
      price: asset?.usdPrice,
      seenAt: timestamp,
    },
  });
}
