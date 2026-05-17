import { db } from '../db/connection.js';
import { sendTelegram } from './send.js';
import { numSetting, setSetting } from '../db/settings.js';
import { allRouteWeights } from '../learning/weights.js';
import { escapeHtml } from '../format.js';

export function generateSparkline(values) {
  if (!values || values.length < 2) return '▄▄▄▄';
  const samples = values.slice(-16);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  if (max === min) return '▄'.repeat(samples.length);
  const blocks = '▁▂▃▄▅▆▇█';
  return samples.map(v => {
    const idx = Math.round(((v - min) / (max - min)) * 7);
    return blocks[Math.max(0, Math.min(7, idx))];
  }).join('');
}

export function generateBar(weight) {
  const w = Number(weight);
  const blocks = w >= 2.0 ? 10 : Math.max(1, Math.round((w - 0.2) * 5));
  return '█'.repeat(blocks);
}

function startOfTodayMs() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function fmt3(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

function fmt1(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(1);
}

function exitLabel(reason) {
  if (!reason) return 'Unknown';
  const r = reason.toUpperCase();
  if (r === 'TRAILING_STOP') return 'Trailing stop';
  if (r === 'HARD_SL' || r === 'SL') return 'Hard stop';
  if (r === 'MAX_HOLD') return 'Max hold';
  if (r === 'TP' || r === 'TRAILING_TP') return 'Take profit';
  if (r === 'DRY_RUN_TIMEOUT') return 'Timeout';
  return reason.slice(0, 14);
}

const ROUTE_LABEL = {
  fee_claim: 'fee_claim',
  graduated: 'graduated',
  trending: 'trending ',
  multi_source: 'multi    ',
  single_source: 'single   ',
};

export function generateDailyReport() {
  const now = Date.now();
  const todayStart = startOfTodayMs();

  // Today's closed positions
  const todayTrades = db.prepare(`
    SELECT exit_class, pnl_percent, pnl_sol, symbol, mint, exit_reason
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms >= ?
    ORDER BY pnl_percent DESC
  `).all(todayStart);

  const totalToday = todayTrades.length;
  const wins = todayTrades.filter(t => t.exit_class === 'win').length;
  const neutrals = todayTrades.filter(t => t.exit_class === 'neutral').length;
  const losses = totalToday - wins - neutrals;

  // Capital
  const baseSol = numSetting('starting_capital_sol', 1.0);
  const totalPnlSol = Number(db.prepare(
    "SELECT COALESCE(SUM(pnl_sol),0) AS s FROM dry_run_positions WHERE status='closed'"
  ).get().s);
  const currentCapital = baseSol + totalPnlSol;
  const prevPnlSol = Number(db.prepare(
    "SELECT COALESCE(SUM(pnl_sol),0) AS s FROM dry_run_positions WHERE status='closed' AND closed_at_ms < ?"
  ).get(todayStart).s);
  const prevCapital = baseSol + prevPnlSol;
  const changeToday = currentCapital - prevCapital;
  const roiPct = prevCapital > 0 ? (changeToday / prevCapital) * 100 : 0;

  // Sparkline
  const snaps = db.prepare(
    'SELECT capital_sol FROM capital_snapshots ORDER BY id DESC LIMIT 16'
  ).all().map(r => r.capital_sol).reverse();
  const sparkline = generateSparkline(snaps.length >= 2 ? snaps : null);
  const sparkStart = snaps.length > 0 ? snaps[0] : prevCapital;

  // Best and worst today
  const best = todayTrades.length > 0 ? todayTrades[0] : null;
  const worst = todayTrades.length > 0 ? todayTrades[todayTrades.length - 1] : null;

  // Route weights
  const weights = allRouteWeights();

  // Blacklist
  const blackToday = db.prepare(
    "SELECT COUNT(*) AS c FROM blacklist WHERE reason='rug' AND banned_at_ms >= ?"
  ).get(todayStart).c;
  const deplBanned = db.prepare(
    "SELECT COUNT(*) AS c FROM blacklist WHERE reason='deployer_banned' AND banned_at_ms >= ?"
  ).get(todayStart).c;
  const totalBlocked = db.prepare(
    "SELECT COUNT(*) AS c FROM blacklist WHERE reason='rug'"
  ).get().c;

  // Learning
  const lessonsActive = db.prepare(
    "SELECT COUNT(*) AS c FROM learning_lessons WHERE status='active'"
  ).get().c;
  const closedCount = db.prepare(
    "SELECT COUNT(*) AS c FROM dry_run_positions WHERE status='closed'"
  ).get().c;
  const nextLearnAt = (Math.floor(closedCount / 25) + 1) * 25;

  // Mode
  const mode = db.prepare(
    "SELECT value FROM settings WHERE key='trading_mode'"
  ).get()?.value || 'dry_run';

  // Date / time
  const d = new Date(now);
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const timeStr = d.toISOString().slice(11, 16);

  const lines = [
    '⚡ CHARON DAILY REPORT',
    `📅 ${dateStr} ${timeStr} UTC`,
    '━━━━━━━━━━━━━━━━',
    '',
    '💼 CAPITAL',
    `▸ Balance: ${currentCapital.toFixed(3)} SOL`,
    `▸ Change:  ${fmt3(changeToday)} SOL`,
    `▸ ROI:     ${fmt1(roiPct)}%`,
    '',
    '━━━━━━━━━━━━━━━━',
    '',
    "📊 TODAY'S TRADES",
    `▸ Total:   ${totalToday}`,
    `▸ ✅ Win:   ${wins} (${pct(wins, totalToday)}%)`,
    `▸ ⚖️ Ntrl:  ${neutrals} (${pct(neutrals, totalToday)}%)`,
    `▸ ❌ Loss:  ${losses} (${pct(losses, totalToday)}%)`,
    '',
    '━━━━━━━━━━━━━━━━',
    '',
    '📈 CAPITAL TREND',
    sparkline,
    `▸ Start: ${sparkStart.toFixed(3)} SOL`,
    `▸ Now:   ${currentCapital.toFixed(3)} SOL`,
    '',
    '━━━━━━━━━━━━━━━━',
  ];

  if (best) {
    const bestSym = escapeHtml(best.symbol || (best.mint || '').slice(0, 8));
    lines.push('');
    lines.push('🏆 BEST TRADE');
    lines.push(`▸ $${bestSym}`);
    lines.push(`▸ PnL: ${fmt1(Number(best.pnl_percent))}%`);
    lines.push(`▸ Exit: ${exitLabel(best.exit_reason)}`);
  }

  if (worst && worst !== best && totalToday > 1) {
    const worstSym = escapeHtml(worst.symbol || (worst.mint || '').slice(0, 8));
    lines.push('');
    lines.push('💀 WORST TRADE');
    lines.push(`▸ $${worstSym}`);
    lines.push(`▸ PnL: ${fmt1(Number(worst.pnl_percent))}%`);
    lines.push(`▸ Exit: ${exitLabel(worst.exit_reason)}`);
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('🛣️ ROUTE WEIGHTS');

  if (weights.length === 0) {
    lines.push('▸ No data yet');
  } else {
    for (const w of weights) {
      const label = ROUTE_LABEL[w.route] || w.route.slice(0, 9).padEnd(9);
      const bar = generateBar(Number(w.weight));
      lines.push(`▸ ${label} ${bar} ${Number(w.weight).toFixed(1)}x`);
    }
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('🚫 BLACKLIST TODAY');
  lines.push(`▸ Rugs caught: ${blackToday}`);
  lines.push(`▸ Deployers banned: ${deplBanned}`);
  lines.push(`▸ Tokens blocked: ${totalBlocked}`);
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('🧠 LEARNING');
  lines.push(`▸ Lessons active: ${lessonsActive}`);
  lines.push(`▸ Next learn at: ${nextLearnAt}`);
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push(`⚡ Charon v1.0 | ${mode}`);

  return lines.join('\n');
}

export async function sendDailyReport() {
  let report;
  try {
    report = generateDailyReport();
  } catch (err) {
    console.error('[report] generateDailyReport error:', err);
    report = `⚡ CHARON DAILY REPORT\n\n⚠️ Report generation failed:\n${err.message}\n\nCheck logs for details.`;
  }
  try {
    await sendTelegram(report);
    setSetting('last_report_sent_ms', String(Date.now()));
    console.log('[report] daily report sent');
  } catch (err) {
    console.error('[report] sendTelegram error:', err);
    // Try sending a plain-text fallback without HTML parse mode
    try {
      await sendTelegram('Report error: ' + err.message, { parse_mode: undefined });
    } catch {
      console.error('[report] fallback send also failed');
    }
  }
}
