import axios from 'axios';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const POOL_MIN_MCAP = 500_000;
const POOL_MAX_MCAP = 5_000_000;
const REFRESH_MS = Number(process.env.POOL_REFRESH_INTERVAL_MS || 1_800_000);

let cachedPoolAddresses = [];
let webhookId = null;

export function setWebhookId(id) { webhookId = id; }
export function getPoolAddresses() { return cachedPoolAddresses; }

export async function fetchMidCapPools() {
  console.log('[pool] Fetching mid-cap pool addresses from DexScreener...');

  function extractAddresses(items) {
    return items
      .filter(item => {
        if (item.chainId && item.chainId !== 'solana') return false;
        const mcap = Number(item.marketCap || item.fdv || 0);
        return mcap >= POOL_MIN_MCAP && mcap <= POOL_MAX_MCAP;
      })
      .map(item => item.tokenAddress || item.pairAddress)
      .filter(Boolean);
  }

  // Primary — latest token profiles
  try {
    const r = await axios.get(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });
    const items = Array.isArray(r.data) ? r.data : [];
    const poolAddresses = extractAddresses(items.filter(i => i.chainId === 'solana'));
    if (poolAddresses.length) {
      cachedPoolAddresses = poolAddresses;
      console.log(`[pool] token-profiles: ${poolAddresses.length} mid-cap pool(s) in $${POOL_MIN_MCAP / 1000}k–$${POOL_MAX_MCAP / 1_000_000}M range`);
      return poolAddresses;
    }
    console.log('[pool] token-profiles returned no mid-cap pools — trying boosted fallback');
  } catch (err) {
    console.log(`[pool] token-profiles fetch failed: ${err.message} — trying boosted fallback`);
  }

  // Fallback — boosted tokens
  try {
    const r = await axios.get(`${DEXSCREENER_BASE}/token-boosts/top/v1`, {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });
    const items = Array.isArray(r.data) ? r.data : [];
    const poolAddresses = extractAddresses(items.filter(i => i.chainId === 'solana'));
    if (poolAddresses.length) {
      cachedPoolAddresses = poolAddresses;
      console.log(`[pool] token-boosts: ${poolAddresses.length} mid-cap pool(s) in $${POOL_MIN_MCAP / 1000}k–$${POOL_MAX_MCAP / 1_000_000}M range`);
      return poolAddresses;
    }
  } catch (err) {
    console.log(`[pool] token-boosts fetch failed: ${err.message}`);
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
