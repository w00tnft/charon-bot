import axios from 'axios';
import { BIRDEYE_API_KEY } from '../config.js';

const BASE = 'https://public-api.birdeye.so';
const TIMEOUT_MS = 3_000;

function birdeyeHeaders() {
  return {
    'X-API-KEY': BIRDEYE_API_KEY,
    'x-chain': 'solana',
    Accept: 'application/json',
  };
}

export async function fetchBirdeyeScore(mint) {
  if (!BIRDEYE_API_KEY) return 0;

  let overview = null;
  let security = null;

  try {
    const r = await axios.get(`${BASE}/defi/token_overview`, {
      params: { address: mint },
      headers: birdeyeHeaders(),
      timeout: TIMEOUT_MS,
    });
    overview = r.data?.data || null;
  } catch {
    // timeout or API error — skip silently
  }

  try {
    const r = await axios.get(`${BASE}/defi/token_security`, {
      params: { address: mint },
      headers: birdeyeHeaders(),
      timeout: TIMEOUT_MS,
    });
    security = r.data?.data || null;
  } catch {
    // timeout or API error — skip silently
  }

  if (!overview && !security) return 0;

  const holders = Number(overview?.holder ?? 0);
  const uniqueWallets24h = Number(overview?.uniqueWallet24h ?? 0);
  const priceChange1h = Number(overview?.priceChange1hPercent ?? 0);
  const volume1h = Number(overview?.v1hUSD ?? 0);
  const liquidity = Number(overview?.liquidity ?? 0);

  const top10Pct = Number(security?.top10HolderPercent ?? 100);
  const ownerPct = Number(security?.ownerPercentage ?? 100);
  const isMutable = security?.mutableMetadata !== false; // false = immutable = good

  let score = 0;
  if (holders > 500) score += 10;
  else if (holders > 100) score += 5;
  if (volume1h > 10_000) score += 5;
  if (priceChange1h > 0) score += 5;
  if (top10Pct < 30) score += 5;
  if (!isMutable) score += 5;
  if (ownerPct < 5) score += 5;

  if (score > 0) {
    console.log(
      `[birdeye] score: +${score}/30 | ` +
      `holders: ${holders}, vol1h: $${Math.round(volume1h / 1000)}k, top10: ${top10Pct.toFixed(0)}%`
    );
  }
  return score;
}
