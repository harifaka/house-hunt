const { installD1Emulator } = require('./helpers/d1-emulator');

// Emulate the Cloudflare D1 REST API before the database module loads
const emulator = installD1Emulator();

const { initDb, getDb } = require('../src/database');
const { logger, LOG_RETENTION_DAYS } = require('../src/logger');

beforeAll(async () => {
  await initDb();
  logger.init(getDb);
});

afterAll(() => {
  emulator.restore();
});

describe('Logger', () => {
  test('LOG_RETENTION_DAYS defaults to 30', () => {
    expect(LOG_RETENTION_DAYS).toBe(30);
  });

  test('audit_logs table exists', async () => {
    const db = await getDb();
    try {
      const tables = (await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'"
      ).all()).map(r => r.name);
      expect(tables).toContain('audit_logs');
    } finally {
      await db.close();
    }
  });

  test('logger.info persists a log entry', async () => {
    await logger.info('test', 'test_event', { foo: 'bar' }, { ip: '127.0.0.1', ua: 'jest' });

    const db = await getDb();
    try {
      const row = await db.prepare(
        "SELECT * FROM audit_logs WHERE category = 'test' AND event = 'test_event'"
      ).get();
      expect(row).toBeDefined();
      expect(row.level).toBe('info');
      expect(JSON.parse(row.details)).toEqual({ foo: 'bar' });
      expect(row.ip_address).toBe('127.0.0.1');
      expect(row.user_agent).toBe('jest');
    } finally {
      await db.close();
    }
  });

  test('logger.audit persists an audit entry', async () => {
    await logger.audit('quiz', 'answer_test', { questionId: 'q1' });

    const db = await getDb();
    try {
      const row = await db.prepare(
        "SELECT * FROM audit_logs WHERE category = 'quiz' AND event = 'answer_test'"
      ).get();
      expect(row).toBeDefined();
      expect(row.level).toBe('audit');
    } finally {
      await db.close();
    }
  });

  test('logger.quizAnswer persists quiz answer audit', async () => {
    await logger.quizAnswer('house-1', 'q-1', 'opt-a', { ip: '10.0.0.1' });

    const db = await getDb();
    try {
      const row = await db.prepare(
        "SELECT * FROM audit_logs WHERE category = 'quiz' AND event = 'answer_saved' ORDER BY created_at DESC"
      ).get();
      expect(row).toBeDefined();
      const details = JSON.parse(row.details);
      expect(details.houseId).toBe('house-1');
      expect(details.questionId).toBe('q-1');
      expect(details.optionId).toBe('opt-a');
    } finally {
      await db.close();
    }
  });

  test('logger.reportGenerated persists report timing', async () => {
    await logger.reportGenerated('pdf', 'house-2', 1234, { ip: '10.0.0.2' });

    const db = await getDb();
    try {
      const row = await db.prepare(
        "SELECT * FROM audit_logs WHERE category = 'report' AND event = 'generated' ORDER BY created_at DESC"
      ).get();
      expect(row).toBeDefined();
      expect(row.duration_ms).toBe(1234);
      const details = JSON.parse(row.details);
      expect(details.type).toBe('pdf');
      expect(details.houseId).toBe('house-2');
      expect(details.durationMs).toBe(1234);
    } finally {
      await db.close();
    }
  });

  test('logger.error persists error log', async () => {
    await logger.error('app', 'test_error', { message: 'something broke' });

    const db = await getDb();
    try {
      const row = await db.prepare(
        "SELECT * FROM audit_logs WHERE level = 'error' AND event = 'test_error'"
      ).get();
      expect(row).toBeDefined();
    } finally {
      await db.close();
    }
  });

  test('cleanup does not delete recent logs', async () => {
    const db = await getDb();
    try {
      const countBefore = await db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get();
      expect(countBefore.cnt).toBeGreaterThan(0);
    } finally {
      await db.close();
    }

    const deleted = await logger.cleanup();
    expect(deleted).toBe(0); // recent logs should not be deleted

    const db2 = await getDb();
    try {
      const countAfter = await db2.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get();
      expect(countAfter.cnt).toBeGreaterThan(0);
    } finally {
      await db2.close();
    }
  });

  test('cleanup deletes old logs but keeps feature data', async () => {
    const db = await getDb();
    try {
      // Insert an old log (40 days ago)
      const crypto = require('crypto');
      await db.prepare(
        "INSERT INTO audit_logs (id, level, category, event, details, created_at) VALUES (?, 'info', 'test', 'old_event', '{}', datetime('now', '-40 days'))"
      ).run(crypto.randomUUID());

      // Insert a house (feature data) for verification
      await db.prepare(
        'INSERT INTO houses (id, name, address, asking_price) VALUES (?, ?, ?, ?)'
      ).run('cleanup-test-house', 'Cleanup Test', '123 Test', 10000);
    } finally {
      await db.close();
    }

    const deleted = await logger.cleanup();
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Verify feature data is intact
    const db2 = await getDb();
    try {
      const house = await db2.prepare('SELECT * FROM houses WHERE id = ?').get('cleanup-test-house');
      expect(house).toBeDefined();
      expect(house.name).toBe('Cleanup Test');

      // Old log should be gone
      const oldLog = await db2.prepare(
        "SELECT * FROM audit_logs WHERE event = 'old_event'"
      ).get();
      expect(oldLog).toBeUndefined();

      // Clean up test data
      await db2.prepare('DELETE FROM houses WHERE id = ?').run('cleanup-test-house');
    } finally {
      await db2.close();
    }
  });
});
