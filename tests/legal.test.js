const request = require('supertest');
const { installD1Emulator } = require('./helpers/d1-emulator');

// Emulate the Cloudflare D1 REST API before the app loads
const emulator = installD1Emulator();

const app = require('../app');

afterAll(() => {
  emulator.restore();
});

describe('Legal Routes', () => {
  test('GET /legal/terms returns 200 with Hungarian content', async () => {
    const res = await request(app).get('/legal/terms');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Felhasználási feltételek');
  });

  test('GET /legal/terms?lang=en returns English content', async () => {
    const res = await request(app).get('/legal/terms?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Terms of Use');
    expect(res.text).toContain('Acceptance of Terms');
  });

  test('GET /legal/privacy returns 200 with GDPR content', async () => {
    const res = await request(app).get('/legal/privacy?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Privacy Policy');
    expect(res.text).toContain('GDPR');
    expect(res.text).toContain('30 days');
    expect(res.text).toContain('Google AdSense');
  });

  test('GET /legal/privacy returns Hungarian GDPR content', async () => {
    const res = await request(app).get('/legal/privacy');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Adatvédelmi szabályzat');
    expect(res.text).toContain('GDPR');
  });

  test('GET /legal/cookies returns 200 with cookie policy', async () => {
    const res = await request(app).get('/legal/cookies?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Cookie Policy');
    expect(res.text).toContain('connect.sid');
    expect(res.text).toContain('cookie_consent');
    expect(res.text).toContain('Google AdSense');
  });

  test('POST /legal/cookie-consent sets cookie and redirects', async () => {
    const res = await request(app)
      .post('/legal/cookie-consent')
      .type('form')
      .send({ redirect: '/' });
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie']).toBeDefined();
    const cookieHeader = res.headers['set-cookie'].join('; ');
    expect(cookieHeader).toContain('cookie_consent=accepted');
  });
});

describe('Cookie consent banner', () => {
  test('Homepage shows cookie banner without consent', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('cookie-banner');
  });

  test('Homepage hides cookie banner with consent cookie', async () => {
    const res = await request(app)
      .get('/')
      .set('Cookie', 'cookie_consent=accepted');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="cookie-banner"');
  });
});

describe('Footer legal links', () => {
  test('Homepage footer contains legal links', async () => {
    const res = await request(app).get('/?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/legal/terms');
    expect(res.text).toContain('/legal/privacy');
    expect(res.text).toContain('/legal/cookies');
    expect(res.text).toContain('Terms of Use');
    expect(res.text).toContain('Privacy Policy');
    expect(res.text).toContain('Cookie Policy');
  });
});
