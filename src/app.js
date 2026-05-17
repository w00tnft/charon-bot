import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, REPORT_INTERVAL_MS, validateConfig } from './config.js';
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

process.on('SIGTERM', () => {
  console.log('[app] SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[app] SIGINT received, shutting down...');
  process.exit(0);
});

export async function startCharon() {
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
    setInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

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

    setInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
    setInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
    startWebsocket();

    console.log(`[bot] ${APP_NAME} started (standalone mode)`);
  }

  // Position monitoring runs in both modes
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  // Hourly maintenance: memory health, daily report, DB cleanup
  const hourlyMaintenance = async () => {
    // Memory health
    const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[health] Memory: ${mb}MB rss`);

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
  setInterval(() => hourlyMaintenance().catch(err => console.log(`[maintenance] ${err.message}`)), 60 * 60 * 1000);
  hourlyMaintenance().catch(() => {});
}
