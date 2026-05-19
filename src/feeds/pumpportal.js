import WebSocket from 'ws';
import { now } from '../utils.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';

const SURVIVOR_WAIT_MS = 3 * 60_000;       // wait 3 min before checking
const SURVIVOR_MAX_AGE_MS = 10 * 60_000;   // discard pending tokens older than 10 min
const SURVIVOR_CHECK_INTERVAL_MS = 30_000; // poll pending tokens every 30s
const SURVIVOR_MCAP_RATIO = 0.7;           // must retain 70% of initial mcap
// PumpPortal gives SOL mcap; Jupiter gives USD mcap. Use approx SOL price for ratio comparison.
const ROUGH_SOL_USD = 150;

let candidateHandler = null;
let retries = 0;
const MAX_RETRIES = 10;

export function setCandidateHandler(fn) { candidateHandler = fn; }

// Track buy timestamps per token for hot detection
const recentBuys = new Map(); // mint → number[]

// Tokens awaiting 3-min survivor check before entering the pipeline
const pendingTokens = new Map(); // mint → { symbol, name, initialMcapSol, receivedAt, pumpPortalData }

function trackBuy(mint, symbol) {
  const ts = now();
  const buys = recentBuys.get(mint) || [];
  buys.push(ts);
  const cutoff = ts - 60_000;
  const recent = buys.filter(t => t >= cutoff);
  recentBuys.set(mint, recent);
  if (recent.length === 10) {
    console.log(`[pump] $${symbol || mint.slice(0, 8)} HOT — 10 buys in 60s`);
  }
  if (recentBuys.size > 2000) {
    const expire = ts - 120_000;
    for (const [m, ts2] of recentBuys) {
      if (!ts2.some(t => t >= expire)) recentBuys.delete(m);
    }
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // New token event — store for survivor check, do NOT push to pipeline immediately
  if (msg.txType === 'create') {
    const mint = msg.mint;
    if (!mint) return;
    const symbol = msg.symbol || '';
    const name = msg.name || '';

    // marketCapSol is already in SOL (not lamports) — display directly
    const marketCapSol = Number(msg.marketCapSol || msg.vSolInBondingCurve || 0);

    // initialBuy is in lamports — convert to SOL
    const initialBuyLamports = Number(msg.initialBuy || msg.solAmount || 0);
    const initialBuySol = initialBuyLamports / 1_000_000_000;

    const devWallet = msg.traderPublicKey || '';
    // PumpPortal sends Unix seconds; fall back to now
    const timestamp = msg.timestamp ? Number(msg.timestamp) * 1000 : now();

    console.log(`[pump] new token: $${symbol} mcap: ${marketCapSol.toFixed(1)} SOL dev: ${initialBuySol.toFixed(3)} SOL → pending 3min survivor check`);

    if (initialBuySol < 0.5) return;        // dev not committed enough
    if (now() - timestamp > 30_000) return; // stale event

    pendingTokens.set(mint, {
      symbol,
      name,
      initialMcapSol: marketCapSol,
      receivedAt: now(),
      pumpPortalData: { devWallet, initialBuySol, marketCapSol, timestamp },
    });
    return;
  }

  // Trade event
  if (msg.txType === 'buy' && msg.mint) {
    trackBuy(msg.mint, msg.symbol || '');
  }
}

async function checkPendingTokens() {
  if (!candidateHandler || pendingTokens.size === 0) return;
  const ts = now();

  for (const [mint, entry] of pendingTokens) {
    const age = ts - entry.receivedAt;

    // Too fresh — check on next tick
    if (age < SURVIVOR_WAIT_MS) continue;

    // Remove from pending before async work to prevent double-processing
    pendingTokens.delete(mint);

    // Expired without passing survivor check — drop silently
    if (age > SURVIVOR_MAX_AGE_MS) continue;

    try {
      const asset = await fetchJupiterAsset(mint).catch(() => null);
      // Jupiter returns USD mcap; convert to approximate SOL for comparison
      const currentMcapUsd = Number(asset?.mcap || asset?.fdv || 0);
      const currentMcapSol = currentMcapUsd / ROUGH_SOL_USD;
      const thresholdSol = entry.initialMcapSol * SURVIVOR_MCAP_RATIO;
      const sym = entry.symbol || mint.slice(0, 8);

      if (currentMcapUsd > 0 && currentMcapSol >= thresholdSol) {
        console.log(`[pump] $${sym} survived 3min — initial: ${entry.initialMcapSol.toFixed(1)} SOL current: ${currentMcapSol.toFixed(1)} SOL → sending to pipeline ✅`);
        await candidateHandler({
          mint,
          route: 'pumpportal_survivor',
          source: 'pumpportal_survivor',
          trendingToken: {
            address: mint,
            name: entry.name,
            symbol: entry.symbol,
            market_cap: currentMcapUsd,
            price: asset?.usdPrice,
            seenAt: ts,
          },
          pumpPortalData: entry.pumpPortalData,
        });
      } else {
        console.log(`[pump] $${sym} dropped — rugged after 3min initial: ${entry.initialMcapSol.toFixed(1)} SOL current: ${currentMcapSol.toFixed(1)} SOL ❌`);
      }
    } catch (err) {
      console.log(`[pump] survivor check error for ${mint.slice(0, 8)}: ${err.message}`);
    }
  }
}

export function startPumpPortal() {
  // Start survivor check loop
  setInterval(
    () => checkPendingTokens().catch(err => console.log(`[pump] survivor check: ${err.message}`)),
    SURVIVOR_CHECK_INTERVAL_MS,
  );

  function connect() {
    if (retries >= MAX_RETRIES) {
      console.log('[pump] max retries reached — PumpPortal feed disabled');
      return;
    }

    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
      console.log('[pump] connected to PumpPortal');
      retries = 0;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: ['all'] }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handleMessage(msg).catch(err => console.log(`[pump] ${err.message}`));
    });

    ws.on('close', () => {
      retries++;
      console.log(`[pump] disconnected, reconnecting in 5s (${retries}/${MAX_RETRIES})...`);
      setTimeout(connect, 5_000);
    });

    ws.on('error', err => console.log(`[pump] error: ${err.message}`));
  }

  connect();
}
