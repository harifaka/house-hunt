const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../database');
const { getAllQuestions, calculateScore, getGroups } = require('../questions');

// GET / — Dashboard
router.get('/', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const houses = await db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const totalQuestions = getAllQuestions(lang).length;
    const groups = getGroups(lang);

    const housesWithStats = await Promise.all(houses.map(async house => {
      const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const { overallScore, groupScores } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, answers, answeredCount, totalQuestions, overallScore, groupScores, progress };
    }));

    const avgScore = housesWithStats.length > 0
      ? Math.round(housesWithStats.reduce((sum, h) => sum + h.overallScore, 0) / housesWithStats.length)
      : 0;
    const completedCount = housesWithStats.filter(h => h.progress === 100).length;

    res.render('home', {
      pageTitle: res.locals.t.home,
      currentPath: '/',
      houses: housesWithStats,
      totalHouses: houses.length,
      avgScore,
      completedCount,
      groups
    });
  } finally {
    await db.close();
  }
});

// GET /houses — House list
router.get('/houses', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const houses = await db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const totalQuestions = getAllQuestions(lang).length;

    const housesWithStats = await Promise.all(houses.map(async house => {
      const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const { overallScore, groupScores } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, answeredCount, totalQuestions, overallScore, groupScores, progress };
    }));

    res.render('houses', {
      pageTitle: res.locals.t.houses,
      currentPath: '/houses',
      houses: housesWithStats
    });
  } finally {
    await db.close();
  }
});

// POST /houses — Create house
router.post('/houses', async (req, res) => {
  const db = await getDb();
  try {
    const { name, address, asking_price, notes } = req.body;
    const id = crypto.randomUUID();
    const price = asking_price ? parseFloat(asking_price) : null;

    await db.prepare(
      'INSERT INTO houses (id, name, address, asking_price, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, address || null, price, notes || null);

    res.redirect('/houses/' + id);
  } finally {
    await db.close();
  }
});

// GET /houses/:id — House detail
router.get('/houses/:id', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
    if (!house) {
      return res.redirect('/houses');
    }

    const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
    const totalQuestions = getAllQuestions(lang).length;
    const answeredCount = answers.filter(a => a.option_id).length;
    const { overallScore, groupScores } = calculateScore(answers, lang);
    const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
    const groups = getGroups(lang);

    res.render('house-detail', {
      pageTitle: house.name,
      currentPath: '/houses/' + house.id,
      house: { ...house, answeredCount, totalQuestions, overallScore, groupScores, progress },
      groups,
      answers
    });
  } finally {
    await db.close();
  }
});

// POST /houses/:id — Update house
router.post('/houses/:id', async (req, res) => {
  const db = await getDb();
  try {
    const { name, address, asking_price, notes } = req.body;
    const price = asking_price ? parseFloat(asking_price) : null;

    await db.prepare(
      'UPDATE houses SET name = ?, address = ?, asking_price = ?, notes = ?, updated_at = ? WHERE id = ?'
    ).run(name, address || null, price, notes || null, new Date().toISOString(), req.params.id);

    res.redirect('/houses/' + req.params.id);
  } finally {
    await db.close();
  }
});

// POST /houses/:id/delete — Delete house
router.post('/houses/:id/delete', async (req, res) => {
  const db = await getDb();
  try {
    await db.prepare('DELETE FROM houses WHERE id = ?').run(req.params.id);
    res.redirect('/houses');
  } finally {
    await db.close();
  }
});

module.exports = router;
