// Helius token balance verification — guards against duplicate live buys
const HELIUS_URL = process.env.SOLANA_RPC_URL || '';

export async function checkTokenBalance(walletAddress, mint) {
  if (!HELIUS_URL || !walletAddress) return null;
  try {
    const resp = await fetch(HELIUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          { mint },
          { encoding: 'jsonParsed' },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const accounts = data?.result?.value || [];
    if (!accounts.length) return 0;
    const amount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    return typeof amount === 'number' ? amount : null;
  } catch {
    return null; // fail-safe — never block a trade on RPC timeout
  }
}

export async function verifyNoPosition(walletAddress, mint) {
  const balance = await checkTokenBalance(walletAddress, mint);
  if (balance === null) return true; // unknown — allow
  return balance === 0;
}
