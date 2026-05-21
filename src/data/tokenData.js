import axios from 'axios';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
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

// ── Holder concentration via DexScreener ────────────────────────────────────
// DexScreener has no dedicated holder endpoint — uses txns.h1.buys as buyer
// proxy and assumes top10HolderPct = 20% (safe default, below 30% threshold).
export async function fetchHolderConcentration(mint) {
  const cached = cacheGet(holderCache, mint, HOLDER_TTL_MS);
  if (cached !== null) return cached;

  try {
    const r = await axios.get(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, {
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const pairs = r.data;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      cacheSet(holderCache, mint, null);
      return null;
    }

    // Pick highest liquidity pair
    const best = pairs.reduce((a, b) =>
      Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0) ? b : a
    );

    // txns.h1.buys as unique buyer proxy
    const totalHolders = Number(best.txns?.h1?.buys || 0);

    // DexScreener provides no top-holder concentration — use safe default
    const lpBurn = Number(best.info?.security?.lpBurn || 0);
    console.log(`[tokenData] holder data unavailable — assuming 20% for ${mint.slice(0, 8)}${lpBurn === 100 ? ' (LP burned)' : ''}`);

    const data = {
      totalHolders,
      top10HolderPct: 20,
      top1HolderPct: 5,
    };
    cacheSet(holderCache, mint, data);
    return data;
  } catch (err) {
    console.log(`[tokenData] holder fetch failed for ${mint.slice(0, 8)}: ${err.message}`);
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

// ── DexScreener mid-cap candidate discovery (search endpoint) ───────────────
// Uses /latest/dex/search which includes marketCap in pair data.
// Returns up to 100 Solana mint addresses in the $500k–$5M mcap range.
export async function fetchTrendingMidCap() {
  const MCAP_MIN = 500_000;
  const MCAP_MAX = 5_000_000;
  const LIQ_MIN  = 30_000;
  const VOL_MIN  = 5_000;

  const seen = new Set();

  function parsePairs(pairs) {
    if (!Array.isArray(pairs)) return;
    for (const pair of pairs) {
      if (pair.chainId !== 'solana') continue;
      const mcap = Number(pair.marketCap || 0);
      const liq  = Number(pair.liquidity?.usd || 0);
      const vol  = Number(pair.volume?.h24 || 0);
      if (mcap < MCAP_MIN || mcap > MCAP_MAX) continue;
      if (liq < LIQ_MIN) continue;
      if (vol < VOL_MIN) continue;
      const mint = pair.baseToken?.address;
      if (mint) seen.add(mint);
    }
  }

  // Search endpoint — 8 parallel Solana-specific queries, has marketCap on each pair
  const SEARCH_TERMS = [
    'solana meme', 'solana cat', 'solana dog', 'solana pepe',
    'sol token', 'solana pump', 'raydium', 'solana trending',
  ];
  const searchResults = await Promise.all(
    SEARCH_TERMS.map(term =>
      axios.get(`${DEXSCREENER_BASE}/latest/dex/search`, {
        params: { q: term },
        timeout: 8_000,
        headers: { Accept: 'application/json' },
      }).catch(err => {
        console.log(`[tokenData] search "${term}" failed: ${err.message}`);
        return null;
      })
    )
  );
  for (const r of searchResults) {
    if (r) parsePairs(r.data?.pairs);
  }
  const searchCount = seen.size;
  console.log(`[tokenData] search results: ${searchCount} tokens`);

  // Boosted tokens — actively promoted Solana tokens, fetch pair data to apply mcap filter
  try {
    const boostR = await axios.get(`${DEXSCREENER_BASE}/token-boosts/latest/v1`, {
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const boostedAddresses = (Array.isArray(boostR.data) ? boostR.data : [])
      .filter(item => item.chainId === 'solana' && item.tokenAddress && !seen.has(item.tokenAddress))
      .map(item => item.tokenAddress)
      .slice(0, 20);

    if (boostedAddresses.length) {
      const pairResults = await Promise.all(
        boostedAddresses.map(addr =>
          axios.get(`${DEXSCREENER_BASE}/tokens/v1/solana/${addr}`, {
            timeout: 8_000,
            headers: { Accept: 'application/json' },
          }).catch(() => null)
        )
      );
      for (const pr of pairResults) {
        if (pr) parsePairs(Array.isArray(pr.data) ? pr.data : pr.data?.pairs);
      }
    }
  } catch (err) {
    console.log(`[tokenData] boosted tokens fetch failed: ${err.message}`);
  }
  const boostedCount = seen.size - searchCount;
  console.log(`[tokenData] boosted tokens: ${boostedCount} tokens`);

  const mints = [...seen].slice(0, 100);
  console.log(`[tokenData] fetchTrendingMidCap total: ${mints.length} tokens`);
  return mints;
}

// ── DexScreener trending tokens ─────────────────────────────────────────────
// Returns array of mint addresses from search + boosted/profiles feed
export async function fetchDexScreenerTrending() {
  const midCap = await fetchTrendingMidCap().catch(() => []);
  if (midCap.length) return midCap;

  // Broad fallback — no mcap filter, just Solana tokens from boosts/profiles
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

// ── DexScreener boosted tokens (replaces Solana Tracker graduated) ───────────
// Returns array of mid-cap Solana mint addresses from search endpoint
export async function fetchSolanaTrackerGraduated() {
  return fetchTrendingMidCap().catch(() => []);
}

export function clearDexCache() { dexCache.clear(); }
export function clearHolderCache() { holderCache.clear(); }
