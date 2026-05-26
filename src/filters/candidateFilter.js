import { fetchTokenData } from '../data/tokenData.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';

// Filter thresholds — all overridable by env vars
const MIN_LIQUIDITY_USD     = Number(process.env.FILTER_MIN_LIQUIDITY_USD     || 50_000);
const MIN_TOKEN_AGE_HOURS   = Number(process.env.FILTER_MIN_TOKEN_AGE_HOURS   || 24);
const MAX_TOP10_HOLDER_PCT  = Number(process.env.FILTER_MAX_TOP10_HOLDER_PCT  || 30);
const MAX_DEV_WALLET_PCT    = Number(process.env.FILTER_MAX_DEV_WALLET_PCT    || 10);
const MIN_VOLUME_MCAP_RATIO = Number(process.env.FILTER_MIN_VOLUME_MCAP_RATIO || 0.08);
const MIN_BUY_SELL_RATIO    = Number(process.env.FILTER_MIN_BUY_SELL_RATIO    || 1.6);
const MIN_MOMENTUM_SIGNALS  = Number(process.env.FILTER_MIN_MOMENTUM_SIGNALS  || 3);
const MAX_SLIPPAGE_PCT      = Number(process.env.FILTER_MAX_SLIPPAGE_PCT      || 2.0);
const FILTER_MCAP_MIN       = Number(process.env.FILTER_MIN_MCAP) || 10_000;
const FILTER_MCAP_MAX       = Number(process.env.FILTER_MAX_MCAP) || 700_000;

// Filter pass/fail tracker for Telegram /filterstat
let filterStats = {
  total: 0,
  layer1Pass: 0, layer1Fail: 0,
  layer2Pass: 0, layer2Fail: 0,
  layer3Pass: 0, layer3Fail: 0,
  layer1Reasons: {},
  layer2Reasons: {},
  layer3Reasons: {},
};

function trackFail(layer, reason) {
  filterStats[`layer${layer}Fail`]++;
  const key = `layer${layer}Reasons`;
  filterStats[key][reason] = (filterStats[key][reason] || 0) + 1;
}

export function getFilterStats() { return { ...filterStats }; }
export function resetFilterStats() {
  filterStats = {
    total: 0,
    layer1Pass: 0, layer1Fail: 0,
    layer2Pass: 0, layer2Fail: 0,
    layer3Pass: 0, layer3Fail: 0,
    layer1Reasons: {},
    layer2Reasons: {},
    layer3Reasons: {},
  };
}

// ── Layer 1: Basic safety (fast, no Jupiter needed) ──────────────────────
// Liquidity, age, mint/freeze authority, mcap range
function layer1Check(tokenData) {
  const failures = [];

  if (tokenData.liquidityUsd < MIN_LIQUIDITY_USD) {
    failures.push(`liquidity $${Math.round(tokenData.liquidityUsd / 1000)}k < $${MIN_LIQUIDITY_USD / 1000}k`);
  }

  if (tokenData.ageHours !== null && tokenData.ageHours < MIN_TOKEN_AGE_HOURS) {
    failures.push(`age ${tokenData.ageHours.toFixed(1)}h < ${MIN_TOKEN_AGE_HOURS}h`);
  }

  if (tokenData.mintAuthorityEnabled === true) {
    failures.push('mint authority enabled (rug risk)');
  }

  if (tokenData.freezeAuthorityEnabled === true) {
    failures.push('freeze authority enabled (rug risk)');
  }

  if (tokenData.marketCapUsd > 0) {
    if (tokenData.marketCapUsd < FILTER_MCAP_MIN) {
      failures.push(`mcap $${Math.round(tokenData.marketCapUsd / 1000)}k < $${FILTER_MCAP_MIN / 1000}k`);
    }
    if (tokenData.marketCapUsd > FILTER_MCAP_MAX) {
      failures.push(`mcap $${Math.round(tokenData.marketCapUsd / 1_000_000)}M > $${FILTER_MCAP_MAX / 1_000_000}M`);
    }
  }

  return failures;
}

// ── Layer 2: Quality signals (momentum / holder concentration) ────────────
function layer2Check(tokenData) {
  const failures = [];

  // Top holder concentration
  if (tokenData.top10HolderPct !== null && tokenData.top10HolderPct > MAX_TOP10_HOLDER_PCT) {
    failures.push(`top10 holders ${tokenData.top10HolderPct.toFixed(1)}% > ${MAX_TOP10_HOLDER_PCT}%`);
  }

  // Dev wallet concentration (top 1 holder as proxy)
  if (tokenData.top1HolderPct !== null && tokenData.top1HolderPct > MAX_DEV_WALLET_PCT) {
    failures.push(`top1 holder ${tokenData.top1HolderPct.toFixed(1)}% > ${MAX_DEV_WALLET_PCT}%`);
  }

  // Volume/mcap ratio — minimum momentum
  if (tokenData.marketCapUsd > 0 && tokenData.volume24h >= 0) {
    const ratio = tokenData.volume24h / tokenData.marketCapUsd;
    if (ratio < MIN_VOLUME_MCAP_RATIO) {
      failures.push(`vol/mcap ${(ratio * 100).toFixed(1)}% < ${(MIN_VOLUME_MCAP_RATIO * 100).toFixed(0)}%`);
    }
  }

  // Buy/sell ratio — buying pressure
  if (tokenData.buySellRatio1h !== null) {
    if (tokenData.buySellRatio1h < MIN_BUY_SELL_RATIO / (1 + MIN_BUY_SELL_RATIO)) {
      failures.push(`buy/sell ratio ${tokenData.buySellRatio1h.toFixed(2)} — more sells than buys`);
    }
  }

  // Momentum signals count
  const dex = tokenData.dex;
  if (dex) {
    let signals = 0;
    if (dex.priceChange1h > 2) signals++;       // positive 1h price action
    if (dex.priceChange6h > 5) signals++;       // sustained momentum
    if (dex.volume1h > dex.volume24h / 24 * 2) signals++; // above-avg hourly vol
    if (tokenData.buySellRatio1h !== null && tokenData.buySellRatio1h > 0.55) signals++; // >55% buys
    if (dex.liquidityUsd > MIN_LIQUIDITY_USD * 2) signals++; // strong liquidity

    if (signals < MIN_MOMENTUM_SIGNALS) {
      failures.push(`momentum signals: ${signals}/${MIN_MOMENTUM_SIGNALS} required`);
    }
  }

  return failures;
}

// ── Layer 3: Jupiter slippage check ─────────────────────────────────────────
// Checks that Jupiter can route a trade at acceptable slippage
async function layer3Check(mint) {
  const failures = [];
  try {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const SOL_AMOUNT = 30_000_000; // 0.03 SOL in lamports
    const { default: axios } = await import('axios');
    const r = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: WSOL,
        outputMint: mint,
        amount: String(SOL_AMOUNT),
        slippageBps: Math.round(MAX_SLIPPAGE_PCT * 100),
      },
      timeout: 5_000,
    });
    if (!r.data?.outAmount) {
      failures.push('no Jupiter route found');
    }
  } catch (err) {
    if (err.response?.status === 400) {
      failures.push('no Jupiter route (400)');
    }
    // Timeouts / network errors don't fail — proceed
  }
  return failures;
}

// ── Main filter entry point ──────────────────────────────────────────────────
// Returns { passed, layer, failures, tokenData }
export async function runCandidateFilter(mint, { skipLayer3 = false } = {}) {
  filterStats.total++;
  const sym = mint.slice(0, 8);

  let tokenData;
  try {
    tokenData = await fetchTokenData(mint);
  } catch (err) {
    console.log(`[candidateFilter] tokenData fetch failed for ${sym}: ${err.message}`);
    return { passed: false, layer: 0, failures: ['data fetch error'], tokenData: null };
  }

  // Layer 1
  const l1 = layer1Check(tokenData);
  if (l1.length > 0) {
    for (const r of l1) trackFail(1, r.split(':')[0].trim());
    console.log(`[candidateFilter] ${sym} L1 FAIL: ${l1[0]}`);
    return { passed: false, layer: 1, failures: l1, tokenData };
  }
  filterStats.layer1Pass++;

  // Layer 2
  const l2 = layer2Check(tokenData);
  if (l2.length > 0) {
    for (const r of l2) trackFail(2, r.split(':')[0].trim());
    console.log(`[candidateFilter] ${sym} L2 FAIL: ${l2[0]}`);
    return { passed: false, layer: 2, failures: l2, tokenData };
  }
  filterStats.layer2Pass++;

  // Layer 3
  if (!skipLayer3) {
    const l3 = await layer3Check(mint);
    if (l3.length > 0) {
      for (const r of l3) trackFail(3, r);
      console.log(`[candidateFilter] ${sym} L3 FAIL: ${l3[0]}`);
      return { passed: false, layer: 3, failures: l3, tokenData };
    }
    filterStats.layer3Pass++;
  }

  console.log(`[candidateFilter] ${sym} PASSED all layers ✅`);
  return { passed: true, layer: null, failures: [], tokenData };
}
