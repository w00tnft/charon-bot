import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, REPORT_INTERVAL_MS, SMART_MONEY_POLL_MS, SMART_MONEY_ENABLED, ACCELERATED_DRY_RUN, POSITION_PRICE_CHECK_INTERVAL_MS, BACKTEST_AUTO_RUN, DEXSCREENER_TRENDING_POLL_MS, PUMPPORTAL_ENABLED, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { db } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { closeStuckPositions, recoverOpenPositions } from './db/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram, probeTelegram } from './telegram/send.js';
import { sendDailyReport } from './telegram/report.js';
import { numSetting } from './db/settings.js';
import { runCleanup, isDueForCleanup } from './db/cleanup.js';
import { makeFailureTracker, now } from './utils.js';
import { seedRouteWeightOverrides } from './learning/weights.js';
import { deduplicateLessons } from './learning/lessons.js';
import { checkEmergencyConditions, autoTuneFilters, dailyAudit } from './learning/autotuner.js';
import { fetchJupiterAsset } from './enrichment/jupiter.js';
import { executeLiveSell } from './execution/router.js';
import { escapeHtml } from './format.js';

setDefaultResultOrder('ipv4first');
validateConfig();

// Central interval registry — cleared on SIGTERM/SIGINT
const intervals = [];
function addInterval(fn, ms) {
  intervals.push(setInterval(fn, ms));
}

function shutdown(signal) {
  console.log(`[app] ${signal} received, clearing ${intervals.length} intervals and shutting down...`);
  for (const id of intervals) clearInterval(id);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('[app] unhandledRejection:', err?.message ?? err);
});
process.on('uncaughtException', (err) => {
  console.error('[app] uncaughtException:', err?.message ?? err);
});

// ── Nuclear stop — independent safety loop at -30% ────────────────────────
// Runs on its own setInterval so it cannot be blocked by the main trading loop.
// Catches positions that escape the main monitor due to stale price data or bugs.
async function nuclearStopCheck() {
  const positions = db.prepare("SELECT * FROM dry_run_positions WHERE status = 'open'").all();
  for (const pos of positions) {
    try {
      // Try fresh Jupiter price first
      let pnlPercent = Number(pos.pnl_percent || 0);
      let exitPrice = pos.high_water_price || pos.entry_price;
      let exitMcap  = pos.high_water_mcap  || pos.entry_mcap;

      const asset = await fetchJupiterAsset(pos.mint).catch(() => null);
      if (asset?.mcap && Number(pos.entry_mcap) > 0) {
        exitMcap   = Number(asset.mcap);
        exitPrice  = asset.usdPrice || exitPrice;
        pnlPercent = (exitMcap / Number(pos.entry_mcap) - 1) * 100;
      }

      if (pnlPercent > -30) continue;

      const sym = escapeHtml(pos.symbol || pos.mint.slice(0, 8));
      console.log(`[NUCLEAR STOP] Force closing $${sym} at ${pnlPercent.toFixed(1)}% loss`);

      const pnlSol = Number(pos.size_sol) * pnlPercent / 100;
      let exitSig  = null;

      // Attempt live sell with 25% slippage tolerance
      if (pos.execution_mode === 'live') {
        try {
          const sell = await executeLiveSell(pos, 'NUCLEAR_STOP');
          exitSig = sell?.signature || null;
        } catch (err) {
          console.log(`[NUCLEAR STOP] Live sell failed for $${sym}: ${err.message} — recording at last price`);
        }
      }

      // Record closure in DB regardless of sell outcome
      const changed = db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?,
            exit_reason = 'NUCLEAR_STOP', pnl_percent = ?, pnl_sol = ?, exit_signature = ?
        WHERE id = ? AND status = 'open'
      `).run(now(), exitPrice, exitMcap, pnlPercent, pnlSol, exitSig, pos.id).changes;

      if (changed) {
        await sendTelegram(
          `🚨 <b>NUCLEAR STOP</b> — $${sym} force closed at <b>${pnlPercent.toFixed(1)}%</b>`
        ).catch(() => {});
      }
    } catch (err) {
      console.log(`[NUCLEAR STOP] Error checking ${pos.mint.slice(0, 8)}: ${err.message}`);
    }
  }
}

export async function startCharon() {
  // Nuclear Helius connectivity test — runs before anything can throw
  {
    const key = process.env.HELIUS_API_KEY;
    if (key) {
      const addr = 'MRiYA4oN3158fCV8evhuCofrDzbHyYvYnGZUDJvoCsa';
      fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${key}&limit=5&type=SWAP`)
        .then(r => r.json())
        .then(d => console.log(`[smart] helius test: ${Array.isArray(d) ? d.length : JSON.stringify(d).slice(0, 80)} tx(s)`))
        .catch(e => console.log(`[smart] helius test error: ${e.message}`));
    } else {
      console.log('[smart] helius test skipped — HELIUS_API_KEY not set');
    }
  }

  const botStartTime = Date.now();
  let lastHeartbeat = Date.now();

  initDb();
  const recovered = await recoverOpenPositions();
  if (recovered.length > 0) {
    const msg = [
      'CHARON RESTARTED',
      `Recovered ${recovered.length} position(s):`,
      ...recovered.map(r => `${r.symbol}: ${r.action} ${r.pnl.toFixed(1)}% (${r.reason})`),
    ].join('\n');
    sendTelegram(msg).catch(() => {});
  }
  seedRouteWeightOverrides();
  deduplicateLessons();
  initLiveExecution();
  console.log('[hours] Trading windows: ' + (process.env.TRADING_HOURS_UTC || '10,11,16,18,19') + ' UTC');

  // ── PART 1: Start Express webhook HTTP server ──────────────────────────────
  const { startHeliusListener } = await import('./webhook/heliusListener.js');
  startHeliusListener();

  // ── PART 2: Fetch mid-cap pool addresses from Birdeye ─────────────────────
  const { fetchMidCapPools, startPoolRefreshInterval } = await import('./webhook/poolRegistry.js');
  let poolAddresses = [];
  try {
    poolAddresses = await fetchMidCapPools();
  } catch (err) {
    console.log(`[pool] startup fetch failed: ${err.message}`);
  }

  // ── PART 3: Register webhook with Helius ───────────────────────────────────
  const { registerWebhook } = await import('./webhook/registerWebhooks.js');
  const { setWebhookId } = await import('./webhook/poolRegistry.js');
  const webhookId = await registerWebhook(poolAddresses).catch(err => {
    console.log(`[webhook] registration error: ${err.message}`);
    return null;
  });
  if (webhookId) setWebhookId(webhookId);
  startPoolRefreshInterval();

  // ── PART 4: Attach signal handler ─────────────────────────────────────────
  const { attachSignalHandler, setSignalCandidateHandler } = await import('./webhook/signalHandler.js');
  setSignalCandidateHandler(processCandidateFromSignals);
  attachSignalHandler();

  // ── PART 5: Nuclear stop loop (independent — not in addInterval registry) ──
  setInterval(() => {
    nuclearStopCheck().catch(err => console.log(`[NUCLEAR STOP] loop error: ${err.message}`));
  }, 60_000);

  setupTelegram();
  await probeTelegram();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: signal server polling (DISABLED — webhook mode active) ──
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackDip = makeFailureTracker('dip monitor', alert);

    if (process.env.SIGNAL_POLLER_ENABLED !== 'false') {
      const trackServer = makeFailureTracker('signal server', alert);
      addInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);
      console.log('[SIGNAL POLLER] Enabled — polling thecharon.xyz');
    } else {
      console.log('[SIGNAL POLLER] Disabled via env');
    }

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    addInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    addInterval(() => cleanupAlerts(), 60 * 60 * 1000);
  } else {
    // ── Standalone mode: direct polling (legacy) ───────────────────────────
    const { fetchGraduatedCoins } = await import('./signals/graduated.js');
    const { fetchGmgnTrending, setDegenHandler } = await import('./signals/trending.js');
    const { startWebsocket, setCandidateHandler } = await import('./signals/feeClaim.js');

    setDegenHandler(maybeProcessDegenCandidate);
    setCandidateHandler(processCandidateFromSignals);

    await fetchGraduatedCoins().catch(error => console.log(`[graduated] initial fetch failed: ${error.message}`));
    await fetchGmgnTrending().catch(error => console.log(`[trending] initial fetch failed: ${error.message}`));

    addInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
    addInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
    startWebsocket();
  }

  if (PUMPPORTAL_ENABLED) {
    try {
      const { startPumpPortal, setCandidateHandler: setPumpHandler } = await import('./feeds/pumpportal.js');
      setPumpHandler(processCandidateFromSignals);
      startPumpPortal();
      console.log('[PUMPORTAL] Enabled');
    } catch (err) {
      console.log(`[PUMPORTAL] Failed to start: ${err.message}`);
    }
  } else {
    console.log('[PUMPORTAL] Disabled via env');
  }

  // Smart money wallet polling (gated — disabled by default)
  if (SMART_MONEY_ENABLED) {
    console.log('[smart] importing smartmoney module...');
    try {
      const { pollSmartWallets, testSmartMoneyConnection, setCandidateHandler: setSmartHandler, getSmartWallets } = await import('./feeds/smartmoney.js');
      setSmartHandler(processCandidateFromSignals);
      const smartWalletCount = getSmartWallets().filter(w => w.active && w.address).length;
      console.log(`[smart] starting — polling ${smartWalletCount} wallet(s) every ${SMART_MONEY_POLL_MS / 1000}s`);
      testSmartMoneyConnection().catch(err => console.log(`[smart] test error: ${err.message}`));
      pollSmartWallets().catch(err => console.log(`[smart] initial poll error: ${err.message}`));
      addInterval(() => pollSmartWallets().catch(err => console.log(`[smart] ${err.message}`)), SMART_MONEY_POLL_MS);
    } catch (err) {
      console.log(`[smart] FATAL import error: ${err.message}`);
    }
  } else {
    console.log('[SMART MONEY] Disabled via env');
  }

  // ── PART 5b: Accelerated dry-run mode ──────────────────────────────────────
  if (ACCELERATED_DRY_RUN) {
    console.log('[accel] ACCELERATED_DRY_RUN=true — DexScreener trending every 10min, faster price checks');
    const { fetchDexScreenerTrending } = await import('./data/tokenData.js');
    addInterval(async () => {
      try {
        const mints = await fetchDexScreenerTrending();
        console.log(`[accel] DexScreener trending: ${mints.length} token(s)`);
        for (const mint of mints.slice(0, 20)) {
          await processCandidateFromSignals({
            mint,
            route: 'webhook',
            source: 'dexscreener_trending',
            trendingToken: { address: mint, seenAt: Date.now() },
          }).catch(err => console.log(`[accel] signal error for ${mint.slice(0, 8)}: ${err.message}`));
        }
      } catch (err) {
        console.log(`[accel] trending poll error: ${err.message}`);
      }
    }, DEXSCREENER_TRENDING_POLL_MS);

    if (BACKTEST_AUTO_RUN) {
      const { runBacktest, formatBacktestReport } = await import('./backtest/engine.js');
      console.log('[backtest] Auto-run enabled — launching in background...');
      runBacktest({
        onProgress: msg => console.log(`[backtest] ${msg}`),
      }).then(results => {
        const report = formatBacktestReport(results);
        return sendTelegram(report);
      }).catch(err => console.log(`[backtest] auto-run error: ${err.message}`));
    }
  }

  // Position monitoring
  const posCheckMs = ACCELERATED_DRY_RUN ? POSITION_PRICE_CHECK_INTERVAL_MS : POSITION_CHECK_MS;
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  addInterval(() => trackPositions(() => monitorPositions()), posCheckMs);

  // Hourly maintenance
  const hourlyMaintenance = async () => {
    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMb  = Math.round(mem.rss       / 1024 / 1024);
    console.log(`[health] Memory: heap=${heapMb}MB rss=${rssMb}MB`);

    if (heapMb > 400) {
      console.log(`[health] Heap ${heapMb}MB > 400MB — forcing early cleanup`);
      try { runCleanup(); } catch (err) { console.log(`[cleanup] ${err.message}`); }
    }

    if (rssMb > 450) {
      console.log(`[health] RSS ${rssMb}MB > 450MB — exiting for clean restart`);
      shutdown('MEMGUARD');
    }

    const lastSent = numSetting('last_report_sent_ms', 0);
    const nextDue = lastSent + REPORT_INTERVAL_MS;
    if (Date.now() >= nextDue) {
      await sendDailyReport().catch(err => console.log(`[report] error: ${err.message}`));
    } else {
      const remaining = nextDue - Date.now();
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      console.log(`[report] next report in ${h}h ${m}m`);
    }

    if (isDueForCleanup()) {
      try { runCleanup(); } catch (err) { console.log(`[cleanup] error: ${err.message}`); }
    }

    await checkEmergencyConditions().catch(err => console.log(`[autotune] ${err.message}`));

    const lastFilterTune = numSetting('last_filter_tune_ms', 0);
    if (Date.now() - lastFilterTune > 7 * 24 * 60 * 60 * 1000) {
      try { autoTuneFilters(); } catch (err) { console.log(`[autotune] filter tune: ${err.message}`); }
    }

    const lastDailyAudit = numSetting('last_daily_audit_ms', 0);
    if (Date.now() - lastDailyAudit > 24 * 60 * 60 * 1000) {
      await dailyAudit().catch(err => console.log(`[autotune] daily audit: ${err.message}`));
    }
  };
  addInterval(() => hourlyMaintenance().catch(err => console.log(`[maintenance] ${err.message}`)), 60 * 60 * 1000);
  hourlyMaintenance().catch(() => {});

  // Heartbeat — sends status every 30min when positions open, or every 2h regardless
  setInterval(async () => {
    try {
      const open = db.prepare("SELECT COUNT(*) as count FROM dry_run_positions WHERE status = 'open'").get();
      const uptimeMs = Date.now() - botStartTime;
      const uptimeH = Math.floor(uptimeMs / 3_600_000);
      const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);
      const hasPositions = open.count > 0;
      const twoHoursPassed = Date.now() - lastHeartbeat > 7_200_000;
      if (hasPositions || twoHoursPassed) {
        await sendTelegram([
          'CHARON HEARTBEAT',
          `Open positions: ${open.count}`,
          `Mode: ${process.env.TRADING_MODE || 'dry_run'}`,
          `Uptime: ${uptimeH}h ${uptimeM}m`,
        ].join('\n'));
        lastHeartbeat = Date.now();
      }
    } catch (err) {
      console.error('[heartbeat] error:', err.message);
    }
  }, 1_800_000);

  console.log(`[CHARON] started — mode: ${process.env.TRADING_MODE || 'dry_run'}${ACCELERATED_DRY_RUN ? ' (ACCELERATED)' : ''}`);
  console.log(`[bot] ${APP_NAME} started`);
}
