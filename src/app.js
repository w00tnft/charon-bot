import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, REPORT_INTERVAL_MS, PUMPPORTAL_ENABLED, SMART_MONEY_POLL_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram, probeTelegram } from './telegram/send.js';
import { sendDailyReport } from './telegram/report.js';
import { numSetting } from './db/settings.js';
import { runCleanup, isDueForCleanup } from './db/cleanup.js';
import { makeFailureTracker } from './utils.js';

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

// Prevent unhandled async errors from silently killing the process
process.on('unhandledRejection', (err) => {
  console.error('[app] unhandledRejection:', err?.message ?? err);
});
process.on('uncaughtException', (err) => {
  console.error('[app] uncaughtException:', err?.message ?? err);
});

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

  initDb();
  initLiveExecution();
  setupTelegram();
  await probeTelegram();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    await fetchServerSignals().catch(error => console.log(`[server] initial fetch failed: ${error.message}`));
    addInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    addInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    addInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
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

    console.log(`[bot] ${APP_NAME} started (standalone mode)`);
  }

  // PumpPortal real-time feed (both modes, optional)
  if (PUMPPORTAL_ENABLED) {
    const { startPumpPortal, setCandidateHandler: setPumpHandler } = await import('./feeds/pumpportal.js');
    setPumpHandler(processCandidateFromSignals);
    startPumpPortal();
    console.log('[bot] PumpPortal feed enabled');
  }

  // Smart money wallet polling (both modes)
  console.log('[smart] importing smartmoney module...');
  try {
    const { pollSmartWallets, testSmartMoneyConnection, setCandidateHandler: setSmartHandler, getSmartWallets } = await import('./feeds/smartmoney.js');
    console.log(`[smart] module loaded OK — testSmartMoneyConnection type: ${typeof testSmartMoneyConnection}`);
    setSmartHandler(processCandidateFromSignals);
    const smartWalletCount = getSmartWallets().filter(w => w.active && w.address).length;
    console.log(`[smart] starting — polling ${smartWalletCount} wallet(s) every ${SMART_MONEY_POLL_MS / 1000}s`);
    testSmartMoneyConnection().catch(err => console.log(`[smart] test error: ${err.message}`));
    pollSmartWallets().catch(err => console.log(`[smart] initial poll error: ${err.message}`));
    addInterval(() => pollSmartWallets().catch(err => console.log(`[smart] ${err.message}`)), SMART_MONEY_POLL_MS);
  } catch (err) {
    console.log(`[smart] FATAL import error: ${err.message}`);
  }

  // Position monitoring runs in both modes
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  addInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  // Hourly maintenance: memory health + guard, daily report, DB cleanup
  const hourlyMaintenance = async () => {
    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMb  = Math.round(mem.rss       / 1024 / 1024);
    console.log(`[health] Memory: heap=${heapMb}MB rss=${rssMb}MB`);

    // Tier 1: high heap — run DB cleanup early to reclaim memory
    if (heapMb > 400) {
      console.log(`[health] Heap ${heapMb}MB > 400MB — forcing early cleanup`);
      try { runCleanup(); } catch (err) { console.log(`[cleanup] ${err.message}`); }
    }

    // Tier 2: RSS critical — exit cleanly so Railway auto-restarts
    if (rssMb > 450) {
      console.log(`[health] RSS ${rssMb}MB > 450MB — exiting for clean restart`);
      shutdown('MEMGUARD');
    }

    // Daily report
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

    // Daily DB cleanup
    if (isDueForCleanup()) {
      try { runCleanup(); } catch (err) { console.log(`[cleanup] error: ${err.message}`); }
    }
  };
  addInterval(() => hourlyMaintenance().catch(err => console.log(`[maintenance] ${err.message}`)), 60 * 60 * 1000);
  hourlyMaintenance().catch(() => {});
}
