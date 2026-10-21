/**
 * Test helper: an in-memory stand-in for the Cloudflare D1 HTTP REST API.
 *
 * Tests must not reach the network, but they should still exercise real SQL
 * and the real request/response mapping in src/database.js. This helper
 * intercepts fetch() calls to the D1 endpoint and replays them against an
 * in-memory SQLite database from Node's built-in `node:sqlite` module.
 *
 * Usage (must run before requiring ../app):
 *
 *   const { installD1Emulator } = require('./helpers/d1-emulator');
 *   installD1Emulator();
 */

const { DatabaseSync } = require('node:sqlite');

function createResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: payload && payload.success ? 'OK' : 'Error',
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function runStatement(db, sql, params) {
  const trimmed = sql.trim();
  const isRead = /^(select|pragma|with|explain)\b/i.test(trimmed);

  if (isRead) {
    const rows = db.prepare(trimmed).all(...params);
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }

  const result = db.prepare(trimmed).run(...params);
  return {
    results: [],
    success: true,
    meta: {
      changes: result.changes,
      last_row_id: result.lastInsertRowid,
      rows_written: result.changes
    }
  };
}

function runTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const results = work();
    db.exec('COMMIT');
    return results;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function executePayload(db, body) {
  if (body && Array.isArray(body.batch)) {
    return runTransaction(db, () => body.batch.map(item => runStatement(db, item.sql, item.params || [])));
  }

  const sql = (body && body.sql) || '';
  const params = (body && body.params) || [];
  const trimmed = sql.trim();
  const isRead = /^(select|pragma|with|explain)\b/i.test(trimmed);

  // D1 executes a semicolon-separated string as a transactional batch.
  if (!isRead && /;\s*\S/.test(trimmed)) {
    const statements = trimmed.split(';').map(part => part.trim()).filter(Boolean);
    return runTransaction(db, () => statements.map(statement => runStatement(db, statement, [])));
  }

  return [runStatement(db, trimmed, params)];
}

/**
 * Install the emulator as global.fetch, delegating any non-D1 request to the
 * original fetch implementation.
 *
 * @param {object} [options]
 * @param {string} [options.databaseUrl] - value used for CLOUDFLARE_API_BASE_URL
 * @returns {{ restore: () => void, db: import('node:sqlite').DatabaseSync }}
 */
function installD1Emulator(options = {}) {
  const originalFetch = global.fetch;
  const db = new DatabaseSync(':memory:');

  process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || 'test-token';
  process.env.CLOUDFLARE_D1_DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID || 'test-database';
  process.env.CLOUDFLARE_API_BASE_URL = options.databaseUrl || 'https://d1.test/client/v4';

  db.exec('PRAGMA foreign_keys = ON');

  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input && input.url);
    const isD1Request = url.includes('/d1/database/') && url.endsWith('/query');

    if (!isD1Request) {
      if (typeof originalFetch !== 'function') throw new Error('No fetch implementation available');
      return originalFetch(input, init);
    }

    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    try {
      const result = executePayload(db, body);
      return createResponse(200, { result, success: true, errors: [], messages: [] });
    } catch (error) {
      return createResponse(400, {
        result: [],
        success: false,
        errors: [{ code: 7500, message: error.message }],
        messages: []
      });
    }
  };

  return {
    db,
    restore() {
      global.fetch = originalFetch;
      db.close();
    }
  };
}

module.exports = { installD1Emulator };
