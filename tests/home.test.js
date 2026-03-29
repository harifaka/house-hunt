const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Use a temporary database for tests
const TEST_DB_PATH = path.join(__dirname, '..', 'db', 'test_house_hunt.sqlite');
process.env.DATABASE_PATH = TEST_DB_PATH;

const app = require('../app');
const { getDb } = require('../src/database');

afterAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('Home Routes', () => {
  test('GET / returns 200 and renders dashboard', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('House Hunt');
  });

  test('GET / renders demo advertisement placeholders in Hungarian and English', async () => {
    const huRes = await request(app).get('/');
    expect(huRes.status).toBe(200);
    expect(huRes.text).toContain('Bemutató hirdetés');

    const enRes = await request(app).get('/?lang=en');
    expect(enRes.status).toBe(200);
    expect(enRes.text).toContain('Demo advertisement');
    expect(enRes.text).toContain('Google AdSense');
  });

  test('GET /houses returns 200', async () => {
    const res = await request(app).get('/houses');
    expect(res.status).toBe(200);
  });

  test('POST /houses creates a new house and redirects', async () => {
    const res = await request(app)
      .post('/houses')
      .type('form')
      .send({ name: 'Test House', address: '123 Test St', asking_price: '50000000', notes: 'Test notes' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/houses\//);

    const db = await getDb();
    try {
      const house = await db.prepare('SELECT * FROM houses WHERE name = ?').get('Test House');
      expect(house).toBeDefined();
      expect(house.address).toBe('123 Test St');
    } finally {
      await db.close();
    }
  });

  test('GET /houses/:id returns 200 for existing house', async () => {
    const db = await getDb();
    let houseId;
    try {
      houseId = (await db.prepare('SELECT id FROM houses WHERE name = ?').get('Test House'))?.id;
    } finally {
      await db.close();
    }
    expect(houseId).toBeDefined();

    const res = await request(app).get(`/houses/${houseId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Test House');
  });

  test('POST /houses/:id/delete removes the house', async () => {
    const db = await getDb();
    let houseId;
    try {
      houseId = (await db.prepare('SELECT id FROM houses WHERE name = ?').get('Test House'))?.id;
    } finally {
      await db.close();
    }

    const res = await request(app).post(`/houses/${houseId}/delete`);
    expect(res.status).toBe(302);

    const db2 = await getDb();
    try {
      const deleted = await db2.prepare('SELECT * FROM houses WHERE id = ?').get(houseId);
      expect(deleted).toBeUndefined();
    } finally {
      await db2.close();
    }
  });
});
