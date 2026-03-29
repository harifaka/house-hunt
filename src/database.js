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
    `);

    const answerCols = (await db.prepare('PRAGMA table_info(answers)').all()).map(c => c.name);
    if (!answerCols.includes('image_description')) {
      await db.exec('ALTER TABLE answers ADD COLUMN image_description TEXT');
    }

    const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    await upsert.run('language', 'hu');
    await upsert.run('app_title', 'House Hunt');
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
    `);

    await db.exec('ALTER TABLE answers ADD COLUMN IF NOT EXISTS image_description TEXT');

    const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    await upsert.run('language', 'hu');
    await upsert.run('app_title', 'House Hunt');
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
