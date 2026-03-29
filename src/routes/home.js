const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { getAllQuestions, calculateScore, getGroups } = require('../questions');

// GET / — Dashboard
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const lang = req.lang;
    const houses = db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const totalQuestions = getAllQuestions(lang).length;
    const groups = getGroups(lang);

    const housesWithStats = houses.map(house => {
      const answers = db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const { overallScore, groupScores } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, answers, answeredCount, totalQuestions, overallScore, groupScores, progress };
    });

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
    db.close();
  }
});

// GET /houses — House list
router.get('/houses', (req, res) => {
  const db = getDb();
  try {
    const lang = req.lang;
    const houses = db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const totalQuestions = getAllQuestions(lang).length;

    const housesWithStats = houses.map(house => {
      const answers = db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const { overallScore, groupScores } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, answeredCount, totalQuestions, overallScore, groupScores, progress };
    });

    res.render('houses', {
      pageTitle: res.locals.t.houses,
      currentPath: '/houses',
      houses: housesWithStats
    });
  } finally {
    db.close();
  }
});

// POST /houses — Create house
router.post('/houses', (req, res) => {
  const db = getDb();
  try {
    const { name, address, asking_price, notes } = req.body;
    const id = uuidv4();
    const price = asking_price ? parseFloat(asking_price) : null;

    db.prepare(
      'INSERT INTO houses (id, name, address, asking_price, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, address || null, price, notes || null);

    res.redirect('/houses/' + id);
  } finally {
    db.close();
  }
});

// GET /houses/:id — House detail
router.get('/houses/:id', (req, res) => {
  const db = getDb();
  try {
    const lang = req.lang;
    const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
    if (!house) {
      return res.redirect('/houses');
    }

    const answers = db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
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
    db.close();
  }
});

// POST /houses/:id — Update house
router.post('/houses/:id', (req, res) => {
  const db = getDb();
  try {
    const { name, address, asking_price, notes } = req.body;
    const price = asking_price ? parseFloat(asking_price) : null;

    db.prepare(
      `UPDATE houses SET name = ?, address = ?, asking_price = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(name, address || null, price, notes || null, req.params.id);

    res.redirect('/houses/' + req.params.id);
  } finally {
    db.close();
  }
});

// POST /houses/:id/delete — Delete house
router.post('/houses/:id/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM houses WHERE id = ?').run(req.params.id);
    res.redirect('/houses');
  } finally {
    db.close();
  }
});

module.exports = router;
