const request = require('supertest');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

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

  test('POST /property-finder/scrape-html imports a saved ingatlan.com page', async () => {
    const url = `https://ingatlan.com/35383142?route-test=${Date.now()}`;
    const html = `<html><head><meta property="og:title" content="Eladó családi ház, Tápiószecső"></head><body>
      <h1><span>Tápiószecső, Pest megye</span><span>Eladó családi ház</span></h1>
      <div>118,50 millió Ft</div><div>Alapterület 150 m²</div>
      <div data-details-page--moneycheck-listing-data-value='{"priceHuf":{"amount":"11850000000","currency":"HUF"},"property":{"lotSize":662,"roomCount":3}}'></div>
      <div data-details-page--gallery-elements-value='[]'></div>
    </body></html>`;

    const res = await request(app)
      .post('/property-finder/scrape-html')
      .field('url', url)
      .attach('html', Buffer.from(html), { filename: 'listing.html', contentType: 'text/html' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.imported).toBe(true);
    expect(res.body.property.price).toBe(118500000);
    expect(res.body.property.location).toBe('Tápiószecső, Pest megye');
    expect(res.body.property.size_sqm).toBe(150);
    expect(res.body.property.rooms).toBe(3);
  });

  test('POST /property-finder/property/:id/add-to-houses copies a listing for review', async () => {
    const db = await getDb();
    const propertyId = crypto.randomUUID();
    const listingUrl = `https://ingatlan.com/review-${Date.now()}`;
    try {
      await db.prepare(`INSERT INTO scraped_properties (id, url, title, price, location, description)
        VALUES (?, ?, ?, ?, ?, ?)`).run(propertyId, listingUrl, 'Review House', 72000000, 'Szeged', 'Sunny house');
    } finally {
      await db.close();
    }

    const finder = await request(app).get('/property-finder');
    expect(finder.text).toContain(`/property-finder/property/${propertyId}/add-to-houses`);

    const detail = await request(app).get(`/property-finder/property/${propertyId}`);
    expect(detail.status).toBe(200);
    const inlineScript = detail.text.match(/<script>\s*([\s\S]*?)<\/script>/);
    expect(inlineScript).not.toBeNull();
    expect(() => new vm.Script(inlineScript[1])).not.toThrow();

    const res = await request(app).post(`/property-finder/property/${propertyId}/add-to-houses`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/houses\//);

    const verifyDb = await getDb();
    try {
      const house = await verifyDb.prepare('SELECT * FROM houses WHERE id = ?').get(res.headers.location.split('/').pop());
      expect(house.name).toBe('Review House');
      expect(house.address).toBe('Szeged');
      expect(house.asking_price).toBe(72000000);
      expect(house.description).toBe('Sunny house');
      expect(house.source).toBe('scraped');
    } finally {
      await verifyDb.close();
    }
  });

  test('POST /property-finder/city-info-search saves sourced Google fallback results', async () => {
    const googleHtml = `<div class="MjjYud"><a href="https://example.com/szeged"><h3>Szeged city facts</h3></a>
      <div class="VwiC3b">Szeged is a university city in southern Hungary with a strong public transport network.</div></div>`;
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => googleHtml,
    });

    try {
      const res = await request(app)
        .post('/property-finder/city-info-search')
        .send({ city: 'Szeged' });

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('Google Search');
      expect(res.body.cityInfo.generalInfo).toContain('university city');
      expect(res.body.cityInfo.extraData.sources[0].url).toBe('https://example.com/szeged');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
