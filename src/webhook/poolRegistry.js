import axios from 'axios';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const POOL_MIN_MCAP = 500_000;
const POOL_MAX_MCAP = 5_000_000;
const POOL_MIN_LIQ  = 30_000;
const REFRESH_MS = Number(process.env.POOL_REFRESH_INTERVAL_MS || 1_800_000);

const SEARCH_TERMS = ['solana', 'SOL', 'meme', 'cat', 'dog', 'pepe'];

let cachedPoolAddresses = [];
let webhookId = null;

export function setWebhookId(id) { webhookId = id; }
export function getPoolAddresses() { return cachedPoolAddresses; }

export async function fetchMidCapPools() {
  console.log('[pool] Fetching mid-cap pool addresses from DexScreener search...');

  // STEP 1 — DexScreener /latest/dex/search (pairs have marketCap field)
  const seen = new Set();
  const poolAddresses = [];
  let sampleLogged = false;

  const results = await Promise.allSettled(
    SEARCH_TERMS.map(term =>
      axios.get(`${DEXSCREENER_BASE}/latest/dex/search`, {
        params: { q: term },
        timeout: 8_000,
        headers: { Accept: 'application/json' },
      })
    )
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const pairs = result.value.data?.pairs || [];
    for (const pair of pairs) {
      if (pair.chainId !== 'solana') continue;
      const mcap = Number(pair.marketCap || 0);
      const liq  = Number(pair.liquidity?.usd || 0);
      if (mcap < POOL_MIN_MCAP || mcap > POOL_MAX_MCAP) continue;
      if (liq < POOL_MIN_LIQ) continue;
      const addr = pair.pairAddress;
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      poolAddresses.push(addr);

      if (!sampleLogged) {
        const sym   = pair.baseToken?.symbol || '?';
        const mcapM = (mcap / 1_000_000).toFixed(2);
        const liqK  = Math.round(liq / 1000);
        console.log(`[pool] Sample pair: $${sym} mcap $${mcapM}M liq $${liqK}k ✓`);
        sampleLogged = true;
      }
    }
  }

  if (poolAddresses.length) {
    cachedPoolAddresses = poolAddresses;
    console.log(`[pool] Found ${poolAddresses.length} mid-cap pools to watch`);
    return poolAddresses;
  }

  // STEP 2 — Jupiter strict token list fallback
  console.log('[pool] DexScreener search returned no mid-cap pools — trying Jupiter fallback');
  try {
    const r = await axios.get('https://token.jup.ag/strict', { timeout: 10_000 });
    const tokens = Array.isArray(r.data) ? r.data : [];
    const fallbackAddresses = tokens
      .filter(t => Array.isArray(t.tags) && t.tags.includes('community'))
      .map(t => t.address)
      .filter(Boolean)
      .slice(0, 30);
    if (fallbackAddresses.length) {
      cachedPoolAddresses = fallbackAddresses;
      console.log(`[pool] Jupiter fallback: ${fallbackAddresses.length} community token(s) as watch targets`);
      return fallbackAddresses;
    }
  } catch (err) {
    console.log(`[pool] Jupiter fallback failed: ${err.message}`);
  }

  console.log('[pool] No mid-cap pools found — webhook running without pool filter');
  return [];
}

async function refreshPools() {
  const pools = await fetchMidCapPools();
  if (!pools.length) return;
  const { updateWebhookAddresses, registerWebhook } = await import('./registerWebhooks.js');
  if (webhookId) {
    await updateWebhookAddresses(webhookId, pools).catch(err =>
      console.log(`[pool] webhook update failed: ${err.message}`)
    );
  } else {
    // Initial registration was skipped (no addresses) — try now
    const id = await registerWebhook(pools).catch(err => {
      console.log(`[pool] webhook registration retry failed: ${err.message}`);
      return null;
    });
    if (id) {
      webhookId = id;
      console.log(`[pool] Webhook registered on retry — id: ${id}`);
    }
  }
}

export function startPoolRefreshInterval() {
  setInterval(
    () => refreshPools().catch(err => console.log(`[pool] refresh error: ${err.message}`)),
    REFRESH_MS,
  );
  console.log(`[pool] Pool refresh scheduled every ${Math.round(REFRESH_MS / 60_000)}min`);
}
