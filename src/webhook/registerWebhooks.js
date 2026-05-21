import axios from 'axios';
import { HELIUS_API_KEY } from '../config.js';

const HELIUS_BASE = 'https://api.helius.xyz/v0';

export async function registerWebhook(poolAddresses) {
  const webhookUrl = process.env.WEBHOOK_PUBLIC_URL;
  if (!webhookUrl) {
    console.log('[webhook] WEBHOOK_PUBLIC_URL not set');
    console.log('[webhook] Running in POLL-ONLY mode');
    console.log('[webhook] Set WEBHOOK_PUBLIC_URL in Railway');
    console.log('[webhook] to enable real-time Helius signals');
    return null;
  }
  if (!HELIUS_API_KEY) {
    console.log('[webhook] HELIUS_API_KEY not set — skipping Helius registration');
    return null;
  }
  if (!poolAddresses || poolAddresses.length === 0) {
    console.log('[webhook] No pool addresses yet');
    console.log('[webhook] Skipping Helius registration');
    console.log('[webhook] Will retry on next pool refresh');
    return null;
  }
  try {
    const r = await axios.post(
      `${HELIUS_BASE}/webhooks?api-key=${HELIUS_API_KEY}`,
      {
        webhookURL: webhookUrl + '/webhook',
        transactionTypes: ['SWAP'],
        accountAddresses: poolAddresses,
        webhookType: 'enhanced',
      },
      { timeout: 15_000 },
    );
    const id = r.data?.webhookID;
    console.log(`[webhook] Registered with Helius — id: ${id}, watching ${poolAddresses.length} pool(s)`);
    return id;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.log(`[webhook] Helius registration failed: ${msg}`);
    return null;
  }
}

export async function updateWebhookAddresses(webhookId, poolAddresses) {
  if (!webhookId || !HELIUS_API_KEY) return;
  try {
    await axios.put(
      `${HELIUS_BASE}/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`,
      { accountAddresses: poolAddresses },
      { timeout: 15_000 },
    );
    console.log(`[webhook] Updated webhook ${webhookId} — ${poolAddresses.length} pool(s)`);
  } catch (err) {
    console.log(`[webhook] Helius update failed: ${err.message}`);
  }
}
