import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { sendTelegram } from '../telegram/send.js';
import { numSetting, setSetting } from '../db/settings.js';
import { escapeHtml, fmtPct, fmtSol } from '../format.js';

const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 min between same-type alerts

// ── Part A: Route weight auto-tuning ──────────────────────────────────────
// Applies incremental adjustments based on recent 7-day per-route performance.
// Called after every learning run (every 25 closed positions).

export function autoTuneRoutes() {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rows = db.prepare(`
      SELECT signal_route AS route,
        COUNT(*) AS trades,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl
      FROM dry_run_positions
      WHERE status = 'closed' AND signal_route IS NOT NULL AND opened_at_ms > ?
      GROUP BY signal_route
      HAVING trades >= 5
    `).all(sevenDaysAgo);

    const adjustments = [];
    for (const row of rows) {
      const { route, trades, wins, avg_pnl } = row;
      const weightRow = db.prepare('SELECT weight FROM route_weights WHERE route = ?').get(route);
      if (!weightRow) continue;

      const currentWeight = Number(weightRow.weight);
      let newWeight = currentWeight;
      let reason = null;

      if (avg_pnl > 3 && trades >= 10) {
        newWeight = Math.min(currentWeight * 1.15, 1.5);
        reason = 'boosted — winning';
      } else if (avg_pnl < -5 && trades >= 10) {
        newWeight = 0.1;
        reason = 'disabled — consistent loser';
      } else if (avg_pnl < -2 && trades >= 8) {
        newWeight = Math.max(currentWeight * 0.85, 0.3);
        reason = 'reduced — underperforming';
      }

      if (reason) {
        newWeight = Math.round(newWeight * 100) / 100;
        db.prepare('UPDATE route_weights SET weight = ?, updated_at_ms = ? WHERE route = ?')
          .run(newWeight, now(), route);
        adjustments.push({ route, from: currentWeight, to: newWeight, reason, trades, avg_pnl });
        console.log(`[autotune] ${route}: ${currentWeight.toFixed(2)}x → ${newWeight.toFixed(2)}x (${reason}, ${trades} trades, ${avg_pnl.toFixed(1)}% avg)`);
      }
    }

    setSetting('last_route_tune_ms', String(now()));
    return adjustments;
  } catch (err) {
    console.log(`[autotune] route tune error: ${err.message}`);
    return [];
  }
}

// ── Part B: Filter auto-adjustment ────────────────────────────────────────
// Adjusts min_safety_score and route thresholds based on 7-day win rate.
// Called weekly.

export function autoTuneFilters() {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN exit_class = 'neutral' THEN 1 ELSE 0 END) AS neutrals,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl
      FROM dry_run_positions
      WHERE status = 'closed' AND opened_at_ms > ?
    `).get(sevenDaysAgo);

    if (!stats || stats.total < 10) {
      console.log(`[autotune] filter tune skipped — insufficient data (${stats?.total ?? 0} trades this week)`);
      return;
    }

    const winRate = stats.total > 0 ? stats.wins / stats.total : 0;
    const neutralRate = stats.total > 0 ? stats.neutrals / stats.total : 0;

    const degenRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'degen'").get();
    if (!degenRow) return;
    const cfg = JSON.parse(degenRow.config_json);
    const currentScore = cfg.min_safety_score || 65;
    let changed = false;

    if (winRate < 0.30) {
      const newScore = Math.min(currentScore + 3, 85);
      db.prepare("UPDATE strategies SET config_json = json_set(config_json, '$.min_safety_score', ?) WHERE id = 'degen'").run(newScore);
      console.log(`[autotune] tightening — win rate ${Math.round(winRate * 100)}% < 30%, safety ${currentScore} → ${newScore}`);
      changed = true;
    } else if (winRate > 0.50) {
      const newScore = Math.max(currentScore - 2, 55);
      db.prepare("UPDATE strategies SET config_json = json_set(config_json, '$.min_safety_score', ?) WHERE id = 'degen'").run(newScore);
      console.log(`[autotune] loosening — win rate ${Math.round(winRate * 100)}% > 50%, safety ${currentScore} → ${newScore}`);
      changed = true;
    }

    if (stats.avg_pnl < -3) {
      const routeMin = cfg.route_min_scores || {};
      if ((routeMin.graduated_trending || 75) < 80) {
        const updated = { ...routeMin, graduated_trending: 80 };
        db.prepare("UPDATE strategies SET config_json = json_set(config_json, '$.route_min_scores', json(?)) WHERE id = 'degen'")
          .run(JSON.stringify(updated));
        console.log(`[autotune] tightening graduated_trending min 75→80 — avg pnl ${stats.avg_pnl.toFixed(1)}%`);
        changed = true;
      }
    }

    if (neutralRate > 0.40) {
      console.log(`[autotune] neutral rate ${Math.round(neutralRate * 100)}% > 40% — too many timeout exits, consider tighter entry filters`);
    }

    setSetting('last_filter_tune_ms', String(now()));
    if (changed) {
      console.log(`[autotune] filters adjusted — winRate: ${Math.round(winRate * 100)}%, avgPnl: ${stats.avg_pnl.toFixed(1)}%`);
    }
  } catch (err) {
    console.log(`[autotune] filter tune error: ${err.message}`);
  }
}

// ── Part C: Emergency condition alerts ────────────────────────────────────
// Checks for urgent conditions and sends Telegram alerts with 30min cooldown.
// Called from hourly maintenance.

export async function checkEmergencyConditions() {
  try {
    const ts = now();

    // Check 1 — large loss on open position (pnl_percent stored live since PR #37)
    const lastLossAlert = numSetting('last_large_loss_alert_ms', 0);
    if (ts - lastLossAlert > ALERT_COOLDOWN_MS) {
      const bigLoss = db.prepare(`
        SELECT id, symbol, mint, pnl_percent, opened_at_ms
        FROM dry_run_positions
        WHERE status = 'open' AND pnl_percent < -45
        ORDER BY pnl_percent ASC LIMIT 1
      `).get();
      if (bigLoss) {
        const ageMins = Math.round((ts - bigLoss.opened_at_ms) / 60000);
        const sym = escapeHtml(bigLoss.symbol || bigLoss.mint.slice(0, 8));
        await sendTelegram(
          `🚨 <b>LARGE LOSS ALERT</b>\n\n` +
          `▸ Token: <b>$${sym}</b>\n` +
          `▸ PnL: <b>${Number(bigLoss.pnl_percent).toFixed(1)}%</b>\n` +
          `▸ Age: <b>${ageMins}min</b>\n` +
          `▸ Emergency stop should fire soon!`
        );
        setSetting('last_large_loss_alert_ms', String(ts));
      }
    }

    // Check 2 — win rate crash on last 20 trades
    const lastWinAlert = numSetting('last_winrate_alert_ms', 0);
    if (ts - lastWinAlert > ALERT_COOLDOWN_MS) {
      const recent = db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins
        FROM (
          SELECT exit_class FROM dry_run_positions
          WHERE status = 'closed'
          ORDER BY closed_at_ms DESC LIMIT 20
        )
      `).get();
      if (recent?.total >= 20 && (recent.wins / recent.total) < 0.20) {
        const pct = Math.round(recent.wins / recent.total * 100);
        await sendTelegram(
          `⚠️ <b>WIN RATE ALERT</b>\n\n` +
          `▸ Last 20 trades: <b>${recent.wins} wins (${pct}%)</b>\n` +
          `▸ Normal range: 30–45%\n` +
          `▸ Consider manual review`
        );
        setSetting('last_winrate_alert_ms', String(ts));
      }
    }

    // Check 3 — dead bot (no positions opened in 90 min)
    const lastDeadAlert = numSetting('last_dead_bot_alert_ms', 0);
    if (ts - lastDeadAlert > ALERT_COOLDOWN_MS) {
      const lastPos = db.prepare(
        'SELECT opened_at_ms FROM dry_run_positions ORDER BY opened_at_ms DESC LIMIT 1'
      ).get();
      const silenceMs = ts - (lastPos?.opened_at_ms ?? 0);
      if (silenceMs > 90 * 60_000) {
        const degenRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'degen'").get();
        const cfg = degenRow ? JSON.parse(degenRow.config_json) : {};
        const minK = Math.round((cfg.min_mcap_usd || 0) / 1000);
        const maxK = Math.round((cfg.max_mcap_usd || 0) / 1000);
        await sendTelegram(
          `⚠️ <b>NO SIGNALS ALERT</b>\n\n` +
          `▸ No positions opened for <b>${Math.round(silenceMs / 60000)}min</b>\n` +
          `▸ Market may be slow or filters too strict\n` +
          `▸ Current mcap range: $${minK}k–$${maxK}k`
        );
        setSetting('last_dead_bot_alert_ms', String(ts));
      }
    }
  } catch (err) {
    console.log(`[autotune] emergency check error: ${err.message}`);
  }
}

// ── Part D: Daily audit report ─────────────────────────────────────────────
// Generates a full status report and posts it to Telegram.
// Called from hourly maintenance when 24h has passed since last audit.

export async function dailyAudit() {
  try {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

    const stats24h = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl,
        COALESCE(SUM(pnl_sol), 0) AS total_sol
      FROM dry_run_positions
      WHERE status = 'closed' AND closed_at_ms > ?
    `).get(dayAgo);

    const baseSol = numSetting('starting_capital_sol', 1.0);
    const allPnlSol = db.prepare("SELECT COALESCE(SUM(pnl_sol), 0) AS s FROM dry_run_positions WHERE status = 'closed'").get().s;
    const capital = baseSol + Number(allPnlSol);
    const capitalChange = Number(stats24h?.total_sol || 0);

    const routeWeights = db.prepare('SELECT route, weight, win_count, loss_count FROM route_weights ORDER BY weight DESC').all();
    const lessonCount = db.prepare("SELECT COUNT(*) AS c FROM learning_lessons WHERE status = 'active'").get().c;
    const totalClosed = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE status = 'closed'").get().c;
    const nextLearnAt = Math.ceil((totalClosed + 1) / 25) * 25;

    const largeLosses24h = db.prepare(`
      SELECT COUNT(*) AS c FROM dry_run_positions
      WHERE status = 'closed' AND exit_class = 'loss' AND pnl_percent < -30 AND closed_at_ms > ?
    `).get(dayAgo).c;

    const lastRouteTune = numSetting('last_route_tune_ms', 0);
    const lastRouteTuneAgo = lastRouteTune ? Math.round((Date.now() - lastRouteTune) / 3_600_000) : null;

    const winRate24h = stats24h?.total > 0 ? Math.round((stats24h.wins / stats24h.total) * 100) : null;

    const routeLines = routeWeights.slice(0, 5).map(r => {
      const total = (r.win_count || 0) + (r.loss_count || 0);
      const wr = total > 0 ? Math.round((r.win_count || 0) / total * 100) : 0;
      const wt = Number(r.weight);
      const tag = wt <= 0.15 ? 'DISABLED' : `${wt.toFixed(2)}x`;
      const icon = wt <= 0.15 ? '❌' : wt >= 1.3 ? '🔥' : wt >= 1.0 ? '✅' : '⚠️';
      return `${icon} ${escapeHtml(r.route)}: ${tag} (${wr}% win, ${total} trades)`;
    });

    const overall = winRate24h == null
      ? '📊 Insufficient data today'
      : winRate24h >= 35
        ? '✅ All systems nominal'
        : '⚠️ Action recommended: win rate below 35%';

    const lines = [
      '🔍 <b>CHARON DAILY AUDIT</b>',
      `📅 ${new Date().toUTCString().slice(0, 16)}`,
      '━━━━━━━━━━━━━━━━',
      '',
      '💰 <b>CAPITAL</b>',
      `▸ Balance: <b>${fmtSol(capital)} SOL</b>`,
      `▸ 24h change: <b>${capitalChange >= 0 ? '+' : ''}${fmtSol(capitalChange)} SOL</b>`,
      '',
      '📊 <b>PERFORMANCE (24h)</b>',
      `▸ Trades: <b>${stats24h?.total ?? 0}</b>`,
      `▸ Win rate: <b>${winRate24h != null ? winRate24h + '%' : '—'}</b>`,
      `▸ Avg PnL: <b>${stats24h?.avg_pnl != null ? fmtPct(stats24h.avg_pnl) : '—'}</b>`,
      '',
      '🛣️ <b>ROUTE HEALTH</b>',
      ...routeLines,
      '',
      lastRouteTuneAgo != null
        ? `🤖 <b>LAST AUTO-TUNE</b>: ${lastRouteTuneAgo}h ago`
        : '🤖 <b>AUTO-TUNE</b>: not yet run',
      '',
      '🚨 <b>ALERTS (24h)</b>',
      `▸ Large losses (< -30%): <b>${largeLosses24h}</b>`,
      '',
      '🧠 <b>LEARNING</b>',
      `▸ Active lessons: <b>${lessonCount}</b>`,
      `▸ Next learn at: <b>trade #${nextLearnAt}</b> (${Math.max(0, nextLearnAt - totalClosed)} more)`,
      '',
      overall,
      '━━━━━━━━━━━━━━━━',
      '🤖 Charon self-managed',
    ];

    await sendTelegram(lines.join('\n'));
    setSetting('last_daily_audit_ms', String(now()));
    console.log('[autotune] daily audit sent');
  } catch (err) {
    console.log(`[autotune] daily audit error: ${err.message}`);
  }
}

// ── Autostatus helper ──────────────────────────────────────────────────────
// Returns a formatted status string for the /autostatus command.

export function autoStatusText() {
  try {
    const routeWeights = db.prepare('SELECT route, weight, win_count, loss_count FROM route_weights ORDER BY weight DESC').all();
    const lastRouteTune = numSetting('last_route_tune_ms', 0);
    const lastFilterTune = numSetting('last_filter_tune_ms', 0);
    const lastAudit = numSetting('last_daily_audit_ms', 0);
    const totalClosed = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE status = 'closed'").get().c;
    const nextLearnAt = Math.ceil((totalClosed + 1) / 25) * 25;

    const recent20 = db.prepare(`
      SELECT SUM(CASE WHEN exit_class = 'win' THEN 1 ELSE 0 END) AS wins, COUNT(*) AS total
      FROM (SELECT exit_class FROM dry_run_positions WHERE status = 'closed' ORDER BY closed_at_ms DESC LIMIT 20)
    `).get();
    const recentWr = recent20?.total > 0 ? Math.round((recent20.wins / recent20.total) * 100) : null;
    const wrTrend = recentWr == null ? '—' : recentWr >= 40 ? `${recentWr}% ✅` : recentWr >= 30 ? `${recentWr}% ⚠️` : `${recentWr}% ❌`;

    const ago = (ms) => {
      if (!ms) return 'never';
      const h = Math.floor((Date.now() - ms) / 3_600_000);
      return h < 1 ? 'just now' : `${h}h ago`;
    };

    const routeLines = routeWeights.map(r => {
      const wt = Number(r.weight);
      const tag = wt <= 0.15 ? 'DISABLED ❌' : `${wt.toFixed(2)}x ✅`;
      return `▸ ${escapeHtml(r.route)}: ${tag}`;
    });

    const lines = [
      '🤖 <b>AUTO-TUNER STATUS</b>',
      '',
      '🛣️ <b>Route weights (auto-managed):</b>',
      ...routeLines,
      '',
      `🕐 Last route tune: <b>${ago(lastRouteTune)}</b>`,
      `🕐 Last filter tune: <b>${ago(lastFilterTune)}</b>`,
      `📅 Last daily audit: <b>${ago(lastAudit)}</b>`,
      `📈 Next learn at: <b>trade #${nextLearnAt}</b> (${Math.max(0, nextLearnAt - totalClosed)} more)`,
      '',
      `📊 Win rate trend (last 20): <b>${wrTrend}</b>`,
    ];
    return lines.join('\n');
  } catch (err) {
    return `[autostatus] error: ${err.message}`;
  }
}
