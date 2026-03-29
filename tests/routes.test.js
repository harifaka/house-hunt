const request = require('supertest');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Use a temporary database for tests
const TEST_DB_PATH = path.join(__dirname, '..', 'db', 'test_api.sqlite');
process.env.DATABASE_PATH = TEST_DB_PATH;

const app = require('../app');
const { getDb } = require('../src/database');

afterAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('API Routes', () => {
  let houseId;

  beforeAll(async () => {
    const db = await getDb();
    try {
      houseId = crypto.randomUUID();
      await db.prepare('INSERT INTO houses (id, name, address, asking_price) VALUES (?, ?, ?, ?)')
        .run(houseId, 'API Test House', '789 API St', 40000000);
    } finally {
      await db.close();
    }
  });

  test('GET /api/houses returns JSON list', async () => {
    const res = await request(app).get('/api/houses');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/houses/:id returns house detail', async () => {
    const res = await request(app).get(`/api/houses/${houseId}`);
    expect(res.status).toBe(200);
    expect(res.body.house).toBeDefined();
    expect(res.body.house.name).toBe('API Test House');
  });

  test('GET /api/export/:houseId/json returns export data', async () => {
    const res = await request(app).get(`/api/export/${houseId}/json`);
    expect(res.status).toBe(200);
    expect(res.body.house).toBeDefined();
    expect(res.body.house.name).toBe('API Test House');
  });

  test('GET /api/export/:houseId/csv returns CSV', async () => {
    const res = await request(app).get(`/api/export/${houseId}/csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  test('GET /api/ai/config returns AI configuration', async () => {
    const res = await request(app).get('/api/ai/config');
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });
});

describe('Calculator Routes', () => {
  test('GET /calculators/energy returns 200', async () => {
    const res = await request(app).get('/calculators/energy');
    expect(res.status).toBe(200);
  });

  test('GET /calculators/heating returns 200', async () => {
    const res = await request(app).get('/calculators/heating');
    expect(res.status).toBe(200);
  });
});

describe('Admin Routes', () => {
  test('GET /admin returns 200', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(200);
  });

  test('GET /admin/export returns 200', async () => {
    const res = await request(app).get('/admin/export');
    expect(res.status).toBe(200);
  });
});

describe('Property Finder Routes', () => {
  test('GET /property-finder returns 200', async () => {
    const res = await request(app).get('/property-finder');
    expect(res.status).toBe(200);
  });
});
