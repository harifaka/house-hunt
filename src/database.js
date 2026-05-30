const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'db', 'house_hunt.sqlite');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_MODE = DATABASE_URL ? 'postgres' : 'sqlite';

let postgresPool;

function normalizeParams(params) {
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function shouldUsePostgresSsl(databaseUrl) {
  const url = new URL(databaseUrl);
  const sslMode = (url.searchParams.get('sslmode') || process.env.PGSSLMODE || '').toLowerCase();
  const sslFlag = (process.env.DATABASE_SSL || '').toLowerCase();

  if (['disable', 'allow', 'prefer'].includes(sslMode)) return false;
  if (['require', 'verify-ca', 'verify-full', 'no-verify'].includes(sslMode)) return true;
  return ['1', 'true', 'yes'].includes(sslFlag);
}

function createPostgresConfig(databaseUrl) {
  const config = { connectionString: databaseUrl };
  if (shouldUsePostgresSsl(databaseUrl)) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

function getPostgresPool() {
  if (!postgresPool) {
    postgresPool = new Pool(createPostgresConfig(DATABASE_URL));
  }
  return postgresPool;
}

function transformPostgresSql(sql) {
  sql = sql.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');
  const trimmed = sql.trim();

  if (trimmed === 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)') {
    return 'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING';
  }

  if (trimmed === 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)') {
    return 'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
  }

  if (trimmed === 'INSERT OR REPLACE INTO answers (house_id, question_id, option_id, notes) VALUES (?, ?, ?, ?)') {
    return 'INSERT INTO answers (house_id, question_id, option_id, notes) VALUES ($1, $2, $3, $4) ON CONFLICT (house_id, question_id) DO UPDATE SET option_id = EXCLUDED.option_id, notes = EXCLUDED.notes';
  }

  if (trimmed === 'INSERT OR REPLACE INTO image_descriptions (id, image_hash, image_path, description) VALUES (?, ?, ?, ?)') {
    return 'INSERT INTO image_descriptions (id, image_hash, image_path, description) VALUES ($1, $2, $3, $4) ON CONFLICT (image_hash) DO UPDATE SET image_path = EXCLUDED.image_path, description = EXCLUDED.description';
  }

  if (trimmed.startsWith('INSERT OR REPLACE INTO scraped_properties')) {
    return `INSERT INTO scraped_properties (id, url, title, price, price_text, location, city, size_sqm, rooms, description, property_type, listing_id, image_urls, scraped_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (url) DO UPDATE SET
        id = EXCLUDED.id,
        title = EXCLUDED.title,
        price = EXCLUDED.price,
        price_text = EXCLUDED.price_text,
        location = EXCLUDED.location,
        city = EXCLUDED.city,
        size_sqm = EXCLUDED.size_sqm,
        rooms = EXCLUDED.rooms,
        description = EXCLUDED.description,
        property_type = EXCLUDED.property_type,
        listing_id = EXCLUDED.listing_id,
        image_urls = EXCLUDED.image_urls,
        scraped_data = EXCLUDED.scraped_data,
        updated_at = CURRENT_TIMESTAMP`;
  }

  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class SqliteStatement {
  constructor(statement) {
    this.statement = statement;
  }

  async get(...params) {
    return this.statement.get(...normalizeParams(params));
  }

  async all(...params) {
    return this.statement.all(...normalizeParams(params));
  }

  async run(...params) {
    const result = this.statement.run(...normalizeParams(params));
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }
}

class SqliteConnection {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteStatement(this.db.prepare(sql));
  }

  async exec(sql) {
    this.db.exec(sql);
  }

  async transaction(callback) {
    this.db.exec('BEGIN');
    try {
      const result = await callback(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close() {
    this.db.close();
  }
}

class PostgresStatement {
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
  }

  async get(...params) {
    const result = await this.client.query(transformPostgresSql(this.sql), normalizeParams(params));
    return result.rows[0];
  }

  async all(...params) {
    const result = await this.client.query(transformPostgresSql(this.sql), normalizeParams(params));
    return result.rows;
  }

  async run(...params) {
    const result = await this.client.query(transformPostgresSql(this.sql), normalizeParams(params));
    return { changes: result.rowCount || 0 };
  }
}

class PostgresConnection {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    return new PostgresStatement(this.client, sql);
  }

  async exec(sql) {
    await this.client.query(sql);
  }

  async transaction(callback) {
    await this.client.query('BEGIN');
    try {
      const result = await callback(this);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }

  async close() {
    this.client.release();
  }
}

async function ensurePostgresDatabaseExists() {
  const databaseUrl = new URL(DATABASE_URL);
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));

  if (!databaseName) return;

  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = '/' + (process.env.POSTGRES_ADMIN_DATABASE || 'postgres');
  const adminPool = new Pool(createPostgresConfig(adminUrl.toString()));

  try {
    const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } catch (error) {
    if (!['42P04', '42710'].includes(error.code)) {
      throw error;
    }
  } finally {
    await adminPool.end();
  }
}

function getSqliteDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return new SqliteConnection(db);
}

async function getDb() {
  if (DATABASE_MODE === 'postgres') {
    const client = await getPostgresPool().connect();
    return new PostgresConnection(client);
  }

  return getSqliteDb();
}

async function initSqliteDb() {
  const db = getSqliteDb();

  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS houses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT,
        asking_price REAL,
        notes TEXT,
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
        url TEXT NOT NULL UNIQUE,
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
    `);

    const answerCols = (await db.prepare('PRAGMA table_info(answers)').all()).map(c => c.name);
    if (!answerCols.includes('image_description')) {
      await db.exec('ALTER TABLE answers ADD COLUMN image_description TEXT');
    }

    const houseCols = (await db.prepare('PRAGMA table_info(houses)').all()).map(c => c.name);
    if (!houseCols.includes('description')) {
      await db.exec('ALTER TABLE houses ADD COLUMN description TEXT');
    }
    if (!houseCols.includes('source')) {
      await db.exec("ALTER TABLE houses ADD COLUMN source TEXT DEFAULT 'manual'");
    }

    const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    await upsert.run('language', 'hu');
    await upsert.run('app_title', 'House Hunt');

    // Seed standard window/door templates
    const templateCount = await db.prepare('SELECT COUNT(*) as count FROM window_door_templates').get();
    if (templateCount.count === 0) {
      const templateInsert = db.prepare(
        'INSERT INTO window_door_templates (id, name, width, height, type, u_value, is_standard) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
      for (const t of templates) {
        await templateInsert.run(...t);
      }
    }

    // Seed default energy item templates
    const energyItemCount = await db.prepare('SELECT COUNT(*) as count FROM energy_item_templates').get();
    if (energyItemCount.count === 0) {
      const eiInsert = db.prepare(
        'INSERT INTO energy_item_templates (id, name, name_hu, wattage, duty_cycle, daily_hours, category, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
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
        ['ei_25', 'Phone Charger', 'Telefon töltő', 20, 100, 3, 'other', 1],
      ];
      for (const item of defaultItems) {
        await eiInsert.run(...item);
      }
    }
  } finally {
    await db.close();
  }
}

async function initPostgresDb() {
  await ensurePostgresDatabaseExists();
  const db = await getDb();

  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS houses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT,
        asking_price DOUBLE PRECISION,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS answers (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        option_id TEXT,
        notes TEXT,
        image_path TEXT,
        image_description TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(house_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scraped_properties (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT,
        price DOUBLE PRECISION,
        price_text TEXT,
        location TEXT,
        city TEXT,
        size_sqm DOUBLE PRECISION,
        rooms INTEGER,
        description TEXT,
        property_type TEXT,
        listing_id TEXT,
        image_urls TEXT,
        scraped_data TEXT,
        llm_analysis TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
        avg_price DOUBLE PRECISION,
        median_price DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS property_reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        city TEXT,
        property_ids TEXT,
        city_info_id TEXT REFERENCES city_info(id),
        report_data TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ai_reports (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        section_name TEXT,
        report_text TEXT,
        summary TEXT,
        lang TEXT DEFAULT 'hu',
        input_snapshot TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS image_descriptions (
        id TEXT PRIMARY KEY,
        image_hash TEXT NOT NULL UNIQUE,
        image_path TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS house_images (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        caption TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS heating_calculations (
        id TEXT PRIMARY KEY,
        house_id TEXT,
        name TEXT NOT NULL,
        parameters TEXT NOT NULL,
        results TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS window_door_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        width DOUBLE PRECISION NOT NULL,
        height DOUBLE PRECISION NOT NULL,
        type TEXT NOT NULL DEFAULT 'double',
        u_value DOUBLE PRECISION NOT NULL DEFAULT 2.8,
        is_standard BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS energy_calculations (
        id TEXT PRIMARY KEY,
        house_id TEXT,
        name TEXT NOT NULL,
        parameters TEXT NOT NULL,
        results TEXT NOT NULL,
        ai_analysis TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS energy_item_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_hu TEXT,
        wattage DOUBLE PRECISION NOT NULL DEFAULT 0,
        duty_cycle DOUBLE PRECISION NOT NULL DEFAULT 100,
        daily_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
        category TEXT NOT NULL DEFAULT 'other',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.exec('ALTER TABLE answers ADD COLUMN IF NOT EXISTS image_description TEXT');

    await db.exec("ALTER TABLE houses ADD COLUMN IF NOT EXISTS description TEXT");
    await db.exec("ALTER TABLE houses ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'");

    const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    await upsert.run('language', 'hu');
    await upsert.run('app_title', 'House Hunt');

    // Seed standard window/door templates
    const templateCount = await db.prepare('SELECT COUNT(*) as count FROM window_door_templates').get();
    if (templateCount.count === 0) {
      const templateInsert = db.prepare(
        'INSERT INTO window_door_templates (id, name, width, height, type, u_value, is_standard) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const templates = [
        ['std_1', 'Standard window 120×150', 1.2, 1.5, 'double', 2.8, true],
        ['std_2', 'Standard window 90×150', 0.9, 1.5, 'double', 2.8, true],
        ['std_3', 'Standard window 60×60', 0.6, 0.6, 'double', 2.8, true],
        ['std_4', 'Large window 180×150', 1.8, 1.5, 'double', 2.8, true],
        ['std_5', 'Balcony door 90×210', 0.9, 2.1, 'double', 2.8, true],
        ['std_6', 'Front door 100×210', 1.0, 2.1, 'double', 2.8, true],
        ['std_7', 'Double front door 140×210', 1.4, 2.1, 'double', 2.8, true],
        ['std_8', 'Interior door 80×210', 0.8, 2.1, 'single', 5.8, true]
      ];
      for (const t of templates) {
        await templateInsert.run(...t);
      }
    }

    // Seed default energy item templates
    const energyItemCount = await db.prepare('SELECT COUNT(*) as count FROM energy_item_templates').get();
    if (energyItemCount.count === 0) {
      const eiInsert = db.prepare(
        'INSERT INTO energy_item_templates (id, name, name_hu, wattage, duty_cycle, daily_hours, category, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const defaultItems = [
        ['ei_1', 'LED Ceiling Light', 'LED mennyezeti lámpa', 12, 100, 5, 'lighting', true],
        ['ei_2', 'LED Desk Lamp', 'LED asztali lámpa', 8, 100, 4, 'lighting', true],
        ['ei_3', 'Halogen Spotlight', 'Halogén spotlámpa', 50, 100, 3, 'lighting', true],
        ['ei_4', 'Refrigerator', 'Hűtőszekrény', 150, 40, 24, 'kitchen', true],
        ['ei_5', 'Freezer', 'Fagyasztó', 200, 40, 24, 'kitchen', true],
        ['ei_6', 'Oven', 'Sütő', 2000, 50, 1, 'kitchen', true],
        ['ei_7', 'Microwave', 'Mikrohullámú sütő', 800, 50, 0.3, 'kitchen', true],
        ['ei_8', 'Dishwasher', 'Mosogatógép', 1800, 50, 1, 'kitchen', true],
        ['ei_9', 'Electric Kettle', 'Vízforraló', 2000, 100, 0.2, 'kitchen', true],
        ['ei_10', 'Coffee Machine', 'Kávéfőző', 1000, 50, 0.3, 'kitchen', true],
        ['ei_11', 'Washing Machine', 'Mosógép', 500, 50, 1, 'laundry', true],
        ['ei_12', 'Dryer', 'Szárítógép', 2500, 50, 1, 'laundry', true],
        ['ei_13', 'Iron', 'Vasaló', 2000, 50, 0.5, 'laundry', true],
        ['ei_14', 'TV (LED 55")', 'Televízió (LED 55")', 100, 100, 4, 'entertainment', true],
        ['ei_15', 'Gaming Console (Xbox/PS)', 'Játékkonzol (Xbox/PS)', 150, 80, 3, 'entertainment', true],
        ['ei_16', 'Desktop Computer', 'Asztali számítógép', 200, 80, 6, 'entertainment', true],
        ['ei_17', 'Laptop', 'Laptop', 65, 80, 6, 'entertainment', true],
        ['ei_18', 'Monitor', 'Monitor', 30, 100, 6, 'entertainment', true],
        ['ei_19', 'Router/WiFi', 'Router/WiFi', 12, 100, 24, 'network', true],
        ['ei_20', 'Water Heater (Electric)', 'Villanybojler', 2000, 30, 3, 'heating_cooling', true],
        ['ei_21', 'Air Conditioner', 'Klíma', 1500, 50, 6, 'heating_cooling', true],
        ['ei_22', 'Electric Radiator', 'Elektromos radiátor', 1500, 60, 8, 'heating_cooling', true],
        ['ei_23', 'Vacuum Cleaner', 'Porszívó', 900, 100, 0.5, 'other', true],
        ['ei_24', 'Hair Dryer', 'Hajszárító', 1500, 100, 0.2, 'other', true],
        ['ei_25', 'Phone Charger', 'Telefon töltő', 20, 100, 3, 'other', true],
      ];
      for (const item of defaultItems) {
        await eiInsert.run(...item);
      }
    }
  } finally {
    await db.close();
  }
}

async function initDb() {
  if (DATABASE_MODE === 'postgres') {
    await initPostgresDb();
    return;
  }

  await initSqliteDb();
}

module.exports = {
  getDb,
  initDb,
  DB_PATH,
  DATABASE_URL,
  DATABASE_MODE,
  createPostgresConfig,
  transformPostgresSql,
  quoteIdentifier,
};
