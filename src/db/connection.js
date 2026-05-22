import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
    CREATE TABLE IF NOT EXISTS route_weights (
      route TEXT PRIMARY KEY,
      win_count INTEGER DEFAULT 0,
      loss_count INTEGER DEFAULT 0,
      avg_pnl_pct REAL DEFAULT 0,
      weight REAL DEFAULT 1.0,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT,
      deployer TEXT,
      reason TEXT NOT NULL,
      pnl_percent REAL,
      banned_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blacklist_mint ON blacklist(mint);
    CREATE INDEX IF NOT EXISTS idx_blacklist_deployer ON blacklist(deployer);
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployer TEXT NOT NULL,
      mint TEXT,
      reason TEXT NOT NULL,
      pnl_percent REAL,
      whitelisted_at_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_whitelist_deployer ON whitelist(deployer);
    CREATE TABLE IF NOT EXISTS capital_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_at TEXT DEFAULT (datetime('now')),
      capital_sol REAL NOT NULL,
      trade_number INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smart_wallets (
      label TEXT PRIMARY KEY,
      address TEXT,
      win_rate REAL DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      avg_pnl_pct REAL DEFAULT 0,
      last_seen TEXT,
      added_at TEXT,
      active INTEGER DEFAULT 1
    );
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'partial_exit_notified', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'exit_class', 'TEXT');
  ensureColumn('dry_run_positions', 'signal_route', 'TEXT');
  ensureColumn('dry_run_positions', 'source', "TEXT DEFAULT 'webhook'");
  ensureColumn('dry_run_positions', 'filter_score', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'signals_json', "TEXT DEFAULT '{}'")
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');

  const weightInsert = db.prepare('INSERT OR IGNORE INTO route_weights (route, win_count, loss_count, avg_pnl_pct, weight, updated_at_ms) VALUES (?, 0, 0, 0, 1.0, ?)');
  for (const route of ['fee_claim', 'graduated', 'trending', 'multi_source', 'single_source']) {
    weightInsert.run(route, Date.now());
  }
  // Reset any weights below the minimum floor (0.75) — fixes crash-period weight deadlocks
  const resetCount = db.prepare('UPDATE route_weights SET weight = 1.0 WHERE weight < 0.75').run().changes;
  if (resetCount > 0) console.log(`[weights] reset ${resetCount} route weight(s) below floor to 1.0x`);

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    starting_capital_sol: '1.0',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // ENV VAR ALWAYS WINS for trading_mode — INSERT OR IGNORE would silently ignore changes
  // after first startup, causing TRADING_MODE=live on Railway to have no effect.
  if (process.env.TRADING_MODE) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('trading_mode', ?)").run(process.env.TRADING_MODE);
  }
  const tradingMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value ?? 'dry_run';
  console.log(`[config] trading_mode: ${tradingMode}${process.env.TRADING_MODE ? ' (from env var)' : ' (from db — set TRADING_MODE env var to override)'}`);

  // Seed default strategies
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  stratInsert.run('sniper', 'Sniper', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 3600000,
    min_mcap_usd: 7000,
    max_mcap_usd: 200000,
    min_fee_claim_sol: 0.5,
    min_gmgn_total_fee_sol: 10,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: true,
    trailing_percent: 20,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 50,
  }), ts);

  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 25000,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -40,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 3,
    tp_percent: 30,
    sl_percent: -20,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 60,
  }), ts);

  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 10000,
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 1000,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 100,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 100,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  stratInsert.run('degen', 'Degen', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 500000,
    max_mcap_usd: 5000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.03,
    max_open_positions: 10,
    exit_type: 'full',
    take_profit_pct: 25,
    partial_exit_pct: 0,
    partial_exit_size: 0,
    trailing_stop_pct: 0,
    hard_stop_pct: 15,
    emergency_stop_pct: 40,
    max_hold_ms: 14400000,
    use_llm: false,
    llm_min_confidence: 0,
    min_safety_score: 65,
    route_min_scores: {
      fee_trending:           60,
      fee_graduated:          70,
      graduated_trending:     999,
      single_source:          65,
      fee_graduated_trending: 90,
      multi_source:           65,
      dual_source:            65,
      pumpportal_survivor:    60,
      webhook:                60,
    },
  }), ts);

  // ── Migrations (run on every startup, idempotent) ────────────────────────

  // Ensure degen is active when sniper is the only enabled strategy (old DB default).
  const active = db.prepare('SELECT id FROM strategies WHERE enabled = 1').get();
  if (!active || active.id === 'sniper') {
    db.prepare('UPDATE strategies SET enabled = 0').run();
    db.prepare("UPDATE strategies SET enabled = 1 WHERE id = 'degen'").run();
  }

  // Apply all current degen settings to existing DBs (INSERT OR IGNORE won't update them).
  const degenMigrations = {
    min_source_count: 2,
    min_mcap_usd: 10000,
    max_mcap_usd: 500000,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.03,
    max_open_positions: 10,
    exit_type: 'full',
    take_profit_pct: 25,
    partial_exit_pct: 0,
    partial_exit_size: 0,
    trailing_stop_pct: 0,
    hard_stop_pct: 15,
    emergency_stop_pct: 40,
    max_hold_ms: 14400000,
    min_safety_score: 65,
  };
  const degenMigrationSql = Object.entries(degenMigrations)
    .map(([k, v]) => `json_set(config_json, '$.${k}', ${typeof v === 'number' ? v : `'${v}'`})`)
    .reduce((acc, expr) => `${expr.replace('config_json', acc)}`);
  db.prepare(`UPDATE strategies SET config_json = ${degenMigrationSql} WHERE id = 'degen'`).run();

  // Migrate route_min_scores (object value — handled separately from scalar migrations)
  db.prepare(`
    UPDATE strategies SET config_json = json_set(config_json, '$.route_min_scores', json(?)) WHERE id = 'degen'
  `).run(JSON.stringify({
    fee_trending:           60,
    fee_graduated:          70,
    graduated_trending:     999,
    single_source:          65,
    fee_graduated_trending: 90,
    multi_source:           65,
    dual_source:            65,
    pumpportal_survivor:    60,
    webhook:                60,
  }));

  // Log active degen config so we can confirm migration values on every startup
  const degenRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'degen'").get();
  if (degenRow) {
    const cfg = JSON.parse(degenRow.config_json);
    console.log(
      `[config] degen filters: mcap $${(cfg.min_mcap_usd / 1000).toFixed(0)}k-$${(cfg.max_mcap_usd / 1000).toFixed(0)}k` +
      ` | vol $${cfg.trending_min_volume_usd}` +
      ` | swaps ${cfg.trending_min_swaps}` +
      ` | safety ${cfg.min_safety_score}` +
      ` | max_positions ${cfg.max_open_positions}` +
      ` | hold ${cfg.max_hold_ms / 60000}min` +
      ` | use_llm ${cfg.use_llm}`
    );
    const tpPct = cfg.take_profit_pct ?? '?';
    const slPct = cfg.hard_stop_pct ?? '?';
    const emPct = cfg.emergency_stop_pct ?? '?';
    const exitType = cfg.exit_type ?? 'legacy';
    const ok = cfg.emergency_stop_pct != null && cfg.take_profit_pct != null ? '✅' : '⚠️ MISSING FIELDS';
    console.log(`[config] exit: TP +${tpPct}% ${exitType} | SL -${slPct}% | Emergency -${emPct}% ${ok}`);
  }

  // Log agent gate settings so misconfigurations are visible at startup
  const agentEnabled = db.prepare("SELECT value FROM settings WHERE key = 'agent_enabled'").get()?.value ?? 'true (default)';
  console.log(`[config] agent_enabled: ${agentEnabled}`);

  // ── DRY_RUN_STARTING_BALANCE — seed starting capital from env if provided ──
  if (process.env.DRY_RUN_STARTING_BALANCE) {
    const bal = Number(process.env.DRY_RUN_STARTING_BALANCE);
    if (Number.isFinite(bal) && bal > 0) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('starting_capital_sol', ?)").run(String(bal));
      console.log(`[config] starting_capital_sol set to ${bal} SOL (from DRY_RUN_STARTING_BALANCE)`);
    }
  }

  // ── PIVOT_CLEAN migration — runs once when PIVOT_CLEAN=true ─────────────
  // Protected by a DB flag so it never re-runs even if the env var stays set.
  if (process.env.PIVOT_CLEAN === 'true') {
    const alreadyDone = db.prepare("SELECT value FROM settings WHERE key = 'pivot_clean_done'").get();
    if (alreadyDone) {
      console.log('[pivot] PIVOT_CLEAN=true but migration already ran — skipping');
    } else {
      console.log('[pivot] PIVOT_CLEAN=true — clearing trade history for mid-cap pivot...');
      db.transaction(() => {
        db.prepare('DELETE FROM dry_run_positions').run();
        db.prepare('DELETE FROM dry_run_trades').run();
        db.prepare('DELETE FROM capital_snapshots').run();
        db.prepare('DELETE FROM tp_sl_rules').run();
        db.prepare("UPDATE route_weights SET win_count = 0, loss_count = 0, avg_pnl_pct = 0, updated_at_ms = ?").run(Date.now());
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_auto_learn_count', '0')").run();
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pivot_clean_done', '1')").run();
      })();
      console.log('[pivot] Trade history cleared for mid-cap pivot');
      console.log('[pivot] Blacklist preserved');
      console.log('[pivot] Set PIVOT_CLEAN=false in Railway to prevent re-running');
    }
  }
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
