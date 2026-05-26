import { now, json } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, openPositionCount } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram, safeSend } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';
import { acquireLock, releaseLock } from '../utils/txLock.js';
import { verifyNoPosition } from '../utils/balanceCheck.js';
import { liveWalletPubkey } from '../liveExecutor.js';

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mint = selectedRow.candidate.token.mint;
  const lockKey = `buy:${mint}`;
  if (!acquireLock(lockKey, 'buy')) {
    throw new Error(`Buy already in progress for ${mint} — duplicate execution blocked`);
  }
  try {
    // Verify no existing token balance before buying (prevents double-entry)
    const wallet = liveWalletPubkey();
    if (wallet) {
      const clean = await verifyNoPosition(wallet, mint);
      if (!clean) throw new Error(`Token balance already detected for ${mint} — skipping duplicate buy`);
    }
    const strat = activeStrategy();
    const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
    }
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(mint) || swap.outputAmount;
    }
    const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode: 'live',
      action: 'live_entry_executed',
      guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
      execution: { positionId, swap },
    });
    await sendPositionOpen(positionId);
  } finally {
    releaseLock(lockKey);
  }
}

export async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return safeSend(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return safeSend(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return safeSend(chatId, [
        'TRADE INTENT REJECTED (fresh check)',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${(freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed'}`,
      ].join('\n'), { disable_web_page_preview: true });
    }
    const mint = freshRow.candidate.token.mint;
    const lockKey = `buy:${mint}`;
    if (!acquireLock(lockKey, 'buy')) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_duplicate', now(), intentId);
      return safeSend(chatId, `Buy already in progress for this token — duplicate execution blocked.`);
    }
    try {
    const wallet = liveWalletPubkey();
    if (wallet) {
      const clean = await verifyNoPosition(wallet, mint);
      if (!clean) {
        db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_duplicate', now(), intentId);
        releaseLock(lockKey);
        return safeSend(chatId, `Token balance already detected — skipping duplicate buy.`);
      }
    }
    const strat = activeStrategy();
    const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return safeSend(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`);
    }
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(mint) || swap.outputAmount;
    }
    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, swap },
    });
    return sendPositionOpen(positionId);
    } catch (err) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
      return safeSend(chatId, `Live execution failed: ${err.message}`);
    } finally {
      releaseLock(lockKey);
    }
  } catch (err) {
    return safeSend(chatId, `Execution error: ${err.message}`);
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return safeSend(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return safeSend(chatId, `Rejected trade intent #${intentId}.`);
}
