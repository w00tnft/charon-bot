// Helius token balance verification — guards against duplicate live buys
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

export async function checkTokenBalance(walletAddress, mint) {
  if (!HELIUS_API_KEY || !walletAddress) return -1;
  try {
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${HELIUS_API_KEY}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return -1;
    const data = await resp.json();
    const tokens = data?.tokens || [];
    const token = tokens.find(t => t.mint === mint);
    return token?.amount ?? 0;
  } catch (err) {
    console.error('[balance] check failed:', err.message);
    return -1; // unknown — fail safe
  }
}

export async function verifyNoPosition(walletAddress, mint) {
  const balance = await checkTokenBalance(walletAddress, mint);
  if (balance === -1) return true; // unknown — allow, don't block trade
  if (balance > 0) {
    console.log(`[balance] WARNING: already hold ${mint} on-chain (${balance})`);
    return false;
  }
  return true;
}
