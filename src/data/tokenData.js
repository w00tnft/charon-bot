import axios from 'axios';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const SOLANA_TRACKER_BASE = 'https://data.solanatracker.io';
const HELIUS_DAS_BASE = 'https://mainnet.helius-rpc.com';

const DEXSCREENER_TTL_MS = 15 * 60_000; // 15 min
const HOLDER_TTL_MS = 30 * 60_000;       // 30 min

const dexCache = new Map();   // mint → { data, ts }
const holderCache = new Map(); // mint → { data, ts }

function cacheGet(map, key, ttl) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { map.delete(key); return null; }
  return entry.data;
}
function cacheSet(map, key, data) { map.set(key, { data, ts: Date.now() }); }

// ── DexScreener token data ──────────────────────────────────────────────────
// Returns null on failure (fail-safe)
export async function fetchDexScreenerToken(mint) {
  const cached = cacheGet(dexCache, mint, DEXSCREENER_TTL_MS);
  if (cached !== null) return cached;

  try {
    const r = await axios.get(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, {
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const pairs = r.data;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      cacheSet(dexCache, mint, null);
      return null;
    }

    // Pick the pair with highest liquidity
    const best = pairs.reduce((a, b) =>
      Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0) ? b : a
    );

    const data = {
      mint,
      pairAddress: best.pairAddress,
      dexId: best.dexId,
      name: best.baseToken?.name || '',
      symbol: best.baseToken?.symbol || '',
      priceUsd: Number(best.priceUsd || 0),
      liquidityUsd: Number(best.liquidity?.usd || 0),
      marketCapUsd: Number(best.marketCap || best.fdv || 0),
      volume24h: Number(best.volume?.h24 || 0),
      volume6h: Number(best.volume?.h6 || 0),
      volume1h: Number(best.volume?.h1 || 0),
      txns24hBuys: Number(best.txns?.h24?.buys || 0),
      txns24hSells: Number(best.txns?.h24?.sells || 0),
      txns1hBuys: Number(best.txns?.h1?.buys || 0),
      txns1hSells: Number(best.txns?.h1?.sells || 0),
      priceChange1h: Number(best.priceChange?.h1 || 0),
      priceChange6h: Number(best.priceChange?.h6 || 0),
      priceChange24h: Number(best.priceChange?.h24 || 0),
      // Token creation time from DexScreener (ms epoch)
      createdAtMs: best.pairCreatedAt ? Number(best.pairCreatedAt) : null,
      // Raw flags
      mintAuthority: best.info?.security?.mintAuthorityDisabled === true ? false
        : best.info?.security?.mintAuthorityDisabled === false ? true : null,
      freezeAuthority: best.info?.security?.freezeAuthorityDisabled === true ? false
        : best.info?.security?.freezeAuthorityDisabled === false ? true : null,
    };

    cacheSet(dexCache, mint, data);
    return data;
  } catch (err) {
    console.log(`[tokenData] DexScreener fetch failed for ${mint.slice(0, 8)}: ${err.message}`);
    cacheSet(dexCache, mint, null);
    return null;
  }
}

// ── Solana Tracker holder concentration ────────────────────────────────────
// Returns null on failure (fail-safe)
export async function fetchHolderConcentration(mint) {
  const cached = cacheGet(holderCache, mint, HOLDER_TTL_MS);
  if (cached !== null) return cached;

  try {
    const r = await axios.get(`${SOLANA_TRACKER_BASE}/tokens/${mint}/holders`, {
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const holders = r.data?.holders || r.data;
    if (!Array.isArray(holders) || holders.length === 0) {
      cacheSet(holderCache, mint, null);
      return null;
    }

    const totalSupply = holders.reduce((s, h) => s + Number(h.amount || h.balance || 0), 0);
    if (!totalSupply) {
      cacheSet(holderCache, mint, null);
      return null;
    }

    const sorted = [...holders].sort((a, b) =>
      Number(b.amount || b.balance || 0) - Number(a.amount || a.balance || 0)
    );
    const top10 = sorted.slice(0, 10);
    const top10Sum = top10.reduce((s, h) => s + Number(h.amount || h.balance || 0), 0);
    const top10Pct = (top10Sum / totalSupply) * 100;

    const top1 = sorted[0] ? Number(sorted[0].amount || sorted[0].balance || 0) / totalSupply * 100 : 0;

    const data = {
      totalHolders: holders.length,
      top10HolderPct: Math.round(top10Pct * 10) / 10,
      top1HolderPct: Math.round(top1 * 10) / 10,
    };
    cacheSet(holderCache, mint, data);
    return data;
  } catch (err) {
    console.log(`[tokenData] Solana Tracker holder fetch failed for ${mint.slice(0, 8)}: ${err.message}`);
    cacheSet(holderCache, mint, null);
    return null;
  }
}

// ── Helius DAS backup (mint/freeze authority) ───────────────────────────────
export async function fetchHeliusDasToken(mint) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await axios.post(
      `${HELIUS_DAS_BASE}/?api-key=${apiKey}`,
      { jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } },
      { timeout: 6_000 }
    );
    const asset = r.data?.result;
    if (!asset) return null;
    return {
      mintAuthority: asset.authorities?.find(a => a.scopes?.includes('mint')) ? true : false,
      freezeAuthority: asset.supply?.print_disabled === false ? true : false,
      name: asset.content?.metadata?.name || '',
      symbol: asset.content?.metadata?.symbol || '',
    };
  } catch {
    return null;
  }
}

// ── Unified token data ──────────────────────────────────────────────────────
// Combines DexScreener + Solana Tracker + Helius DAS. Always fail-safe.
export async function fetchTokenData(mint) {
  const [dex, holders, das] = await Promise.all([
    fetchDexScreenerToken(mint).catch(() => null),
    fetchHolderConcentration(mint).catch(() => null),
    fetchHeliusDasToken(mint).catch(() => null),
  ]);

  return {
    mint,
    dex: dex || null,
    holders: holders || null,
    das: das || null,
    // Convenience getters
    liquidityUsd: dex?.liquidityUsd ?? 0,
    marketCapUsd: dex?.marketCapUsd ?? 0,
    priceUsd: dex?.priceUsd ?? 0,
    volume24h: dex?.volume24h ?? 0,
    volume1h: dex?.volume1h ?? 0,
    buySellRatio1h: dex && (dex.txns1hBuys + dex.txns1hSells) > 0
      ? dex.txns1hBuys / (dex.txns1hBuys + dex.txns1hSells)
      : null,
    priceChange1h: dex?.priceChange1h ?? null,
    priceChange24h: dex?.priceChange24h ?? null,
    ageHours: dex?.createdAtMs
      ? (Date.now() - dex.createdAtMs) / 3_600_000
      : null,
    top10HolderPct: holders?.top10HolderPct ?? null,
    top1HolderPct: holders?.top1HolderPct ?? null,
    mintAuthorityEnabled: dex?.mintAuthority ?? das?.mintAuthority ?? null,
    freezeAuthorityEnabled: dex?.freezeAuthority ?? das?.freezeAuthority ?? null,
  };
}

// ── DexScreener trending tokens ─────────────────────────────────────────────
// Returns array of mint addresses from boosted/trending feed
export async function fetchDexScreenerTrending() {
  try {
    const [boostedR, profilesR] = await Promise.allSettled([
      axios.get(`${DEXSCREENER_BASE}/token-boosts/top/v1`, { timeout: 8_000 }),
      axios.get(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, { timeout: 8_000 }),
    ]);

    const mints = new Set();

    if (boostedR.status === 'fulfilled') {
      const items = Array.isArray(boostedR.value.data) ? boostedR.value.data : [];
      for (const item of items) {
        if (item.chainId === 'solana' && item.tokenAddress) mints.add(item.tokenAddress);
      }
    }

    if (profilesR.status === 'fulfilled') {
      const items = Array.isArray(profilesR.value.data) ? profilesR.value.data : [];
      for (const item of items) {
        if (item.chainId === 'solana' && item.tokenAddress) mints.add(item.tokenAddress);
      }
    }

    return [...mints];
  } catch (err) {
    console.log(`[tokenData] DexScreener trending fetch failed: ${err.message}`);
    return [];
  }
}

// ── Solana Tracker graduated tokens ─────────────────────────────────────────
// Returns array of mint addresses for recently graduated tokens
export async function fetchSolanaTrackerGraduated() {
  try {
    const r = await axios.get(`${SOLANA_TRACKER_BASE}/tokens/trending`, {
      params: { timeframe: '24h', limit: 100 },
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const tokens = r.data?.tokens || r.data || [];
    return tokens
      .filter(t => t.address || t.mint)
      .map(t => t.address || t.mint)
      .filter(Boolean);
  } catch (err) {
    console.log(`[tokenData] Solana Tracker graduated fetch failed: ${err.message}`);
    return [];
  }
}

export function clearDexCache() { dexCache.clear(); }
export function clearHolderCache() { holderCache.clear(); }
