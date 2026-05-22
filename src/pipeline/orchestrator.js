import { now, pruneSeen } from '../utils.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { runCandidateFilter } from '../filters/candidateFilter.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const strat = activeStrategy();
    const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  // Run 3-layer candidate filter — advisory only (logs signals, does not block)
  const preFilter = await runCandidateFilter(signals.mint).catch(err => {
    console.log(`[agent] candidateFilter error for ${signals.mint.slice(0, 8)}: ${err.message} — proceeding`);
    return { passed: true, failures: [] };
  });
  if (!preFilter.passed) {
    console.log(`[agent] ${signals.mint.slice(0, 8)} advisory filter L${preFilter.layer}: ${preFilter.failures[0]} — proceeding`);
  }

  const candidate = await buildCandidate(signals);
  const sym = candidate.token.symbol || signals.mint.slice(0, 8);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${sym}: ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const mcapK = ((candidate.metrics?.marketCapUsd ?? 0) / 1000).toFixed(0);
  console.log(`[candidate] $${sym} PASSED filters — score: ${candidate.safety?.score}/100, mcap: $${mcapK}k, strategy: ${candidate.filters.strategy}`);

  const strat = activeStrategy();
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    if (!selfRow) {
      console.log(`[agent] $${sym} — candidateById(${candidateId}) returned null, skipping`);
      return;
    }
    rows = [selfRow];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  const agentEnabled = boolSetting('agent_enabled', true);
  const minConf = numSetting('llm_min_confidence', 75);
  console.log(`[agent] $${sym} gate check — selectedRow: ${!!selectedRow}, agent_enabled: ${agentEnabled}, verdict: ${batchDecision.verdict}, confidence: ${batchDecision.confidence}/${minConf}`);

  if (selectedRow && agentEnabled && batchDecision.verdict === 'BUY' && batchDecision.confidence >= minConf) {
    if (!canOpenMorePositions()) {
      const strat2 = activeStrategy();
      const max = strat2.max_open_positions ?? numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy $${sym}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence', 75),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const sym2 = selectedRow.candidate?.token?.symbol || selectedRow.candidate?.token?.mint?.slice(0, 8) || '?';
  console.log(`[agent] handleApprovedBuy $${sym2} — mode: ${mode}, refreshing candidate...`);
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    console.log(`[agent] $${sym2} rejected on fresh check: ${(freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'unknown'}`);
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const strat = activeStrategy();
    const deployerAddr = freshSelectedRow.candidate.token?.deployerAddress || null;
    if (deployerAddr) {
      const deployerConflict = db.prepare(`
        SELECT id FROM dry_run_positions
        WHERE status = 'open'
        AND json_extract(snapshot_json, '$.candidate.token.deployerAddress') = ?
        LIMIT 1
      `).get(deployerAddr);
      if (deployerConflict) {
        console.log(`[agent] deployer duplicate skipped: ${deployerAddr.slice(0, 8)}... already has open position #${deployerConflict.id}`);
        logDecisionEvent({
          batchId,
          triggerCandidateId,
          selectedRow: freshSelectedRow,
          rows: executionRows,
          decision,
          mode,
          action: 'dry_run_deployer_duplicate_skipped',
          guardrails: { deployerAddress: deployerAddr, conflictPositionId: deployerConflict.id },
        });
        return;
      }
    }
    console.log(`[agent] DRY-RUN opening $${sym2} — score: ${freshSelectedRow.candidate.safety?.score}/100, mcap: $${((freshSelectedRow.candidate.metrics?.marketCapUsd ?? 0) / 1000).toFixed(0)}k`);
    const { id: positionId, isNew } = createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: isNew ? 'dry_run_entry' : 'dry_run_duplicate_skipped',
      guardrails: { maxOpenPositions: strat.max_open_positions ?? numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId, isNew },
    });
    if (isNew) await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
