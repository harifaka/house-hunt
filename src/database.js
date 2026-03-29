const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'db', 'house_hunt.sqlite');

function getDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
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

  // Migrations: add columns if missing
  const answerCols = db.prepare("PRAGMA table_info(answers)").all().map(c => c.name);
  if (!answerCols.includes('image_description')) {
    db.exec("ALTER TABLE answers ADD COLUMN image_description TEXT");
  }

  const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('language', 'hu');
  upsert.run('app_title', 'House Hunt');

  db.close();
}

module.exports = { getDb, initDb, DB_PATH };
