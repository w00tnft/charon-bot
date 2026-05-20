import express from 'express';
import { EventEmitter } from 'node:events';
import { now } from '../utils.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN_WEBHOOK_SOL = Number(process.env.MIN_WEBHOOK_SOL_THRESHOLD || 2);

export const webhookEmitter = new EventEmitter();

// Parse a single Helius enhanced transaction event and emit a signal if it qualifies.
// Sample payload handled:
// [{
//   type: "SWAP", feePayer: "abc...",
//   tokenTransfers: [{ mint: "tokenMint...", tokenAmount: 1000000 }],
//   nativeTransfers: [{ fromUserAccount: "abc...", amount: 2000000000 }],
//   accountData: [{ account: "abc...", nativeBalanceChange: -2005000000 }]
// }]
function processEvent(event) {
  if (event?.type !== 'SWAP') return;

  const transfers = event.tokenTransfers || [];

  // Find the non-SOL token being acquired in this swap
  const tokenTransfer = transfers.find(
    t => t.mint && t.mint !== WSOL_MINT && Number(t.tokenAmount) > 0
  );
  if (!tokenTransfer) return;
  const mint = tokenTransfer.mint;

  // Derive SOL spent: look for the largest negative native balance change
  let nativeSolAmount = 0;
  const accountData = event.accountData || [];
  for (const acc of accountData) {
    const change = Number(acc.nativeBalanceChange || 0);
    if (change < 0) {
      const sol = Math.abs(change) / 1_000_000_000;
      if (sol > nativeSolAmount) nativeSolAmount = sol;
    }
  }
  // Fallback: sum native transfers if accountData gave nothing
  if (!nativeSolAmount && event.nativeTransfers?.length) {
    nativeSolAmount = (event.nativeTransfers || [])
      .reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0) / 1_000_000_000;
  }

  const sourceWallet = event.feePayer || accountData[0]?.account || '';
  console.log(`[webhook] SWAP — mint: ${mint.slice(0, 8)}… sol: ${nativeSolAmount.toFixed(3)}`);

  if (nativeSolAmount < MIN_WEBHOOK_SOL) {
    console.log(`[webhook] skipped — ${nativeSolAmount.toFixed(3)} SOL < min ${MIN_WEBHOOK_SOL} SOL`);
    return;
  }

  webhookEmitter.emit('signal', { mint, solAmount: nativeSolAmount, sourceWallet, timestamp: now() });
}

export function startHeliusListener() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

  app.post('/webhook', (req, res) => {
    res.status(200).send('ok'); // respond before processing to avoid Helius timeout
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      try { processEvent(event); }
      catch (err) { console.log(`[webhook] parse error: ${err.message}`); }
    }
  });

  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => console.log(`[webhook] Express server listening on port ${port}`));
  return app;
}
