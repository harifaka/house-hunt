const request = require('supertest');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Use a temporary database for tests
const TEST_DB_PATH = path.join(__dirname, '..', 'db', 'test_features.sqlite');
process.env.DATABASE_PATH = TEST_DB_PATH;

const app = require('../app');
const { getDb } = require('../src/database');
const { calculateScore, loadQuestions } = require('../src/questions');

afterAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('Multi-choice Quiz Support', () => {
  test('questions.json contains multi_choice type questions', () => {
    const data = loadQuestions();
    const multiChoiceQuestions = [];
    for (const group of data.groups) {
      for (const q of group.questions) {
        if (q.type === 'multi_choice') {
          multiChoiceQuestions.push(q.id);
        }
      }
    }
    expect(multiChoiceQuestions.length).toBeGreaterThan(0);
    expect(multiChoiceQuestions).toContain('q13');
    expect(multiChoiceQuestions).toContain('q28');
    expect(multiChoiceQuestions).toContain('q29');
  });

  test('calculateScore handles multi_choice answers with comma-separated option_ids', () => {
    const answers = [
      { question_id: 'q13', option_id: 'q13_b,q13_c' }, // multi-choice: both defects selected
    ];
    const { groupScores } = calculateScore(answers, 'en');
    // q13 is in exterior_structure group
    const gs = groupScores.exterior_structure;
    expect(gs).toBeDefined();
    expect(gs.answered).toBe(1);
    // Score should be average of q13_b (3) and q13_c (3) = 3, times weight 3 = 9
    // Max is 10 * 3 * 14 questions = 420, single answer contributes 9/420
    expect(gs.score).toBeGreaterThan(0);
  });

  test('calculateScore handles single_choice answers normally', () => {
    const answers = [
      { question_id: 'q1', option_id: 'q1_a' }, // single choice
    ];
    const { groupScores } = calculateScore(answers, 'en');
    const gs = groupScores.lot_environment;
    expect(gs).toBeDefined();
    expect(gs.answered).toBe(1);
    expect(gs.score).toBeGreaterThan(0);
  });

  test('POST /quiz/:houseId/answer saves multi-choice answer', async () => {
    const db = await getDb();
    let houseId;
    try {
      houseId = crypto.randomUUID();
      await db.prepare('INSERT INTO houses (id, name) VALUES (?, ?)').run(houseId, 'Multi-choice Test');
    } finally {
      await db.close();
    }

    const res = await request(app)
      .post(`/quiz/${houseId}/answer`)
      .send({ questionId: 'q13', optionId: 'q13_b,q13_c' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const db2 = await getDb();
    try {
      const answer = await db2.prepare('SELECT * FROM answers WHERE house_id = ? AND question_id = ?').get(houseId, 'q13');
      expect(answer).toBeDefined();
      expect(answer.option_id).toBe('q13_b,q13_c');
    } finally {
      await db2.close();
    }
  });
});

describe('House Images & Editing', () => {
  let houseId;

  beforeAll(async () => {
    const db = await getDb();
    try {
      houseId = crypto.randomUUID();
      await db.prepare('INSERT INTO houses (id, name, description, source) VALUES (?, ?, ?, ?)')
        .run(houseId, 'Image Test House', 'A beautiful house', 'manual');
    } finally {
      await db.close();
    }
  });

  test('houses table has description and source columns', async () => {
    const db = await getDb();
    try {
      const house = await db.prepare('SELECT description, source FROM houses WHERE id = ?').get(houseId);
      expect(house).toBeDefined();
      expect(house.description).toBe('A beautiful house');
      expect(house.source).toBe('manual');
    } finally {
      await db.close();
    }
  });

  test('POST /houses/:id updates description and source', async () => {
    const res = await request(app)
      .post(`/houses/${houseId}`)
      .type('form')
      .send({
        name: 'Updated House',
        address: 'New Address',
        asking_price: '60000000',
        notes: 'Updated notes',
        description: 'Updated description',
        source: 'scraped'
      });
    expect(res.status).toBe(302);

    const db = await getDb();
    try {
      const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId);
      expect(house.description).toBe('Updated description');
      expect(house.source).toBe('scraped');
    } finally {
      await db.close();
    }
  });

  test('GET /houses/:id shows description and images section', async () => {
    const res = await request(app).get(`/houses/${houseId}?lang=en`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Updated description');
    expect(res.text).toContain('Photos');
  });
});

describe('Heating Calculator API', () => {
  test('GET /calculators/heating returns 200 with templates', async () => {
    const res = await request(app).get('/calculators/heating?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Saved Calculations');
    expect(res.text).toContain('Material Reference Library');
    expect(res.text).toContain('B30 Brick');
  });

  test('POST /calculators/heating/save persists a calculation', async () => {
    const res = await request(app)
      .post('/calculators/heating/save')
      .send({
        name: 'Test Calculation',
        parameters: JSON.stringify({ wallType: '0.47', wallArea: 120 }),
        results: JSON.stringify({ totalLoss: 5000, power: 5.0 })
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBeDefined();
  });

  test('GET /calculators/heating/list returns saved calculations', async () => {
    const res = await request(app).get('/calculators/heating/list');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Test Calculation');
  });

  test('GET /calculators/heating/load/:id returns calculation data', async () => {
    const listRes = await request(app).get('/calculators/heating/list');
    const calcId = listRes.body[0].id;

    const res = await request(app).get(`/calculators/heating/load/${calcId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Calculation');
    expect(res.body.parameters).toBeDefined();
    expect(res.body.results).toBeDefined();
  });

  test('POST /calculators/heating/delete/:id removes calculation', async () => {
    const listRes = await request(app).get('/calculators/heating/list');
    const calcId = listRes.body[0].id;

    const res = await request(app).post(`/calculators/heating/delete/${calcId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Window/Door Templates', () => {
  test('GET /calculators/templates returns standard templates', async () => {
    const res = await request(app).get('/calculators/templates');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThanOrEqual(8); // 8 seeded standard templates
  });

  test('POST /calculators/templates creates a custom template', async () => {
    const res = await request(app)
      .post('/calculators/templates')
      .send({ name: 'Custom Window', width: 1.0, height: 1.2, type: 'triple', u_value: 0.8 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBeDefined();
  });

  test('POST /calculators/templates/:id/delete deletes custom template', async () => {
    const listRes = await request(app).get('/calculators/templates');
    const custom = listRes.body.find(t => t.name === 'Custom Window');
    expect(custom).toBeDefined();

    const res = await request(app).post(`/calculators/templates/${custom.id}/delete`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /calculators/templates/:id/delete rejects standard template deletion', async () => {
    const listRes = await request(app).get('/calculators/templates');
    const standard = listRes.body.find(t => t.is_standard === 1);
    expect(standard).toBeDefined();

    const res = await request(app).post(`/calculators/templates/${standard.id}/delete`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot delete standard');
  });
});

describe('Theme Support', () => {
  test('pages include theme initialization script in head', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-theme');
    expect(res.text).toContain("document.documentElement.setAttribute('data-theme'");
  });

  test('pages include theme toggle button', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="theme-toggle"');
    expect(res.text).toContain('theme-toggle');
  });

  test('pages include theme.js script', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/js/theme.js');
  });

  test('theme.js is served as static file', async () => {
    const res = await request(app).get('/js/theme.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('theme');
    expect(res.text).toContain('cookie');
  });

  test('dark mode CSS variables are defined in stylesheet', async () => {
    const res = await request(app).get('/css/style.css');
    expect(res.status).toBe(200);
    expect(res.text).toContain('[data-theme="dark"]');
    expect(res.text).toContain('--surface');
    expect(res.text).toContain('--text-primary');
    expect(res.text).toContain('--border-color');
  });

  test('default theme is dark when no cookie set', async () => {
    const res = await request(app).get('/');
    // The inline script should default to dark
    expect(res.text).toContain("c?c[1]:'dark'");
  });

  test('admin link has subtle styling class', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('nav__link--admin');
  });
});
