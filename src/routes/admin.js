const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { getAllQuestions, calculateScore } = require('../questions');

// GET /admin — Settings page
router.get('/', async (req, res) => {
  const db = await getDb();
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;

    const houses = await db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();

    res.render('admin', {
      pageTitle: res.locals.t.settings,
      currentPath: '/admin',
      settings,
      houses
    });
  } finally {
    await db.close();
  }
});

// POST /admin/settings — Save settings
router.post('/settings', async (req, res) => {
  const db = await getDb();
  try {
    const { language, app_title } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    await db.transaction(async () => {
      if (language) await upsert.run('language', language);
      if (app_title) await upsert.run('app_title', app_title);
    });
    if (language) req.session.lang = language;
    res.redirect('/admin');
  } finally {
    await db.close();
  }
});

// GET /admin/ai — AI configuration page
router.get('/ai', async (req, res) => {
  const db = await getDb();
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;

    res.render('admin', {
      pageTitle: res.locals.t.settings + ' — AI',
      currentPath: '/admin',
      settings,
      houses: []
    });
  } finally {
    await db.close();
  }
});

// POST /admin/ai — Save AI config
router.post('/ai', async (req, res) => {
  const db = await getDb();
  try {
    const { ai_provider, ai_endpoint, ai_model, ai_api_key } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    await db.transaction(async () => {
      if (ai_provider) await upsert.run('ai_provider', ai_provider);
      if (ai_endpoint) await upsert.run('ai_endpoint', ai_endpoint);
      if (ai_model) await upsert.run('ai_model', ai_model);
      await upsert.run('ai_api_key', ai_api_key || '');
    });
    res.redirect('/admin');
  } finally {
    await db.close();
  }
});

// GET /admin/export — Export page
router.get('/export', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const houses = await db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const totalQuestions = getAllQuestions(lang).length;

    const housesWithStats = await Promise.all(houses.map(async house => {
      const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const { overallScore } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, overallScore, progress, answeredCount, totalQuestions };
    }));

    res.render('export', {
      pageTitle: res.locals.t.export,
      currentPath: '/export',
      houses: housesWithStats
    });
  } finally {
    await db.close();
  }
});

// GET /admin/ai-analysis — AI Analysis page
router.get('/ai-analysis', async (req, res) => {
  const db = await getDb();
  try {
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const aiConfig = {};
    for (const r of rows) aiConfig[r.key.replace('ai_', '')] = r.value;

    const houses = await db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();

    res.render('ai-analysis', {
      pageTitle: res.locals.t.ai_analysis,
      currentPath: '/ai',
      houses,
      aiConfig,
      selectedHouse: req.query.house || ''
    });
  } finally {
    await db.close();
  }
});

module.exports = router;
