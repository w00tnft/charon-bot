import dotenv from 'dotenv';

dotenv.config();

export const APP_NAME = 'Charon';
export const DB_PATH = process.env.DB_PATH || './charon.sqlite';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const DISC_DIST_FEES = Buffer.from('a537817004b3ca28', 'hex');
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_MINT = 'So11111111111111111111111111111111111111111';

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID;
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
export const GMGN_API_KEY = process.env.GMGN_API_KEY;
export const GMGN_ENABLED = process.env.GMGN_ENABLED !== 'false';
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
export const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOLANA_WS_URL = process.env.SOLANA_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const JUPITER_SWAP_BASE_URL = process.env.JUPITER_SWAP_BASE_URL || 'https://api.jup.ag/swap/v2';
export const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || 300);
export const LIVE_MIN_SOL_RESERVE_LAMPORTS = Math.floor(Number(process.env.LIVE_MIN_SOL_RESERVE || 0.02) * 1_000_000_000);
export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.minimax.io/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'MiniMax-M2.7';

export const GRADUATED_POLL_MS = Number(process.env.GRADUATED_POLL_MS || 30_000);
export const GRADUATED_LOOKBACK_MS = Number(process.env.GRADUATED_LOOKBACK_MS || 2 * 60 * 60 * 1000);
export const TRENDING_POLL_MS = Number(process.env.TRENDING_POLL_MS || 60_000);
export const TRENDING_LOOKBACK_MS = Number(process.env.TRENDING_LOOKBACK_MS || 10 * 60 * 1000);
export const GMGN_CACHE_TTL_MS = Number(process.env.GMGN_CACHE_TTL_MS || 5 * 60 * 1000);
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 8_000);
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';
export const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL || 'http://localhost:3456';
export const SIGNAL_SERVER_KEY = process.env.SIGNAL_SERVER_KEY || '';
export const SIGNAL_POLL_MS = Number(process.env.SIGNAL_POLL_MS || 45_000);
export const LPAGENT_API_KEY = process.env.LPAGENT_API_KEY || '';
export const LPAGENT_BASE_URL = 'https://api.lpagent.io/open-api/v1';
export const REPORT_INTERVAL_MS = Number(process.env.REPORT_INTERVAL_MS || 24 * 60 * 60 * 1000);
export const PUMPPORTAL_ENABLED = process.env.PUMPPORTAL_ENABLED !== 'false';
export const SMART_MONEY_POLL_MS = Number(process.env.SMART_MONEY_POLL_MS || 90_000); // 90s default to avoid Helius rate limits
export const SMART_MONEY_ENABLED = process.env.SMART_MONEY_ENABLED === 'true'; // opt-in; disabled by default
export const WEBHOOK_PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL || '';
export const MIN_WEBHOOK_SOL_THRESHOLD = Number(process.env.MIN_WEBHOOK_SOL_THRESHOLD || 2);
export const POOL_REFRESH_INTERVAL_MS = Number(process.env.POOL_REFRESH_INTERVAL_MS || 1_800_000);
export const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
export const ACCELERATED_DRY_RUN = process.env.ACCELERATED_DRY_RUN === 'true';
export const POSITION_PRICE_CHECK_INTERVAL_MS = Number(process.env.POSITION_PRICE_CHECK_INTERVAL_MS || 8_000);
export const BACKTEST_LOOKBACK_HOURS = Number(process.env.BACKTEST_LOOKBACK_HOURS || 72);
export const BACKTEST_MAX_CANDIDATES = Number(process.env.BACKTEST_MAX_CANDIDATES || 300);
export const BACKTEST_AUTO_RUN = process.env.BACKTEST_AUTO_RUN === 'true';
export const DEXSCREENER_TRENDING_POLL_MS = Number(process.env.DEXSCREENER_TRENDING_POLL_MS || 10 * 60_000);

export const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required.');
  if (!HELIUS_API_KEY && (!process.env.SOLANA_RPC_URL || !process.env.SOLANA_WS_URL)) {
    throw new Error('HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.');
  }
  if (GMGN_ENABLED && !GMGN_API_KEY) throw new Error('GMGN_API_KEY is required unless GMGN_ENABLED=false.');
}
