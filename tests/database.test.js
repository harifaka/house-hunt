const path = require('path');
const fs = require('fs');

// Use a temporary database for tests
const TEST_DB_PATH = path.join(__dirname, '..', 'db', 'test_db.sqlite');
process.env.DATABASE_PATH = TEST_DB_PATH;

const { getDb, initDb, DB_PATH, transformPostgresSql, quoteIdentifier } = require('../src/database');

afterAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('Database', () => {
  test('DB_PATH respects DATABASE_PATH env variable', () => {
    expect(DB_PATH).toBe(TEST_DB_PATH);
  });

  test('initDb creates tables without errors', async () => {
    await expect(initDb()).resolves.toBeUndefined();
  });

  test('getDb returns a working database connection', async () => {
    const db = await getDb();
    try {
      const tables = (await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all()).map(r => r.name);
      expect(tables).toContain('houses');
      expect(tables).toContain('answers');
      expect(tables).toContain('settings');
      expect(tables).toContain('scraped_properties');
      expect(tables).toContain('city_info');
      expect(tables).toContain('property_reports');
    } finally {
      await db.close();
    }
  });

  test('default settings are inserted', async () => {
    const db = await getDb();
    try {
      const lang = await db.prepare("SELECT value FROM settings WHERE key = 'language'").get();
      expect(lang.value).toBe('hu');
      const title = await db.prepare("SELECT value FROM settings WHERE key = 'app_title'").get();
      expect(title.value).toBe('House Hunt');
    } finally {
      await db.close();
    }
  });

  test('CRUD operations work on houses table', async () => {
    const db = await getDb();
    try {
      await db.prepare('INSERT INTO houses (id, name, address, asking_price) VALUES (?, ?, ?, ?)')
        .run('test-1', 'DB Test House', '456 DB St', 30000000);

      const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get('test-1');
      expect(house.name).toBe('DB Test House');

      await db.prepare('UPDATE houses SET name = ? WHERE id = ?').run('Updated House', 'test-1');
      const updated = await db.prepare('SELECT * FROM houses WHERE id = ?').get('test-1');
      expect(updated.name).toBe('Updated House');

      await db.prepare('DELETE FROM houses WHERE id = ?').run('test-1');
      const deleted = await db.prepare('SELECT * FROM houses WHERE id = ?').get('test-1');
      expect(deleted).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  test('postgres SQL translation handles supported upserts and quoting', () => {
    expect(transformPostgresSql('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'))
      .toContain('ON CONFLICT (key) DO NOTHING');
    expect(transformPostgresSql('INSERT OR REPLACE INTO answers (house_id, question_id, option_id, notes) VALUES (?, ?, ?, ?)'))
      .toContain('ON CONFLICT (house_id, question_id) DO UPDATE');
    expect(transformPostgresSql("UPDATE houses SET updated_at = datetime('now') WHERE id = ?"))
      .toContain('CURRENT_TIMESTAMP');
    expect(quoteIdentifier('house-hunt-db')).toBe('"house-hunt-db"');
  });
});
