const request = require('supertest');
const crypto = require('crypto');
const { installD1Emulator } = require('./helpers/d1-emulator');

// Emulate the Cloudflare D1 REST API before the app loads
const emulator = installD1Emulator();
const emulatorFetch = global.fetch;

process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.DEEPSEEK_BASE_URL = 'https://vision.test/v1';
process.env.DEEPSEEK_VISION_MODEL = 'test-vision-model';
process.env.R2_PUBLIC_DOMAIN = 'https://images.test';

const app = require('../app');
const { getDb } = require('../src/database');
const { analyzePropertyImages } = require('../src/ai-service');

const ANALYSIS_TEXT = 'Structural condition: crack above the window. Repair needed.';

let visionCalls = [];
let visionResponse;

function installVisionMock() {
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input && input.url);

    if (url.includes('/d1/database/')) return emulatorFetch(input, init);

    visionCalls.push({
      url,
      init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null
    });

    return {
      ok: visionResponse.status >= 200 && visionResponse.status < 300,
      status: visionResponse.status,
      text: async () => JSON.stringify(visionResponse.body),
      json: async () => visionResponse.body
    };
  };
}

async function createHouse(name, imageFilenames = []) {
  const db = await getDb();
  const id = crypto.randomUUID();
  try {
    await db.prepare('INSERT INTO houses (id, name) VALUES (?, ?)').run(id, name);
    for (let i = 0; i < imageFilenames.length; i++) {
      await db.prepare(
        'INSERT INTO house_images (id, house_id, filename, caption, sort_order) VALUES (?, ?, ?, ?, ?)'
      ).run(crypto.randomUUID(), id, imageFilenames[i], 'Photo ' + (i + 1), i);
    }
  } finally {
    await db.close();
  }
  return id;
}

beforeAll(() => {
  installVisionMock();
});

beforeEach(() => {
  visionCalls = [];
  visionResponse = {
    status: 200,
    body: { choices: [{ message: { content: ANALYSIS_TEXT } }] }
  };
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
});

afterEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
});

afterAll(() => {
  emulator.restore();
});

describe('POST /api/houses/:id/analyze-vision', () => {
  test('sends the R2 public URLs to DeepSeek and stores the analysis', async () => {
    const houseId = await createHouse('Vision House', [
      'house-hunt/2026/01/front.jpg',
      'house-hunt/2026/01/kitchen.jpg'
    ]);

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision?lang=en`).send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.analysis).toBe(ANALYSIS_TEXT);
    expect(res.body.imageCount).toBe(2);
    expect(res.body.analyzedAt).toBeDefined();

    expect(visionCalls).toHaveLength(1);
    const call = visionCalls[0];
    expect(call.url).toBe('https://vision.test/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer test-deepseek-key');
    expect(call.body.model).toBe('test-vision-model');
    expect(call.body.stream).toBe(false);

    const content = call.body.messages[0].content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('Analyze these property images');
    expect(content.filter(part => part.type === 'image_url').map(part => part.image_url.url)).toEqual([
      'https://images.test/house-hunt/2026/01/front.jpg',
      'https://images.test/house-hunt/2026/01/kitchen.jpg'
    ]);

    const db = await getDb();
    try {
      const house = await db.prepare('SELECT ai_vision_notes FROM houses WHERE id = ?').get(houseId);
      expect(house.ai_vision_notes).toBe(ANALYSIS_TEXT);
    } finally {
      await db.close();
    }
  });

  test('uses a Hungarian prompt for the default language', async () => {
    const houseId = await createHouse('Magyar Ház', ['house-hunt/2026/01/szoba.jpg']);

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});

    expect(res.status).toBe(200);
    expect(visionCalls[0].body.messages[0].content[0].text).toContain('Elemezd ezeket az ingatlanfotókat');
  });

  test('renders the saved analysis on the house detail page', async () => {
    const houseId = await createHouse('Saved Analysis House', ['house-hunt/2026/01/saved.jpg']);

    const analysisRes = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
    expect(analysisRes.status).toBe(200);

    const page = await request(app).get(`/houses/${houseId}?lang=en`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('AI Vision Analysis');
    expect(page.text).toContain('Analyze Images with DeepSeek');
    expect(page.text).toContain('Structural condition: crack above the window. Repair needed.');
  });

  test('returns 404 for an unknown house', async () => {
    const res = await request(app).post('/api/houses/does-not-exist/analyze-vision').send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('HOUSE_NOT_FOUND');
    expect(visionCalls).toHaveLength(0);
  });

  test('returns 400 when the house has no photos', async () => {
    const houseId = await createHouse('No Photos House');

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_IMAGES');
    expect(visionCalls).toHaveLength(0);
  });

  test('returns 400 when photos are not publicly reachable', async () => {
    const publicDomain = process.env.R2_PUBLIC_DOMAIN;
    delete process.env.R2_PUBLIC_DOMAIN;
    const houseId = await createHouse('Private Photos House', ['house-hunt/2026/01/private.jpg']);

    try {
      const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMAGES_NOT_PUBLIC');
      expect(visionCalls).toHaveLength(0);
    } finally {
      process.env.R2_PUBLIC_DOMAIN = publicDomain;
    }
  });

  test('returns 503 when no DeepSeek key is configured', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const houseId = await createHouse('Unconfigured House', ['house-hunt/2026/01/photo.jpg']);

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
    expect(visionCalls).toHaveLength(0);
  });

  test('returns 502 when the DeepSeek API fails', async () => {
    visionResponse = { status: 500, body: { error: { message: 'upstream exploded' } } };
    const houseId = await createHouse('Provider Error House', ['house-hunt/2026/01/photo.jpg']);

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_PROVIDER_ERROR');
  });

  test('passes rate limiting responses through as 429', async () => {
    visionResponse = { status: 429, body: { error: { message: 'slow down' } } };
    const houseId = await createHouse('Rate Limited House', ['house-hunt/2026/01/photo.jpg']);

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('rate limit');
  });

  test('returns 502 when DeepSeek returns an empty analysis', async () => {
    visionResponse = { status: 200, body: { choices: [{ message: { content: '   ' } }] } };
    const houseId = await createHouse('Empty Response House', ['house-hunt/2026/01/photo.jpg']);

    const res = await request(app).post(`/api/houses/${houseId}/analyze-vision`).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_EMPTY_RESPONSE');
  });
});

describe('analyzePropertyImages', () => {
  const config = {
    apiKey: 'test-key',
    baseUrl: 'https://vision.test/v1',
    model: 'test-vision-model'
  };

  test('does not duplicate the chat completions path', async () => {
    await analyzePropertyImages(['https://images.test/a.jpg'], 'prompt', {
      config: { ...config, baseUrl: 'https://vision.test/v1/chat/completions/' }
    });

    expect(visionCalls[0].url).toBe('https://vision.test/v1/chat/completions');
  });

  test('rejects calls without publicly reachable images', async () => {
    await expect(analyzePropertyImages(['/uploads/photo.jpg'], 'prompt', { config }))
      .rejects.toMatchObject({ status: 400, code: 'NO_IMAGES' });
    expect(visionCalls).toHaveLength(0);
  });

  test('caps the number of images sent to the model', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://images.test/${i}.jpg`);
    await analyzePropertyImages(urls, 'prompt', { config });

    const imageParts = visionCalls[0].body.messages[0].content.filter(part => part.type === 'image_url');
    expect(imageParts).toHaveLength(12);
  });

  test('requires an API key', async () => {
    await expect(analyzePropertyImages(['https://images.test/a.jpg'], 'prompt', {
      config: { ...config, apiKey: '' }
    })).rejects.toMatchObject({ status: 503, code: 'AI_NOT_CONFIGURED' });
    expect(visionCalls).toHaveLength(0);
  });
});
