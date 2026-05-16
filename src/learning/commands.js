import { bot } from '../telegram/bot.js';
import { sendTelegram } from '../telegram/send.js';
import { now, formatWindow, parseWindowMs } from '../utils.js';
import { escapeHtml } from '../format.js';
import { db } from '../db/connection.js';
import { summarizeLearningWindow } from './summary.js';
import { generateLessons, storeLearningRun } from './lessons.js';
import { learningReportText } from './report.js';
import { recalculateWeights, allRouteWeights } from './weights.js';

function tierStatsText() {
  const rows = db.prepare(`
    SELECT exit_class, COUNT(*) AS count
    FROM dry_run_positions
    WHERE status = 'closed'
    GROUP BY exit_class
  `).all();
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0) return null;
  const byClass = Object.fromEntries(rows.map(r => [r.exit_class || 'loss', r.count]));
  const wins = byClass.win || 0;
  const neutrals = byClass.neutral || 0;
  const losses = byClass.loss || 0;
  const netScore = wins - losses;
  const netIcon = netScore > 0 ? '✅' : netScore < 0 ? '⚠️' : '➡️';
  const pct = n => `${Math.round(n / total * 100)}%`;
  return [
    '📊 <b>Exit Classification</b>',
    `✅ Wins: <b>${wins}</b> (${pct(wins)})`,
    `⚖️ Neutral: <b>${neutrals}</b> (${pct(neutrals)})`,
    `❌ Losses: <b>${losses}</b> (${pct(losses)})`,
    `Net score: <b>${netScore > 0 ? '+' : ''}${netScore}</b> ${netIcon}`,
  ].join('\n');
}

function weightsText(weights) {
  const lines = ['📊 <b>ROUTE WEIGHTS UPDATED</b>'];
  for (const w of weights) {
    const wt = Number(w.weight);
    const icon = wt >= 1.5 ? '🔥' : wt >= 1.0 ? '✅' : wt >= 0.7 ? '⚠️' : '❌';
    const mark = wt >= 1.0 ? ' ✅' : '';
    lines.push(`${icon} ${escapeHtml(w.route)}: ${wt.toFixed(1)}x${mark}`);
  }
  if (weights.length === 0) lines.push('No closed positions yet — weights remain at default 1.0x');
  return lines.join('\n');
}

export async function runLearning(chatId, windowArg = '12h') {
  const windowMs = parseWindowMs(windowArg);
  await bot.sendMessage(chatId, `Learning from the last ${formatWindow(windowMs)}...`);
  const summary = summarizeLearningWindow(windowMs);
  const { lessons, raw } = await generateLessons(summary);
  const runId = storeLearningRun(windowMs, summary, lessons, raw);
  await bot.sendMessage(chatId, learningReportText(runId, summary, lessons), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  const updated = recalculateWeights();
  const weights = updated.length > 0 ? updated.map(r => ({
    route: r.route, weight: r.weight,
  })) : allRouteWeights();
  return bot.sendMessage(chatId, weightsText(weights), { parse_mode: 'HTML' });
}

export async function autoRunLearning(milestone) {
  const windowMs = 12 * 60 * 60 * 1000;
  const summary = summarizeLearningWindow(windowMs);
  const { lessons, raw } = await generateLessons(summary);
  const runId = storeLearningRun(windowMs, summary, lessons, raw);
  await sendTelegram(`🧠 <b>Charon learning triggered</b> — reviewing last ${milestone} trades`);
  await sendTelegram(learningReportText(runId, summary, lessons));
  const tierText = tierStatsText();
  if (tierText) await sendTelegram(tierText);
  recalculateWeights();
  await sendTelegram(weightsText(allRouteWeights()));
}

export async function sendLessons(chatId) {
  const rows = db.prepare(`
    SELECT id, created_at_ms, lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 10
  `).all();
  const text = rows.length
    ? rows.map((row, index) => `${index + 1}. ${escapeHtml(row.lesson)}`).join('\n')
    : 'No active lessons yet. Run /learn 12h after some dry-run exits.';
  return bot.sendMessage(chatId, `🧠 <b>Active Lessons</b>\n\n${text}`, { parse_mode: 'HTML' });
}
