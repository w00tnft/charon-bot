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

  // Log raw security field names so we can identify the correct holder % field
  if (security) {
    const rawKeys = Object.keys(security);
    console.log('[birdeye] security keys:', rawKeys.join(', '));
    console.log('[birdeye] security sample:', JSON.stringify(security).slice(0, 200));
  }

  const holders = Number(overview?.holder ?? 0);
  const priceChange1h = Number(overview?.priceChange1hPercent ?? 0);
  const volume1h = Number(overview?.v1hUSD ?? 0);

  // API returns fractions (0–1); multiply by 100 to get percent. Default 1 (=100%) = conservative.
  const top10Raw = Number(security?.top10HolderPercent ?? security?.top10UserPercent ?? 1);
  const top10Pct = top10Raw <= 1 ? top10Raw * 100 : top10Raw;
  const ownerRaw = Number(security?.ownerPercentage ?? security?.creatorPercentage ?? 1);
  const ownerPct = ownerRaw <= 1 ? ownerRaw * 100 : ownerRaw;
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
