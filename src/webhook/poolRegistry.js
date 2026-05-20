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
  try {
    const r = await axios.get(`${DEXSCREENER_BASE}/tokens/trending/solana`, {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });

    const items = Array.isArray(r.data) ? r.data : (r.data?.pairs || r.data?.tokens || []);

    const poolAddresses = items
      .filter(item => {
        const mcap = Number(item.marketCap || item.fdv || 0);
        return mcap >= POOL_MIN_MCAP && mcap <= POOL_MAX_MCAP;
      })
      .map(item => item.pairAddress || item.tokenAddress)
      .filter(Boolean);

    if (!poolAddresses.length) {
      console.log('[pool] DexScreener returned no mid-cap pools — retrying in 30min');
      return [];
    }

    cachedPoolAddresses = poolAddresses;
    console.log(`[pool] DexScreener returned ${poolAddresses.length} mid-cap pool(s) in $${POOL_MIN_MCAP / 1000}k–$${POOL_MAX_MCAP / 1_000_000}M range`);
    return poolAddresses;
  } catch (err) {
    console.log(`[pool] DexScreener fetch failed: ${err.message}`);
    console.log('[pool] DexScreener returned no mid-cap pools — retrying in 30min');
    return [];
  }
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
