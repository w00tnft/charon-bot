import axios from 'axios';
import { BIRDEYE_API_KEY } from '../config.js';

const BASE = 'https://public-api.birdeye.so';
const JUPITER_QUOTE_BASE = 'https://quote-api.jup.ag/v6';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const POOL_MIN_MCAP = 500_000;
const POOL_MAX_MCAP = 5_000_000;
const REFRESH_MS = Number(process.env.POOL_REFRESH_INTERVAL_MS || 1_800_000);
const MAX_TOKENS = 50; // cap to avoid Jupiter rate limits

let cachedPoolAddresses = [];
let webhookId = null;

export function setWebhookId(id) { webhookId = id; }
export function getPoolAddresses() { return cachedPoolAddresses; }

async function fetchMidCapTokens() {
  if (!BIRDEYE_API_KEY) {
    console.log('[pool] BIRDEYE_API_KEY not set — pool registry disabled');
    return [];
  }
  try {
    const r = await axios.get(`${BASE}/defi/tokenlist`, {
      params: {
        sort_by: 'mc',
        sort_type: 'desc',
        min_marketcap: POOL_MIN_MCAP,
        max_marketcap: POOL_MAX_MCAP,
        limit: 100,
        offset: 0,
      },
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana', Accept: 'application/json' },
      timeout: 10_000,
    });
    const tokens = (r.data?.data?.tokens || []).map(t => t.address).filter(Boolean);
    console.log(`[pool] Birdeye returned ${tokens.length} token(s) in $${POOL_MIN_MCAP / 1000}k–$${POOL_MAX_MCAP / 1_000_000}M range`);
    return tokens;
  } catch (err) {
    console.log(`[pool] Birdeye fetch failed: ${err.message}`);
    return [];
  }
}

async function resolvePoolAddress(tokenMint) {
  try {
    const r = await axios.get(`${JUPITER_QUOTE_BASE}/quote`, {
      params: {
        inputMint: WSOL_MINT,
        outputMint: tokenMint,
        amount: '1000000000', // 1 SOL
        onlyDirectRoutes: 'true',
      },
      timeout: 5_000,
    });
    // Jupiter route plan exposes the AMM pool key in swapInfo.ammKey
    return r.data?.routePlan?.[0]?.swapInfo?.ammKey || null;
  } catch {
    return null;
  }
}

export async function fetchMidCapPools() {
  console.log('[pool] Resolving mid-cap pool addresses...');
  const tokens = await fetchMidCapTokens();
  if (!tokens.length) return [];

  const poolAddresses = [];
  for (const mint of tokens.slice(0, MAX_TOKENS)) {
    const pool = await resolvePoolAddress(mint);
    if (pool) poolAddresses.push(pool);
    await new Promise(r => setTimeout(r, 100)); // avoid Jupiter rate limit
  }

  cachedPoolAddresses = poolAddresses;
  console.log(`[pool] Resolved ${poolAddresses.length}/${Math.min(tokens.length, MAX_TOKENS)} pool addresses`);
  return poolAddresses;
}

async function refreshPools() {
  const pools = await fetchMidCapPools();
  if (pools.length && webhookId) {
    const { updateWebhookAddresses } = await import('./registerWebhooks.js');
    await updateWebhookAddresses(webhookId, pools).catch(err =>
      console.log(`[pool] webhook update failed: ${err.message}`)
    );
  }
}

export function startPoolRefreshInterval() {
  setInterval(
    () => refreshPools().catch(err => console.log(`[pool] refresh error: ${err.message}`)),
    REFRESH_MS,
  );
  console.log(`[pool] Pool refresh scheduled every ${Math.round(REFRESH_MS / 60_000)}min`);
}
