const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { getGroups, getAllQuestions, calculateScore } = require('../questions');

// GET /admin — Settings page
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;

    const houses = db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();

    res.render('admin', {
      pageTitle: res.locals.t.settings,
      currentPath: '/admin',
      settings,
      houses
    });
  } finally {
    db.close();
  }
});

// POST /admin/settings — Save settings
router.post('/settings', (req, res) => {
  const db = getDb();
  try {
    const { language, app_title } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const save = db.transaction(() => {
      if (language) upsert.run('language', language);
      if (app_title) upsert.run('app_title', app_title);
    });
    save();
    if (language) req.session.lang = language;
    res.redirect('/admin');
  } finally {
    db.close();
  }
});

// GET /admin/ai — AI configuration page
router.get('/ai', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;

    res.render('admin', {
      pageTitle: res.locals.t.settings + ' — AI',
      currentPath: '/admin',
      settings,
      houses: []
    });
  } finally {
    db.close();
  }
});

// POST /admin/ai — Save AI config
router.post('/ai', (req, res) => {
  const db = getDb();
  try {
    const { ai_provider, ai_endpoint, ai_model, ai_api_key } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const save = db.transaction(() => {
      if (ai_provider) upsert.run('ai_provider', ai_provider);
      if (ai_endpoint) upsert.run('ai_endpoint', ai_endpoint);
      if (ai_model) upsert.run('ai_model', ai_model);
      upsert.run('ai_api_key', ai_api_key || '');
    });
    save();
    res.redirect('/admin');
  } finally {
    db.close();
  }
});

// GET /admin/export — Export page
router.get('/export', (req, res) => {
  const db = getDb();
  try {
    const lang = req.lang;
    const houses = db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const totalQuestions = getAllQuestions(lang).length;

    const housesWithStats = houses.map(house => {
      const answers = db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const { overallScore } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, overallScore, progress, answeredCount, totalQuestions };
    });

    res.render('export', {
      pageTitle: res.locals.t.export,
      currentPath: '/export',
      houses: housesWithStats
    });
  } finally {
    db.close();
  }
});

// GET /admin/ai-analysis — AI Analysis page
router.get('/ai-analysis', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const aiConfig = {};
    for (const r of rows) aiConfig[r.key.replace('ai_', '')] = r.value;

    const houses = db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();

    res.render('ai-analysis', {
      pageTitle: res.locals.t.ai_analysis,
      currentPath: '/ai',
      houses,
      aiConfig
    });
  } finally {
    db.close();
  }
});

module.exports = router;
