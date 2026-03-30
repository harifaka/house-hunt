const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const { getDb } = require('../database');
const { getAllQuestions, calculateScore, getGroups } = require('../questions');
const { logger } = require('../logger');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'uploads'),
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const allowedImageTypes = /^image\/(jpeg|png|gif|webp|bmp|svg\+xml)$/;
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedImageTypes.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

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
      const thumb = await db.prepare('SELECT filename FROM house_images WHERE house_id = ? ORDER BY sort_order, created_at LIMIT 1').get(house.id);
      return { ...house, answers, answeredCount, totalQuestions, overallScore, groupScores, progress, thumbnail: thumb ? thumb.filename : null };
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
      const thumb = await db.prepare('SELECT filename FROM house_images WHERE house_id = ? ORDER BY sort_order, created_at LIMIT 1').get(house.id);
      return { ...house, answeredCount, totalQuestions, overallScore, groupScores, progress, thumbnail: thumb ? thumb.filename : null };
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
    const { name, address, asking_price, notes, description, source } = req.body;
    const id = crypto.randomUUID();
    const price = asking_price ? parseFloat(asking_price) : null;

    await db.prepare(
      'INSERT INTO houses (id, name, address, asking_price, notes, description, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, address || null, price, notes || null, description || null, source || 'manual');

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
    const images = await db.prepare('SELECT * FROM house_images WHERE house_id = ? ORDER BY sort_order, created_at').all(house.id);

    res.render('house-detail', {
      pageTitle: house.name,
      currentPath: '/houses/' + house.id,
      house: { ...house, answeredCount, totalQuestions, overallScore, groupScores, progress },
      groups,
      answers,
      images
    });
  } finally {
    await db.close();
  }
});

// POST /houses/:id — Update house
router.post('/houses/:id', async (req, res) => {
  const db = await getDb();
  try {
    const { name, address, asking_price, notes, description, source } = req.body;
    const price = asking_price ? parseFloat(asking_price) : null;

    await db.prepare(
      'UPDATE houses SET name = ?, address = ?, asking_price = ?, notes = ?, description = ?, source = ?, updated_at = ? WHERE id = ?'
    ).run(name, address || null, price, notes || null, description || null, source || 'manual', new Date().toISOString(), req.params.id);

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

// POST /houses/:id/upload-image — Upload image to house
router.post('/houses/:id/upload-image', upload.single('image'), async (req, res) => {
  const db = await getDb();
  try {
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
    if (!house) return res.status(404).json({ error: 'House not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const id = crypto.randomUUID();
    const caption = req.body.caption || null;
    await db.prepare(
      'INSERT INTO house_images (id, house_id, filename, caption) VALUES (?, ?, ?, ?)'
    ).run(id, house.id, req.file.filename, caption);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.imageUploaded(house.id, 'house', req.file.filename, meta).catch(() => {});

    res.json({ success: true, id, filename: req.file.filename });
  } finally {
    await db.close();
  }
});

// POST /houses/:id/delete-image/:imageId — Delete house image
router.post('/houses/:id/delete-image/:imageId', async (req, res) => {
  const db = await getDb();
  try {
    await db.prepare('DELETE FROM house_images WHERE id = ? AND house_id = ?').run(req.params.imageId, req.params.id);
    res.redirect('/houses/' + req.params.id);
  } finally {
    await db.close();
  }
});

// GET /api/houses/:id/images — JSON list of house images (for live polling)
router.get('/api/houses/:id/images', async (req, res) => {
  const db = await getDb();
  try {
    const images = await db.prepare('SELECT * FROM house_images WHERE house_id = ? ORDER BY sort_order, created_at').all(req.params.id);
    res.json(images);
  } finally {
    await db.close();
  }
});

// GET /guide — User guide / tutorial page
router.get('/guide', (req, res) => {
  res.render('guide', {
    pageTitle: req.lang === 'en' ? 'User Guide' : 'Felhasználói útmutató',
    currentPath: '/guide'
  });
});

module.exports = router;
