const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { getDb } = require('../database');
const { getAllQuestions, getGroups, getGroupQuestions, calculateScore } = require('../questions');

// --- Helpers ---

function getHouseExportData(houseId, lang) {
  const db = getDb();
  try {
    const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId);
    if (!house) return null;

    const answers = db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
    const groups = getGroups(lang);
    const allQuestions = getAllQuestions(lang);
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

    return { house, answers, groups: detailedGroups, overallScore, groupScores, totalQuestions: allQuestions.length };
  } finally {
    db.close();
  }
}

function escapeCsvField(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// --- Export Endpoints ---

router.get('/export/:houseId/json', (req, res) => {
  const lang = req.lang || 'hu';
  const data = getHouseExportData(req.params.houseId, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  const exportData = {
    exportDate: new Date().toISOString(),
    language: lang,
    house: {
      name: data.house.name,
      address: data.house.address,
      askingPrice: data.house.asking_price,
      notes: data.house.notes,
      createdAt: data.house.created_at
    },
    overallScore: data.overallScore,
    groups: data.groups.map(g => ({
      name: g.name,
      score: g.score,
      answered: g.answered,
      total: g.total,
      questions: g.questions.map(q => ({
        question: q.text,
        answer: q.selectedOption ? q.selectedOption.text : null,
        score: q.selectedOption ? q.selectedOption.score : null,
        impact: q.selectedOption ? q.selectedOption.impact : null,
        estimatedCost: q.selectedOption ? q.selectedOption.estimatedCost : null,
        notes: q.answer ? q.answer.notes : null,
        imagePath: q.answer ? q.answer.image_path : null
      }))
    }))
  };

  const filename = (data.house.name || 'house').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}_inspection.json"`);
  res.json(exportData);
});

router.get('/export/:houseId/csv', (req, res) => {
  const lang = req.lang || 'hu';
  const data = getHouseExportData(req.params.houseId, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  const headers = ['Group', 'Question', 'Answer', 'Score', 'Impact', 'EstimatedCost', 'Notes'];
  const rows = [headers.map(escapeCsvField).join(',')];

  for (const g of data.groups) {
    for (const q of g.questions) {
      rows.push([
        escapeCsvField(g.name),
        escapeCsvField(q.text),
        escapeCsvField(q.selectedOption ? q.selectedOption.text : ''),
        escapeCsvField(q.selectedOption ? q.selectedOption.score : ''),
        escapeCsvField(q.selectedOption ? q.selectedOption.impact : ''),
        escapeCsvField(q.selectedOption ? q.selectedOption.estimatedCost : ''),
        escapeCsvField(q.answer ? q.answer.notes : '')
      ].join(','));
    }
  }

  const filename = (data.house.name || 'house').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}_inspection.csv"`);
  res.send('\uFEFF' + rows.join('\r\n'));
});

router.get('/export/:houseId/pdf', (req, res) => {
  const lang = req.lang || 'hu';
  const data = getHouseExportData(req.params.houseId, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  const labels = lang === 'en'
    ? { title: 'House Inspection Report', score: 'Overall Score', group: 'Group', question: 'Question', answer: 'Answer', impact: 'Impact', cost: 'Estimated Cost', notes: 'Notes', generated: 'Generated', address: 'Address', price: 'Asking Price', date: 'Date', na: 'N/A', noAnswer: 'Not answered' }
    : { title: 'Házvizsgálati jelentés', score: 'Összesített pontszám', group: 'Csoport', question: 'Kérdés', answer: 'Válasz', impact: 'Hatás', cost: 'Becsült költség', notes: 'Megjegyzések', generated: 'Generálva', address: 'Cím', price: 'Kért ár', date: 'Dátum', na: 'N/A', noAnswer: 'Nincs válasz' };

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const filename = (data.house.name || 'house').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}_report.pdf"`);
  doc.pipe(res);

  // Title page
  doc.fontSize(28).text(labels.title, { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(22).text(data.house.name, { align: 'center' });
  doc.moveDown(0.5);
  if (data.house.address) {
    doc.fontSize(14).text(data.house.address, { align: 'center' });
  }
  doc.moveDown(1);
  doc.fontSize(12).text(`${labels.date}: ${new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU')}`, { align: 'center' });
  if (data.house.asking_price) {
    doc.text(`${labels.price}: ${Number(data.house.asking_price).toLocaleString()} Ft`, { align: 'center' });
  }
  doc.moveDown(3);
  doc.fontSize(48).text(`${data.overallScore}%`, { align: 'center' });
  doc.fontSize(14).text(labels.score, { align: 'center' });

  // Group breakdown
  doc.addPage();
  doc.fontSize(20).text(labels.score, { underline: true });
  doc.moveDown(1);

  for (const g of data.groups) {
    doc.fontSize(14).text(`${g.name}: ${g.score}% (${g.answered}/${g.total})`);
    doc.moveDown(0.3);
  }

  // Detailed answers per group
  for (const g of data.groups) {
    doc.addPage();
    doc.fontSize(18).text(g.name, { underline: true });
    doc.fontSize(11).text(`${labels.score}: ${g.score}%`);
    doc.moveDown(0.8);

    for (const q of g.questions) {
      const ySpace = doc.y;
      if (ySpace > 700) doc.addPage();

      doc.fontSize(11).text(`${labels.question}: ${q.text}`, { continued: false });
      if (q.selectedOption) {
        doc.fontSize(10)
          .text(`  ${labels.answer}: ${q.selectedOption.text}`)
          .text(`  ${labels.score}: ${q.selectedOption.score}/10  |  ${labels.impact}: ${q.selectedOption.impact || labels.na}  |  ${labels.cost}: ${q.selectedOption.estimatedCost || labels.na}`);
      } else {
        doc.fontSize(10).text(`  ${labels.noAnswer}`);
      }
      if (q.answer && q.answer.notes) {
        doc.fontSize(9).text(`  ${labels.notes}: ${q.answer.notes}`);
      }
      doc.moveDown(0.6);
    }
  }

  // Footer on every page
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).text(
      `${labels.generated}: ${new Date().toISOString()} | ${data.house.name}`,
      50, 780,
      { align: 'center', width: 495 }
    );
  }

  doc.end();
});

// --- AI / LLM Endpoints ---

router.get('/ai/config', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const config = {};
    for (const r of rows) {
      config[r.key.replace('ai_', '')] = r.value;
    }
    res.json(config);
  } finally {
    db.close();
  }
});

router.post('/ai/config', (req, res) => {
  const db = getDb();
  try {
    const { provider, endpoint, model, apiKey } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const save = db.transaction(() => {
      if (provider) upsert.run('ai_provider', provider);
      if (endpoint) upsert.run('ai_endpoint', endpoint);
      if (model) upsert.run('ai_model', model);
      if (apiKey !== undefined) upsert.run('ai_api_key', apiKey);
    });
    save();
    res.json({ success: true });
  } finally {
    db.close();
  }
});

router.post('/ai/analyze/:houseId', (req, res) => {
  const lang = req.lang || 'hu';
  const data = getHouseExportData(req.params.houseId, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  const db = getDb();
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const config = {};
    for (const r of rows) config[r.key.replace('ai_', '')] = r.value;

    if (!config.provider || !config.endpoint) {
      return res.status(400).json({ error: 'AI not configured. Please set up AI provider in settings.' });
    }

    // Placeholder: in production this would call the configured LLM endpoint
    res.json({
      success: true,
      message: 'Analysis placeholder — LLM integration pending',
      config: { provider: config.provider, model: config.model },
      houseData: {
        name: data.house.name,
        overallScore: data.overallScore,
        groupCount: data.groups.length
      }
    });
  } finally {
    db.close();
  }
});

// --- General API ---

router.get('/houses', (req, res) => {
  const db = getDb();
  try {
    const lang = req.lang || 'hu';
    const houses = db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const result = houses.map(house => {
      const answers = db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const totalQuestions = getAllQuestions(lang).length;
      const { overallScore } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, overallScore, progress, answeredCount, totalQuestions };
    });
    res.json(result);
  } finally {
    db.close();
  }
});

router.get('/houses/:id', (req, res) => {
  const lang = req.lang || 'hu';
  const data = getHouseExportData(req.params.id, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  res.json({
    house: data.house,
    overallScore: data.overallScore,
    groupScores: data.groupScores,
    totalQuestions: data.totalQuestions,
    groups: data.groups.map(g => ({
      name: g.name,
      score: g.score,
      answered: g.answered,
      total: g.total,
      questions: g.questions.map(q => ({
        id: q.id,
        text: q.text,
        answer: q.selectedOption ? q.selectedOption.text : null,
        score: q.selectedOption ? q.selectedOption.score : null,
        impact: q.selectedOption ? q.selectedOption.impact : null,
        estimatedCost: q.selectedOption ? q.selectedOption.estimatedCost : null,
        notes: q.answer ? q.answer.notes : null
      }))
    }))
  });
});

module.exports = router;
