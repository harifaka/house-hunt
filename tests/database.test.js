const { installD1Emulator } = require('./helpers/d1-emulator');

// Emulate the Cloudflare D1 REST API before the database module loads
const emulator = installD1Emulator();
const emulatorFetch = global.fetch;

const {
  getDb,
  initDb,
  getD1Config,
  normalizeParams,
  splitSqlStatements
} = require('../src/database');

// Simulate a legacy deployment where scraped_properties.url was NOT NULL
emulator.db.exec(`
  CREATE TABLE scraped_properties (
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
  INSERT INTO scraped_properties (id, url, title) VALUES ('legacy-property', 'https://ingatlan.com/legacy', 'Legacy home');
`);

beforeAll(async () => {
  await initDb();
});

afterAll(() => {
  emulator.restore();
});

describe('Cloudflare D1 configuration', () => {
  test('getD1Config reads the account, database and token from the environment', () => {
    const config = getD1Config();
    expect(config.accountId).toBe('test-account');
    expect(config.databaseId).toBe('test-database');
    expect(config.apiToken).toBe('test-token');
    expect(config.apiBase).toBe('https://d1.test/client/v4');
  });

  test('getD1Config reports every missing variable', () => {
    const saved = {
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      database: process.env.CLOUDFLARE_D1_DATABASE_ID,
      token: process.env.CLOUDFLARE_API_TOKEN
    };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_D1_DATABASE_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;

    try {
      expect(() => getD1Config()).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
      expect(() => getD1Config()).toThrow(/CLOUDFLARE_D1_DATABASE_ID/);
      expect(() => getD1Config()).toThrow(/CLOUDFLARE_API_TOKEN/);
    } finally {
      process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
      process.env.CLOUDFLARE_D1_DATABASE_ID = saved.database;
      process.env.CLOUDFLARE_API_TOKEN = saved.token;
    }
  });
});

describe('D1 parameter handling', () => {
  test('normalizeParams flattens a single array argument', () => {
    expect(normalizeParams([['a', 'b']])).toEqual(['a', 'b']);
  });

  test('normalizeParams converts unsupported values', () => {
    expect(normalizeParams([true, false, undefined, null, 42])).toEqual([1, 0, null, null, 42]);
  });

  test('normalizeParams keeps positional order', () => {
    expect(normalizeParams(['house-1', 'q1', 3])).toEqual(['house-1', 'q1', 3]);
  });

  test('splitSqlStatements ignores semicolons inside string literals', () => {
    const statements = splitSqlStatements("INSERT INTO a VALUES ('x;y'); SELECT 1");
    expect(statements).toEqual(["INSERT INTO a VALUES ('x;y')", 'SELECT 1']);
  });
});

describe('D1 REST request/response mapping', () => {
  test('queries are sent to the D1 /query endpoint with bound parameters', async () => {
    let captured;
    global.fetch = async (input, init) => {
      captured = { url: String(input), body: JSON.parse(init.body), headers: init.headers };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          result: [{ results: [{ id: 'house-1' }], success: true, meta: { changes: 1, last_row_id: 7 } }],
          success: true,
          errors: []
        })
      };
    };

    try {
      const db = await getDb();
      const row = await db.prepare('SELECT * FROM houses WHERE id = ?').get('house-1');

      expect(row).toEqual({ id: 'house-1' });
      expect(captured.url).toBe('https://d1.test/client/v4/accounts/test-account/d1/database/test-database/query');
      expect(captured.body).toEqual({ sql: 'SELECT * FROM houses WHERE id = ?', params: ['house-1'] });
      expect(captured.headers.Authorization).toBe('Bearer test-token');
    } finally {
      global.fetch = emulatorFetch;
    }
  });

  test('run() exposes changes and lastInsertRowid from the D1 meta payload', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        result: [{ results: [], success: true, meta: { changes: 3, last_row_id: 12 } }],
        success: true,
        errors: []
      })
    });

    try {
      const db = await getDb();
      const result = await db.prepare('DELETE FROM houses WHERE id = ?').run('house-1');
      expect(result).toEqual({ changes: 3, lastInsertRowid: 12 });
    } finally {
      global.fetch = emulatorFetch;
    }
  });

  test('D1 error payloads surface as thrown errors', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        result: [],
        success: false,
        errors: [{ code: 7500, message: 'no such table: missing' }]
      })
    });

    try {
      const db = await getDb();
      await expect(db.prepare('SELECT * FROM missing').all()).rejects.toThrow(/no such table: missing/);
    } finally {
      global.fetch = emulatorFetch;
    }
  });
});

describe('Schema bootstrap and migrations', () => {
  test('initDb creates every table', async () => {
    const db = await getDb();
    const tables = (await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all()).map(row => row.name);

    expect(tables).toEqual(expect.arrayContaining([
      'houses', 'answers', 'settings', 'scraped_properties', 'city_info',
      'property_reports', 'ai_reports', 'audit_logs', 'house_images',
      'heating_calculations', 'window_door_templates', 'energy_calculations',
      'energy_item_templates'
    ]));
  });

  test('legacy scraped_properties.url NOT NULL constraint is dropped', async () => {
    const db = await getDb();
    const urlColumn = (await db.prepare(
      "SELECT name, \"notnull\" FROM pragma_table_info('scraped_properties')"
    ).all()).find(column => column.name === 'url');

    expect(urlColumn.notnull).toBe(0);

    const legacyProperty = await db.prepare('SELECT * FROM scraped_properties WHERE id = ?').get('legacy-property');
    expect(legacyProperty.title).toBe('Legacy home');
    expect(legacyProperty.url).toBe('https://ingatlan.com/legacy');
  });

  test('default settings are inserted once', async () => {
    const db = await getDb();
    const lang = await db.prepare("SELECT value FROM settings WHERE key = 'language'").get();
    expect(lang.value).toBe('hu');

    const title = await db.prepare("SELECT value FROM settings WHERE key = 'app_title'").get();
    expect(title.value).toBe('House Hunt');

    await initDb();

    const settings = await db.prepare('SELECT COUNT(*) as count FROM settings').get();
    expect(settings.count).toBe(2);
  });

  test('standard window/door and energy templates are seeded', async () => {
    const db = await getDb();
    const templates = await db.prepare('SELECT COUNT(*) as count FROM window_door_templates').get();
    expect(templates.count).toBe(8);

    const energyItems = await db.prepare('SELECT COUNT(*) as count FROM energy_item_templates').get();
    expect(energyItems.count).toBe(25);
  });
});

describe('CRUD operations', () => {
  test('insert, read, update and delete a house', async () => {
    const db = await getDb();

    await db.prepare('INSERT INTO houses (id, name, address, asking_price) VALUES (?, ?, ?, ?)')
      .run('test-1', 'DB Test House', '456 DB St', 30000000);

    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get('test-1');
    expect(house.name).toBe('DB Test House');
    expect(house.source).toBe('manual');

    await db.prepare('UPDATE houses SET name = ? WHERE id = ?').run('Updated House', 'test-1');
    const updated = await db.prepare('SELECT * FROM houses WHERE id = ?').get('test-1');
    expect(updated.name).toBe('Updated House');

    await db.prepare('DELETE FROM houses WHERE id = ?').run('test-1');
    const deleted = await db.prepare('SELECT * FROM houses WHERE id = ?').get('test-1');
    expect(deleted).toBeUndefined();
  });

  test('transaction() writes are committed as one D1 batch', async () => {
    let batchPayload;
    global.fetch = async (input, init) => {
      batchPayload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          result: [{ results: [], success: true, meta: { changes: 1 } }, { results: [], success: true, meta: { changes: 1 } }],
          success: true,
          errors: []
        })
      };
    };

    try {
      const db = await getDb();
      const statement = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      await db.transaction(async () => {
        await statement.run('tx_a', '1');
        await statement.run('tx_b', '2');
      });

      expect(batchPayload.batch).toHaveLength(2);
      expect(batchPayload.batch[0]).toEqual({
        sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        params: ['tx_a', '1']
      });
    } finally {
      global.fetch = emulatorFetch;
    }
  });

  test('concurrent transactions keep their statements in separate batches', async () => {
    const batches = [];
    let outsideRequests = 0;
    let releaseTransaction;
    const gate = new Promise(resolve => { releaseTransaction = resolve; });

    global.fetch = async (input, init) => {
      const payload = JSON.parse(init.body);
      if (payload.batch) {
        batches.push(payload.batch);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            result: payload.batch.map(() => ({ results: [], success: true, meta: { changes: 1 } })),
            success: true,
            errors: []
          })
        };
      }

      outsideRequests++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: [{ results: [], success: true, meta: { changes: 1 } }], success: true, errors: [] })
      };
    };

    try {
      const db = await getDb();
      const statement = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

      const transactionPromise = db.transaction(async () => {
        await statement.run('tx_only', '1');
        await gate;
      });

      await new Promise(resolve => setTimeout(resolve, 0));

      // Runs while the transaction above is still open
      await statement.run('outside', '2');
      expect(outsideRequests).toBe(1);

      releaseTransaction();
      await transactionPromise;

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0][0].params).toEqual(['tx_only', '1']);
    } finally {
      global.fetch = emulatorFetch;
    }
  });

  test('transaction() rolls the queue back when the callback fails', async () => {
    let requests = 0;
    global.fetch = async () => {
      requests++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: [], success: true, errors: [] }) };
    };

    try {
      const db = await getDb();
      const statement = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      await expect(db.transaction(async () => {
        await statement.run('boom', '1');
        throw new Error('callback failed');
      })).rejects.toThrow('callback failed');

      expect(requests).toBe(0);
    } finally {
      global.fetch = emulatorFetch;
    }
  });
});
