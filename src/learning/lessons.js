import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';

export function fallbackLessons(summary) {
  const lessons = [];
  const byRoute = summary.positions.byRoute || [];
  const bestRoute = [...byRoute].sort((a, b) => (b.avgPnlPercent ?? 0) - (a.avgPnlPercent ?? 0))[0];
  const worstRoute = [...byRoute].sort((a, b) => (a.avgPnlPercent ?? 0) - (b.avgPnlPercent ?? 0))[0];
  if (bestRoute && bestRoute.count >= 2 && (bestRoute.avgPnlPercent ?? 0) > 0) {
    lessons.push({
      lesson: `USE ${bestRoute.route} — showed ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} trades`,
      evidence: bestRoute,
    });
  }
  if (worstRoute && worstRoute.count >= 2 && (worstRoute.avgPnlPercent ?? 0) < 0) {
    lessons.push({
      lesson: `AVOID ${worstRoute.route} — showed ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} trades`,
      evidence: worstRoute,
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL' || row.exitReason === 'HARD_SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `AVOID late entries — ${slCount} recent worst exits hit stop-loss; require stronger mcap/liquidity confirmation before buy`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed evidence yet; keep collecting positions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
    });
  }
  return lessons.slice(0, 6);
}

export async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are Charon learning from dry-run trading evidence.',
            'Return strict JSON only.',
            'Do not invent trades or outcomes.',
            'Create compact operational lessons that can improve the next screening prompt.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Analyze this dry-run window and produce up to 6 lessons for future candidate screening.',
            output_schema: {
              lessons: [{ lesson: 'short actionable rule', evidence: 'specific supporting data' }],
            },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => ({
          lesson: String(item.lesson || '').slice(0, 500),
          evidence: item.evidence ?? {},
        })).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] LLM failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);

  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
    VALUES (?, ?, 'active', ?, ?)
  `);
  const upsertExisting = db.prepare(`
    UPDATE learning_lessons SET run_id = ?, created_at_ms = ?, lesson = ?, evidence_json = ? WHERE id = ?
  `);

  for (const item of lessons) {
    const route = item.evidence?.route ?? null;
    let replaced = false;
    if (route) {
      const isNegative = item.lesson.toUpperCase().startsWith('AVOID') || item.lesson.toLowerCase().startsWith('be stricter');
      const existing = db.prepare(`
        SELECT id FROM learning_lessons
        WHERE status = 'active'
          AND json_extract(evidence_json, '$.route') = ?
          AND (
            (? AND (lesson LIKE 'AVOID%' OR lesson LIKE 'Be stricter%'))
            OR (NOT ? AND lesson NOT LIKE 'AVOID%' AND lesson NOT LIKE 'Be stricter%')
          )
        ORDER BY created_at_ms DESC LIMIT 1
      `).get(route, isNegative ? 1 : 0, isNegative ? 1 : 0);
      if (existing) {
        upsertExisting.run(runId, now(), item.lesson, json(item.evidence || {}), existing.id);
        replaced = true;
      }
    }
    if (!replaced) insert.run(runId, now(), item.lesson, json(item.evidence || {}));
  }
  return runId;
}

export function deduplicateLessons() {
  const lessons = db.prepare(`
    SELECT id, lesson, json_extract(evidence_json, '$.route') AS route
    FROM learning_lessons WHERE status = 'active' AND json_extract(evidence_json, '$.route') IS NOT NULL
    ORDER BY created_at_ms DESC
  `).all();

  const seen = new Set();
  const toArchive = [];
  for (const { id, lesson, route } of lessons) {
    const isNeg = lesson.toUpperCase().startsWith('AVOID') || lesson.toLowerCase().startsWith('be stricter');
    const key = `${route}:${isNeg ? 'neg' : 'pos'}`;
    if (seen.has(key)) {
      toArchive.push(id);
    } else {
      seen.add(key);
    }
  }

  if (toArchive.length > 0) {
    db.prepare(`UPDATE learning_lessons SET status = 'archived' WHERE id IN (${toArchive.map(() => '?').join(',')})`)
      .run(...toArchive);
    console.log(`[learn] dedup: archived ${toArchive.length} duplicate lesson(s), ${seen.size} active remain`);
  }
}
