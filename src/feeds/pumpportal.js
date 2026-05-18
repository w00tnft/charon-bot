import WebSocket from 'ws';
import { now } from '../utils.js';

let candidateHandler = null;
let retries = 0;
const MAX_RETRIES = 10;

export function setCandidateHandler(fn) { candidateHandler = fn; }

// Track buy timestamps per token for hot detection
const recentBuys = new Map(); // mint → number[]

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
  // Prune stale tokens from the map
  if (recentBuys.size > 2000) {
    const expire = ts - 120_000;
    for (const [m, ts2] of recentBuys) {
      if (!ts2.some(t => t >= expire)) recentBuys.delete(m);
    }
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // New token event
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

    console.log(`[pump] new token: $${symbol} mcap: ${marketCapSol.toFixed(1)} SOL dev: ${initialBuySol.toFixed(3)} SOL`);

    if (initialBuySol < 0.5) return;        // dev not committed enough
    if (now() - timestamp > 30_000) return; // stale event

    if (candidateHandler) {
      await candidateHandler({
        mint,
        route: 'pumpportal',
        source: 'pumpportal',
        trendingToken: {
          address: mint,
          name,
          symbol,
          market_cap: marketCapSol,
          seenAt: now(),
        },
        pumpPortalData: { devWallet, initialBuySol, marketCapSol, timestamp },
      });
    }
    return;
  }

  // Trade event
  if (msg.txType === 'buy' && msg.mint) {
    trackBuy(msg.mint, msg.symbol || '');
  }
}

export function startPumpPortal() {
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
