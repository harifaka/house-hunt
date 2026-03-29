const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { getDb } = require('../database');
const { getGroups, getGroupQuestions, getAllQuestions, calculateScore } = require('../questions');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'uploads'),
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// GET /quiz — Quiz landing page (house selection)
router.get('/', async (req, res) => {
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
      return { ...house, answeredCount, totalQuestions, overallScore, progress };
    }));

    res.render('quiz-landing', {
      pageTitle: res.locals.t.quiz,
      currentPath: '/quiz',
      houses: housesWithStats
    });
  } finally {
    await db.close();
  }
});

// GET /quiz/:houseId — Quiz overview (groups list with progress)
router.get('/:houseId', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.houseId);
    if (!house) return res.redirect('/houses');

    const groups = getGroups(lang);
    const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
    const totalQuestions = getAllQuestions(lang).length;
    const answeredCount = answers.filter(a => a.option_id).length;
    const { overallScore, groupScores } = calculateScore(answers, lang);
    const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;

    const groupsWithProgress = groups.map(g => {
      const gs = groupScores[g.id] || { answered: 0, total: g.questionCount, score: 0 };
      const gProgress = gs.total > 0 ? Math.round((gs.answered / gs.total) * 100) : 0;
      return { ...g, answered: gs.answered, total: gs.total, score: gs.score, progress: gProgress };
    });

    res.render('quiz-overview', {
      pageTitle: house.name + ' — ' + res.locals.t.quiz,
      currentPath: '/quiz',
      house,
      groups: groupsWithProgress,
      overallScore,
      answeredCount,
      totalQuestions,
      progress
    });
  } finally {
    await db.close();
  }
});

// GET /quiz/:houseId/results — Inspection results
router.get('/:houseId/results', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.houseId);
    if (!house) return res.redirect('/houses');

    const groups = getGroups(lang);
    const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
    const allQuestions = getAllQuestions(lang);
    const answeredCount = answers.filter(a => a.option_id).length;
    const { overallScore, groupScores } = calculateScore(answers, lang);

    const detailedGroups = groups.map(g => {
      const groupQ = getGroupQuestions(g.id, lang);
      const questions = groupQ.questions.map(q => {
        const ans = answers.find(a => a.question_id === q.id);
        const selectedOption = ans && ans.option_id
          ? q.options.find(o => o.id === ans.option_id) || null
          : null;
        return { ...q, answer: ans || null, selectedOption };
      });
      const gs = groupScores[g.id] || { score: 0, answered: 0, total: g.questionCount };
      return { ...g, questions, score: gs.score, answered: gs.answered, total: gs.total };
    });

    res.render('quiz-results', {
      pageTitle: house.name + ' — ' + res.locals.t.results,
      currentPath: '/quiz',
      house,
      overallScore,
      answeredCount,
      totalQuestions: allQuestions.length,
      groups: detailedGroups,
      groupScores
    });
  } finally {
    await db.close();
  }
});

// GET /quiz/:houseId/:groupId — Show group questions
router.get('/:houseId/:groupId', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang;
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.houseId);
    if (!house) return res.redirect('/houses');

    const group = getGroupQuestions(req.params.groupId, lang);
    if (!group) return res.redirect('/quiz/' + house.id);

    const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
    const allGroups = getGroups(lang);
    const currentIdx = allGroups.findIndex(g => g.id === req.params.groupId);
    const prevGroup = currentIdx > 0 ? allGroups[currentIdx - 1] : null;
    const nextGroup = currentIdx < allGroups.length - 1 ? allGroups[currentIdx + 1] : null;

    const answeredInGroup = group.questions.filter(q => answers.some(a => a.question_id === q.id && a.option_id)).length;

    const questionsWithAnswers = group.questions.map(q => {
      const ans = answers.find(a => a.question_id === q.id);
      return { ...q, currentAnswer: ans || null };
    });

    res.render('quiz-group', {
      pageTitle: group.name + ' — ' + house.name,
      currentPath: '/quiz',
      house,
      group: { ...group, questions: questionsWithAnswers },
      prevGroup,
      nextGroup,
      answeredInGroup,
      totalInGroup: group.questions.length,
      groupIndex: currentIdx,
      totalGroups: allGroups.length
    });
  } finally {
    await db.close();
  }
});

// POST /quiz/:houseId/answer — Save single answer (AJAX)
router.post('/:houseId/answer', async (req, res) => {
  const db = await getDb();
  try {
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.houseId);
    if (!house) return res.status(404).json({ error: 'House not found' });

    const { questionId, optionId, notes } = req.body;
    if (!questionId) return res.status(400).json({ error: 'questionId required' });

    await db.prepare(
      'INSERT OR REPLACE INTO answers (house_id, question_id, option_id, notes) VALUES (?, ?, ?, ?)'
    ).run(house.id, questionId, optionId || null, notes || null);

    res.json({ success: true });
  } finally {
    await db.close();
  }
});

// POST /quiz/:houseId/upload/:questionId — Upload image for question
router.post('/:houseId/upload/:questionId', upload.single('image'), async (req, res) => {
  const db = await getDb();
  try {
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.houseId);
    if (!house) return res.status(404).json({ error: 'House not found' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const existing = await db.prepare(
      'SELECT id FROM answers WHERE house_id = ? AND question_id = ?'
    ).get(house.id, req.params.questionId);

    if (existing) {
      await db.prepare('UPDATE answers SET image_path = ? WHERE house_id = ? AND question_id = ?')
        .run(req.file.filename, house.id, req.params.questionId);
    } else {
      await db.prepare(
        'INSERT INTO answers (house_id, question_id, option_id, notes, image_path) VALUES (?, ?, NULL, NULL, ?)'
      ).run(house.id, req.params.questionId, req.file.filename);
    }

    res.json({ success: true, filename: req.file.filename });
  } finally {
    await db.close();
  }
});

// POST /quiz/:houseId/:groupId — Save answers for group
router.post('/:houseId/:groupId', async (req, res) => {
  const db = await getDb();
  try {
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.houseId);
    if (!house) return res.redirect('/houses');

    const group = getGroupQuestions(req.params.groupId, req.lang);
    if (!group) return res.redirect('/quiz/' + house.id);

    const stmt = db.prepare(
      'INSERT OR REPLACE INTO answers (house_id, question_id, option_id, notes) VALUES (?, ?, ?, ?)'
    );

    await db.transaction(async () => {
      for (const q of group.questions) {
        const optionId = req.body['option_' + q.id] || null;
        const notes = req.body['notes_' + q.id] || null;
        if (optionId || notes) {
          await stmt.run(house.id, q.id, optionId, notes);
        }
      }
    });

    const dest = req.body.action === 'next' && req.body.nextGroup
      ? '/quiz/' + house.id + '/' + req.body.nextGroup
      : '/quiz/' + house.id;
    res.redirect(dest);
  } finally {
    await db.close();
  }
});

module.exports = router;
