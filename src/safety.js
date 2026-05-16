import { GMGN_ENABLED, LPAGENT_URL } from './config.js';
import { gmgnFetch, gmgnBackoffActive } from './enrichment/gmgn.js';
import { now } from './utils.js';

const deployerCache = new Map();
const DEPLOYER_CACHE_MAX = 200;
const DEPLOYER_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function enrichFromLpAgent(walletAddress) {
  if (!LPAGENT_URL || !walletAddress) return null;
  try {
    const data = await fetchWithTimeout(`${LPAGENT_URL}/wallet/${walletAddress}`, 3000);
    return data || null;
  } catch {
    return null;
  }
}

export async function checkDeployerHistory(walletAddress) {
  if (!walletAddress) return { walletAgeDays: null, previousTokens: 0, rugCount: 0, clean: true };

  const cached = deployerCache.get(walletAddress);
  if (cached && now() - cached.at < DEPLOYER_CACHE_TTL_MS) return cached.data;

  // LP Agent enrichment (optional, non-blocking)
  const lpAgentData = await enrichFromLpAgent(walletAddress).catch(() => null);

  if (!GMGN_ENABLED || gmgnBackoffActive('token')) {
    if (GMGN_ENABLED) console.log('[safety] GMGN backoff — skipping deployer history');
    const result = {
      walletAgeDays: lpAgentData?.walletAgeDays ?? null,
      previousTokens: lpAgentData?.previousTokens ?? 0,
      rugCount: lpAgentData?.rugCount ?? 0,
      clean: (lpAgentData?.rugCount ?? 0) === 0,
      source: lpAgentData ? 'lpagent' : 'unavailable',
    };
    if (deployerCache.size >= DEPLOYER_CACHE_MAX) deployerCache.delete(deployerCache.keys().next().value);
    deployerCache.set(walletAddress, { at: now(), data: result });
    return result;
  }

  try {
    const payload = await Promise.race([
      gmgnFetch('/v1/wallet/token_list', { params: { chain: 'sol', address: walletAddress, limit: 50 } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    const tokens = payload?.data?.tokens || payload?.data || [];
    const walletCreatedAtMs = payload?.data?.wallet_created_at
      ? new Date(payload.data.wallet_created_at).getTime()
      : null;
    const walletAgeDays = walletCreatedAtMs
      ? Math.floor((now() - walletCreatedAtMs) / (24 * 60 * 60 * 1000))
      : lpAgentData?.walletAgeDays ?? null;

    let rugCount = lpAgentData?.rugCount ?? 0;
    const previousTokens = Array.isArray(tokens) ? tokens.length : 0;
    if (Array.isArray(tokens)) {
      for (const token of tokens) {
        const isRug = token.is_rug === true
          || Number(token.rug_ratio ?? 0) > 0.9
          || (Number(token.current_price || 0) > 0
            && Number(token.open_price || 0) > 0
            && Number(token.current_price) < Number(token.open_price) * 0.05);
        if (isRug) rugCount++;
      }
    }

    const result = {
      walletAgeDays,
      previousTokens,
      rugCount,
      clean: rugCount === 0,
      source: 'gmgn',
    };
    if (deployerCache.size >= DEPLOYER_CACHE_MAX) deployerCache.delete(deployerCache.keys().next().value);
    deployerCache.set(walletAddress, { at: now(), data: result });
    return result;
  } catch (err) {
    console.log(`[safety] deployer check failed (${walletAddress.slice(0, 8)}…): ${err.message} — allowing`);
    const fallback = {
      walletAgeDays: lpAgentData?.walletAgeDays ?? null,
      previousTokens: lpAgentData?.previousTokens ?? 0,
      rugCount: lpAgentData?.rugCount ?? 0,
      clean: (lpAgentData?.rugCount ?? 0) === 0,
      source: 'fallback',
    };
    if (deployerCache.size >= DEPLOYER_CACHE_MAX) deployerCache.delete(deployerCache.keys().next().value);
    deployerCache.set(walletAddress, { at: now(), data: fallback });
    return fallback;
  }
}

export function calculateSafetyScore(candidate, deployerHistory = null) {
  let score = 100;
  const flags = [];

  const gmgn = candidate.gmgn;
  const jupAudit = candidate.jupiterAsset?.audit || {};
  const trending = candidate.trending;
  const holders = candidate.holders || {};
  const signals = candidate.signals || {};

  // ── Deployer history ──────────────────────────────────────────────────────
  if (deployerHistory && deployerHistory.source !== 'unavailable') {
    if (deployerHistory.rugCount > 2) {
      score -= 60;
      flags.push(`serial rugger: ${deployerHistory.rugCount} rugs ❌`);
    } else if (deployerHistory.rugCount > 0) {
      score -= 40;
      flags.push(`previous rugs: ${deployerHistory.rugCount} ⚠️`);
    } else {
      flags.push('deployer clean ✅');
    }

    if (deployerHistory.walletAgeDays != null) {
      if (deployerHistory.walletAgeDays < 7) {
        score -= 30;
        flags.push(`new wallet (${deployerHistory.walletAgeDays}d old) ⚠️`);
      } else if (deployerHistory.walletAgeDays >= 30) {
        score += 10;
        flags.push(`veteran deployer (${deployerHistory.walletAgeDays}d) ✅`);
      }
    }
  }

  // ── LP status ─────────────────────────────────────────────────────────────
  const lpBurned = gmgn?.burn_status === 'burn'
    || gmgn?.lp_burned === true
    || jupAudit.lpBurned === true;
  const lpActive = gmgn?.burn_status === 'unburn'
    || gmgn?.lp_burned === false
    || jupAudit.lpBurned === false;

  if (lpBurned) {
    score += 10;
    flags.push('LP burned ✅');
  } else if (lpActive) {
    score -= 20;
    flags.push('LP not burned ⚠️');
  }

  // ── Mint authority ────────────────────────────────────────────────────────
  const mintRevoked = gmgn?.renounced === true
    || gmgn?.mint_authority === null
    || jupAudit.mintAuthorityRevoked === true;
  const mintActive = gmgn?.renounced === false
    || jupAudit.mintAuthorityRevoked === false;

  if (mintRevoked) {
    score += 10;
    flags.push('mint revoked ✅');
  } else if (mintActive) {
    score -= 20;
    flags.push('mint not revoked ⚠️');
  }

  // ── Freeze authority ──────────────────────────────────────────────────────
  const freezeActive = jupAudit.freezeAuthorityRevoked === false
    || (gmgn?.freeze_authority != null
      && gmgn.freeze_authority !== 'null'
      && gmgn.freeze_authority !== null);
  if (freezeActive) {
    score -= 25;
    flags.push('freeze authority active ⚠️');
  }

  // ── Dev holdings ─────────────────────────────────────────────────────────
  const devPct = Number(gmgn?.dev_token_burn_amount_percentage ?? gmgn?.creator_percentage ?? 0);
  if (devPct > 10) {
    score -= 15;
    flags.push(`dev holding ${devPct.toFixed(1)}% ⚠️`);
  } else if (devPct > 0) {
    flags.push(`dev holding ${devPct.toFixed(1)}%`);
  }

  // ── Bundler rate ──────────────────────────────────────────────────────────
  const bundlerRate = Number(trending?.bundler_rate ?? 0);
  if (bundlerRate > 0.25) {
    score -= 15;
    flags.push(`bundler rate ${(bundlerRate * 100).toFixed(0)}% ⚠️`);
  }

  // ── Top 10 holder concentration ───────────────────────────────────────────
  const top10 = Number(holders.top10Percent ?? 0);
  if (top10 > 30) {
    score -= 10;
    flags.push(`top10 holders ${top10.toFixed(1)}% ⚠️`);
  }

  // ── Signal source bonus ───────────────────────────────────────────────────
  const srcCount = [signals.hasFeeClaim, signals.hasGraduated, signals.hasTrending]
    .filter(Boolean).length;
  if (srcCount >= 3) {
    score += 10;
    flags.push(`${srcCount} signal sources ✅`);
  }

  score = Math.max(0, Math.min(100, score));
  return { score, flags, passed: score >= 65 };
}
