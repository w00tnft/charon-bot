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

  if (!overview) return 0;

  const holders = Number(overview.holder ?? 0);
  const priceChange1h = Number(overview.priceChange1hPercent ?? 0);
  const volume1h = Number(overview.v1hUSD ?? 0);

  // Max bonus: +20 (free-tier overview only; security endpoint requires premium)
  let score = 0;
  if (holders > 500) score += 10;
  else if (holders > 100) score += 5;
  if (volume1h > 50_000) score += 10;
  else if (volume1h > 10_000) score += 5;
  if (priceChange1h > 0) score += 5;

  if (score > 0) {
    console.log(
      `[birdeye] +${score}/20 | ` +
      `holders: ${holders}, vol1h: $${Math.round(volume1h / 1000)}k, Δ1h: ${priceChange1h.toFixed(1)}%`
    );
  }
  return score;
}
