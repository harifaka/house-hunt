const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Database access layer backed by the Cloudflare D1 HTTP REST API.
 *
 * The app runs on a stateless container (Google Cloud Run) without any
 * filesystem or Cloudflare Worker bindings, so every query is sent over
 * HTTPS to:
 *
 *   https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<db>/query
 *
 * The public API mirrors the previous SQLite wrapper (`getDb()` returns an
 * object exposing `prepare(sql).get/all/run`, `exec`, `transaction`, `close`)
 * so call sites keep working unchanged.
 */

const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// Transactions collect statements in the async context of their caller, so
// concurrent HTTP requests never share a batch.
const transactionScope = new AsyncLocalStorage();

let sharedConnection = null;

function getD1Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  const missing = [
    ['CLOUDFLARE_ACCOUNT_ID', accountId],
    ['CLOUDFLARE_D1_DATABASE_ID', databaseId],
    ['CLOUDFLARE_API_TOKEN', apiToken]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Cloudflare D1 is not configured. Missing environment variable(s): ${missing.join(', ')}. ` +
      'Set them in your environment (see .env.example) before starting the app.'
    );
  }

  return {
    accountId,
    databaseId,
    apiToken,
    apiBase: (process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '')
  };
}

function isD1Configured() {
  try {
    getD1Config();
    return true;
  } catch {
    return false;
  }
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

/**
 * Flatten `run([a, b])` / `run(a, b)` into a positional parameter array.
 * D1 binds an array of scalars to `?` placeholders in order.
 */
function normalizeParams(params) {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map(normalizeValue);
}

function describeErrors(payload) {
  if (!payload) return '';
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors.map(error => (error && error.message) ? error.message : String(error)).join('; ');
  }
  if (payload.error) return String(payload.error);
  return '';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeResults(payload) {
  const result = payload && payload.result;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') return [result];
  return [];
}

function isRetryable(error) {
  if (error && typeof error.retryable === 'boolean') return error.retryable;
  if (!error) return false;
  return error.name === 'TimeoutError'
    || error.name === 'AbortError'
    || error.name === 'FetchError'
    || error.name === 'TypeError';
}

/**
 * POST a query or batch payload to the D1 REST endpoint.
 * Transient failures (network, 429, 5xx) are retried with backoff.
 */
async function postToD1(body) {
  const config = getD1Config();
  const url = `${config.apiBase}/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      const raw = await response.text();
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }

      if (!response.ok || !payload || payload.success === false) {
        const details = describeErrors(payload) || raw.slice(0, 500) || response.statusText;
        const error = new Error(`Cloudflare D1 request failed (HTTP ${response.status}): ${details}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryable(error)) break;
      await delay(200 * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

async function executeStatement(sql, params) {
  const payload = await postToD1({ sql, params });
  const [first] = normalizeResults(payload);
  return {
    rows: (first && Array.isArray(first.results)) ? first.results : [],
    meta: (first && first.meta) || {}
  };
}

async function executeBatch(statements) {
  const payload = await postToD1({ batch: statements });
  return normalizeResults(payload);
}

class D1Statement {
  constructor(connection, sql) {
    this.connection = connection;
    this.sql = sql;
  }

  async get(...params) {
    const { rows } = await this.connection._execute(this.sql, normalizeParams(params));
    return rows[0];
  }

  async all(...params) {
    const { rows } = await this.connection._execute(this.sql, normalizeParams(params));
    return rows;
  }

  async run(...params) {
    const { meta } = await this.connection._execute(this.sql, normalizeParams(params));
    return { changes: meta.changes || 0, lastInsertRowid: meta.last_row_id || 0 };
  }
}

class D1Connection {
  prepare(sql) {
    return new D1Statement(this, sql);
  }

  /**
   * Execute a statement immediately, or queue it when the caller is inside a
   * `transaction()` block so it can be sent as one atomic D1 batch.
   */
  async _execute(sql, params) {
    const queue = transactionScope.getStore();
    if (queue) {
      queue.push({ sql, params });
      return { rows: [], meta: {} };
    }
    return executeStatement(sql, params);
  }

  /**
   * Execute one or more statements. D1 runs a semicolon-separated string as
   * a batch (transaction), which is how the schema migration is applied.
   */
  async exec(sql) {
    const queue = transactionScope.getStore();
    if (queue) {
      for (const statement of splitSqlStatements(sql)) {
        queue.push({ sql: statement, params: [] });
      }
      return;
    }
    await executeStatement(sql, []);
  }

  /**
   * Run a group of write statements atomically. D1 has no interactive
   * transactions over HTTP, so statements issued inside the callback are
   * queued in the caller's async context and submitted through the batch
   * endpoint, which is transactional.
   *
   * Reads issued inside the callback would not observe the queued writes and
   * are therefore not supported — all current call sites only write here.
   */
  async transaction(callback) {
    if (transactionScope.getStore()) return callback(this);

    const queue = [];
    await transactionScope.run(queue, async () => {
      await callback(this);
    });

    if (queue.length > 0) await executeBatch(queue);
  }

  /** Kept for API compatibility: HTTP queries have no connection to release. */
  async close() {}
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'") {
      inString = !inString;
      current += char;
      continue;
    }
    if (char === ';' && !inString) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Returns the shared D1 connection. It holds no socket state, so a single
 * instance is reused across requests; `close()` is a no-op.
 */
async function getDb() {
  if (!sharedConnection) sharedConnection = new D1Connection();
  return sharedConnection;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS houses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    asking_price REAL,
    notes TEXT,
    description TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    option_id TEXT,
    notes TEXT,
    image_path TEXT,
    image_description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE,
    UNIQUE(house_id, question_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scraped_properties (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE,
    title TEXT,
    price REAL,
    price_text TEXT,
    location TEXT,
    city TEXT,
    size_sqm REAL,
    rooms INTEGER,
    description TEXT,
    property_type TEXT,
    listing_id TEXT,
    image_urls TEXT,
    scraped_data TEXT,
    llm_analysis TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS city_info (
    id TEXT PRIMARY KEY,
    city_name TEXT NOT NULL UNIQUE,
    population INTEGER,
    gdp_info TEXT,
    security_info TEXT,
    infrastructure TEXT,
    current_mayor TEXT,
    previous_mayor TEXT,
    general_info TEXT,
    extra_data TEXT,
    avg_price REAL,
    median_price REAL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS property_reports (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    city TEXT,
    property_ids TEXT,
    city_info_id TEXT,
    report_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (city_info_id) REFERENCES city_info(id)
  );

  CREATE TABLE IF NOT EXISTS ai_reports (
    id TEXT PRIMARY KEY,
    house_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    section_name TEXT,
    report_text TEXT,
    summary TEXT,
    lang TEXT DEFAULT 'hu',
    input_snapshot TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS image_descriptions (
    id TEXT PRIMARY KEY,
    image_hash TEXT NOT NULL UNIQUE,
    image_path TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL DEFAULT 'info',
    category TEXT NOT NULL,
    event TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS house_images (
    id TEXT PRIMARY KEY,
    house_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    caption TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS heating_calculations (
    id TEXT PRIMARY KEY,
    house_id TEXT,
    name TEXT NOT NULL,
    parameters TEXT NOT NULL,
    results TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS window_door_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'double',
    u_value REAL NOT NULL DEFAULT 2.8,
    is_standard INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS energy_calculations (
    id TEXT PRIMARY KEY,
    house_id TEXT,
    name TEXT NOT NULL,
    parameters TEXT NOT NULL,
    results TEXT NOT NULL,
    ai_analysis TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS energy_item_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_hu TEXT,
    wattage REAL NOT NULL DEFAULT 0,
    duty_cycle REAL NOT NULL DEFAULT 100,
    daily_hours REAL NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'other',
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_answers_house_id ON answers (house_id);
  CREATE INDEX IF NOT EXISTS idx_house_images_house_id ON house_images (house_id);
  CREATE INDEX IF NOT EXISTS idx_ai_reports_house_id ON ai_reports (house_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);
`;

async function getTableColumns(db, table) {
  return db.prepare(`SELECT name, "notnull" FROM pragma_table_info('${table}')`).all();
}

/**
 * Create every table/index (idempotent) and apply column-level migrations.
 * Runs automatically on startup, so a fresh D1 database bootstraps itself.
 */
async function initDb() {
  const db = await getDb();

  await db.exec(SCHEMA_SQL);

  const scrapedPropertyColumns = await getTableColumns(db, 'scraped_properties');
  if (scrapedPropertyColumns.some(column => column.name === 'url' && column.notnull)) {
    await db.transaction(async () => {
      await db.exec(`
        CREATE TABLE scraped_properties_nullable_url (
          id TEXT PRIMARY KEY,
          url TEXT UNIQUE,
          title TEXT,
          price REAL,
          price_text TEXT,
          location TEXT,
          city TEXT,
          size_sqm REAL,
          rooms INTEGER,
          description TEXT,
          property_type TEXT,
          listing_id TEXT,
          image_urls TEXT,
          scraped_data TEXT,
          llm_analysis TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO scraped_properties_nullable_url SELECT * FROM scraped_properties;
        DROP TABLE scraped_properties;
        ALTER TABLE scraped_properties_nullable_url RENAME TO scraped_properties;
      `);
    });
  }

  const answerColumns = (await getTableColumns(db, 'answers')).map(column => column.name);
  if (!answerColumns.includes('image_description')) {
    await db.exec('ALTER TABLE answers ADD COLUMN image_description TEXT');
  }

  const houseColumns = (await getTableColumns(db, 'houses')).map(column => column.name);
  if (!houseColumns.includes('description')) {
    await db.exec('ALTER TABLE houses ADD COLUMN description TEXT');
  }
  if (!houseColumns.includes('source')) {
    await db.exec("ALTER TABLE houses ADD COLUMN source TEXT DEFAULT 'manual'");
  }

  const settings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  await db.transaction(async () => {
    await settings.run('language', 'hu');
    await settings.run('app_title', 'House Hunt');
  });

  await seedWindowDoorTemplates(db);
  await seedEnergyItemTemplates(db);
}

async function seedWindowDoorTemplates(db) {
  const existing = await db.prepare('SELECT COUNT(*) as count FROM window_door_templates').get();
  if (existing && existing.count > 0) return;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO window_door_templates (id, name, width, height, type, u_value, is_standard) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const templates = [
    ['std_1', 'Standard window 120×150', 1.2, 1.5, 'double', 2.8, 1],
    ['std_2', 'Standard window 90×150', 0.9, 1.5, 'double', 2.8, 1],
    ['std_3', 'Standard window 60×60', 0.6, 0.6, 'double', 2.8, 1],
    ['std_4', 'Large window 180×150', 1.8, 1.5, 'double', 2.8, 1],
    ['std_5', 'Balcony door 90×210', 0.9, 2.1, 'double', 2.8, 1],
    ['std_6', 'Front door 100×210', 1.0, 2.1, 'double', 2.8, 1],
    ['std_7', 'Double front door 140×210', 1.4, 2.1, 'double', 2.8, 1],
    ['std_8', 'Interior door 80×210', 0.8, 2.1, 'single', 5.8, 1]
  ];

  await db.transaction(async () => {
    for (const template of templates) {
      await insert.run(...template);
    }
  });
}

async function seedEnergyItemTemplates(db) {
  const existing = await db.prepare('SELECT COUNT(*) as count FROM energy_item_templates').get();
  if (existing && existing.count > 0) return;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO energy_item_templates (id, name, name_hu, wattage, duty_cycle, daily_hours, category, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const defaultItems = [
    ['ei_1', 'LED Ceiling Light', 'LED mennyezeti lámpa', 12, 100, 5, 'lighting', 1],
    ['ei_2', 'LED Desk Lamp', 'LED asztali lámpa', 8, 100, 4, 'lighting', 1],
    ['ei_3', 'Halogen Spotlight', 'Halogén spotlámpa', 50, 100, 3, 'lighting', 1],
    ['ei_4', 'Refrigerator', 'Hűtőszekrény', 150, 40, 24, 'kitchen', 1],
    ['ei_5', 'Freezer', 'Fagyasztó', 200, 40, 24, 'kitchen', 1],
    ['ei_6', 'Oven', 'Sütő', 2000, 50, 1, 'kitchen', 1],
    ['ei_7', 'Microwave', 'Mikrohullámú sütő', 800, 50, 0.3, 'kitchen', 1],
    ['ei_8', 'Dishwasher', 'Mosogatógép', 1800, 50, 1, 'kitchen', 1],
    ['ei_9', 'Electric Kettle', 'Vízforraló', 2000, 100, 0.2, 'kitchen', 1],
    ['ei_10', 'Coffee Machine', 'Kávéfőző', 1000, 50, 0.3, 'kitchen', 1],
    ['ei_11', 'Washing Machine', 'Mosógép', 500, 50, 1, 'laundry', 1],
    ['ei_12', 'Dryer', 'Szárítógép', 2500, 50, 1, 'laundry', 1],
    ['ei_13', 'Iron', 'Vasaló', 2000, 50, 0.5, 'laundry', 1],
    ['ei_14', 'TV (LED 55")', 'Televízió (LED 55")', 100, 100, 4, 'entertainment', 1],
    ['ei_15', 'Gaming Console (Xbox/PS)', 'Játékkonzol (Xbox/PS)', 150, 80, 3, 'entertainment', 1],
    ['ei_16', 'Desktop Computer', 'Asztali számítógép', 200, 80, 6, 'entertainment', 1],
    ['ei_17', 'Laptop', 'Laptop', 65, 80, 6, 'entertainment', 1],
    ['ei_18', 'Monitor', 'Monitor', 30, 100, 6, 'entertainment', 1],
    ['ei_19', 'Router/WiFi', 'Router/WiFi', 12, 100, 24, 'network', 1],
    ['ei_20', 'Water Heater (Electric)', 'Villanybojler', 2000, 30, 3, 'heating_cooling', 1],
    ['ei_21', 'Air Conditioner', 'Klíma', 1500, 50, 6, 'heating_cooling', 1],
    ['ei_22', 'Electric Radiator', 'Elektromos radiátor', 1500, 60, 8, 'heating_cooling', 1],
    ['ei_23', 'Vacuum Cleaner', 'Porszívó', 900, 100, 0.5, 'other', 1],
    ['ei_24', 'Hair Dryer', 'Hajszárító', 1500, 100, 0.2, 'other', 1],
    ['ei_25', 'Phone Charger', 'Telefon töltő', 20, 100, 3, 'other', 1]
  ];

  await db.transaction(async () => {
    for (const item of defaultItems) {
      await insert.run(...item);
    }
  });
}

module.exports = {
  getDb,
  initDb,
  getD1Config,
  isD1Configured,
  normalizeParams,
  splitSqlStatements,
  SCHEMA_SQL
};
