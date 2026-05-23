import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { calculateSafetyScore, checkDeployerHistory } from '../safety.js';
import { getRouteWeight, toCanonicalRoute } from '../learning/weights.js';
import { isBlacklisted, isWhitelisted } from '../db/blacklist.js';
import { fetchBirdeyeScore } from '../feeds/birdeye.js';
import { isWithinTradingHours, getNextTradingWindow } from '../utils/tradingHours.js';
import { isOnCooldown } from '../utils/mintCooldown.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const sym = candidate.token?.symbol || candidate.token?.mint?.slice(0, 8) || '?';

  // Trading hours gate — before any other checks
  if (!isWithinTradingHours()) {
    const { nextHour, hoursUntil } = getNextTradingWindow();
    console.log(`[hours] $${sym} skipped — outside trading window, next: ${nextHour}:00 UTC (in ${hoursUntil}h)`);
    return { passed: false, failures: ['outside trading hours'], strategy: strat.id };
  }

  // Blacklist checks — early return, no further enrichment needed
  const blMint = isBlacklisted(candidate.token?.mint, null);
  if (blMint) {
    console.log(`[blacklist] $${sym} skipped — rug blacklisted`);
    return { passed: false, failures: ['blacklisted: rug'], strategy: strat.id };
  }
  const deployerAddr = candidate.token?.deployerAddress || candidate.safety?.deployerAddress;
  const blDeployer = isBlacklisted(null, deployerAddr);
  if (blDeployer) {
    console.log(`[blacklist] $${sym} skipped — deployer banned`);
    return { passed: false, failures: ['blacklisted: deployer banned'], strategy: strat.id };
  }
  // Mint cooldown — skip tokens that recently caused a loss
  const mint = candidate.token?.mint;
  if (mint && isOnCooldown(mint)) {
    console.log(`[cooldown] $${sym} skipped — loss cooldown active`);
    return { passed: false, failures: ['mint cooldown: recent loss'], strategy: strat.id };
  }

  // Liquidity hard block — uses already-fetched metrics, no extra API call
  const liqUsd = candidate.metrics.liquidityUsd;
  const minLiq = Number(process.env.FILTER_MIN_LIQUIDITY_USD) || 50_000;
  if (liqUsd > 0 && liqUsd < minLiq) {
    console.log(`[liquidity] $${sym} BLOCKED — $${Math.round(liqUsd / 1000)}k < $${Math.round(minLiq / 1000)}k`);
    return { passed: false, failures: [`liquidity: $${Math.round(liqUsd / 1000)}k < $${Math.round(minLiq / 1000)}k`], strategy: strat.id };
  }
  if (liqUsd > 0) {
    console.log(`[liquidity] $${sym} OK — $${Math.round(liqUsd / 1000)}k`);
  }

  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // Safety score — route-aware minimum threshold
  if (strat.min_safety_score > 0 && candidate.safety) {
    const { score } = candidate.safety;
    const signalRoute = toCanonicalRoute(candidate.signals?.route);
    const routeMinScores = strat.route_min_scores || {};
    const routeMin = routeMinScores[signalRoute] ?? strat.min_safety_score;
    if (score < routeMin) {
      console.log(`[candidate] $${sym} BLOCKED — route: ${signalRoute} needs ${routeMin}, got ${score}`);
      failures.push(`safety score: ${score}/100 < route min ${routeMin} (${signalRoute})`);
    }
  }

  // Score ceiling — filter crowded/overbought tokens
  if (candidate.safety) {
    const maxScore = Number(process.env.MAX_CANDIDATE_SCORE) || 65;
    if (candidate.safety.score > maxScore) {
      console.log(`[score] $${sym} BLOCKED — score ${candidate.safety.score} > ${maxScore} ceiling (crowded token)`);
      failures.push(`score ceiling: ${candidate.safety.score} > ${maxScore}`);
    }
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    const birdeyeVol = candidate.safety?.birdeyeBonus > 0; // birdeye confirmed vol>$10k
    if (strat.trending_min_volume_usd > 0 && !birdeyeVol && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  if (failures.length === 0 && candidate.safety) {
    const signalRoute = toCanonicalRoute(candidate.signals?.route);
    const routeMinScores = strat.route_min_scores || {};
    const routeMin = routeMinScores[signalRoute] ?? strat.min_safety_score;
    console.log(`[candidate] $${sym} PASSED — route: ${signalRoute} | score: ${candidate.safety.score} | route_min: ${routeMin} ✅`);
  }
  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route, source = null, smartMoneySignal = null, pumpPortalData = null }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      source: source || (signalRoute === 'pumpportal' ? 'pumpportal' : 'server'),
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
      smartMoney: smartMoneySignal || null,
      pumpPortal: pumpPortalData || null,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };

  // Deployer address — best-effort from available enrichment data
  const deployerAddress = gmgn?.creator_address
    || gmgn?.deployer_address
    || gmgn?.owner
    || jupiterAsset?.creatorAddress
    || null;
  candidate.token.deployerAddress = deployerAddress;

  // Safety scoring (fail-safe: never throws, always produces a result)
  const deployerHistory = await checkDeployerHistory(deployerAddress).catch(() => null);
  candidate.safety = {
    ...calculateSafetyScore(candidate, deployerHistory),
    deployerHistory,
    deployerAddress,
  };

  // Apply historical route weight to safety score
  const routeWeight = getRouteWeight(signalRoute);
  if (routeWeight !== 1.0) {
    const rawScore = candidate.safety.score;
    const weightedScore = Math.min(100, Math.round(rawScore * routeWeight));
    // Safety net: if the weight would push ALL tokens below 50 it means the weight
    // data is bad (crash-period losses, insufficient samples). Fall back to raw score.
    if (weightedScore < 50) {
      console.log(`[weights] WARNING ${toCanonicalRoute(signalRoute)} ${routeWeight.toFixed(2)}x would drop score ${rawScore} → ${weightedScore} — using raw score (weight floor triggered)`);
      candidate.safety = { ...candidate.safety, routeWeight };
    } else {
      candidate.safety = { ...candidate.safety, score: weightedScore, passed: weightedScore >= 65, routeWeight };
      console.log(`[weights] ${toCanonicalRoute(signalRoute)} ${routeWeight.toFixed(2)}x → score ${rawScore} → ${weightedScore}`);
    }
  }

  // Whitelist deployer bonus (+15)
  if (deployerAddress && isWhitelisted(deployerAddress)) {
    const sym = candidate.token.symbol || mint.slice(0, 8);
    const boostedScore = Math.min(100, candidate.safety.score + 15);
    candidate.safety = { ...candidate.safety, score: boostedScore, passed: boostedScore >= 65 };
    console.log(`[whitelist] $${sym} boosted +15 → score ${boostedScore} — known winner deployer`);
  }

  // Smart money bonus (+20)
  if (smartMoneySignal) {
    const { walletLabel } = smartMoneySignal;
    const before = candidate.safety.score;
    const boostedScore = Math.min(100, before + 20);
    candidate.safety = { ...candidate.safety, score: boostedScore, passed: boostedScore >= 65 };
    console.log(`[smart] ${walletLabel} signal → score ${before} → ${boostedScore} (+20)`);
  }

  // Birdeye enrichment bonus (0–30 points, fail-safe — can only increase score)
  const birdeyeBonus = Math.max(0, await fetchBirdeyeScore(mint).catch(() => 0));
  if (birdeyeBonus > 0) {
    const before = candidate.safety.score;
    const boostedScore = Math.min(100, before + birdeyeBonus);
    candidate.safety = { ...candidate.safety, score: boostedScore, passed: boostedScore >= 65, birdeyeBonus };
    console.log(`[birdeye] +${birdeyeBonus} → score ${before} → ${boostedScore}`);
  }

  const safetyIcon = candidate.safety.passed ? '✅' : '❌';
  const topFlags = candidate.safety.flags.slice(0, 3).join(', ');
  // Note: score reduction is only from route weight (e.g. 0.75x = score×0.75). Birdeye/smart-money only add.
  console.log(`[safety] ${candidate.token.symbol || mint.slice(0, 8)} score: ${candidate.safety.score}/100 ${safetyIcon}${topFlags ? ` — ${topFlags}` : ''}`);

  candidate.filters = filterCandidate(candidate);
  return candidate;
}
