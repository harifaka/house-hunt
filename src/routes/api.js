const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { getDb } = require('../database');
const { getAllQuestions, getGroups, getGroupQuestions, calculateScore } = require('../questions');
const { getAIConfig, generateReport, analyzeImage, computeImageHash } = require('../ai-service');

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
    ? {
      title: 'Property Inspection Report', score: 'Overall Score', generated: 'Generated',
      address: 'Address', price: 'Asking Price', date: 'Date', condition: 'Condition',
      summary: 'Summary', findings: 'Detailed Findings', notes: 'Notes',
      excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor',
      page: 'Page', scoreBreakdown: 'Score Breakdown', notAnswered: 'not answered'
    }
    : {
      title: 'Ingatlan szemle jelent\u00e9s', score: '\u00d6sszpontsz\u00e1m', generated: 'K\u00e9sz\u00fclt',
      address: 'C\u00edm', price: 'K\u00e9rt \u00e1r', date: 'D\u00e1tum', condition: '\u00c1llapot',
      summary: '\u00d6sszefoglal\u00f3', findings: 'R\u00e9szletes meg\u00e1llap\u00edt\u00e1sok', notes: 'Megjegyz\u00e9sek',
      excellent: 'Kiv\u00e1l\u00f3', good: 'J\u00f3', fair: 'K\u00f6zepes', poor: 'Gyenge',
      page: 'Oldal', scoreBreakdown: 'Pontsz\u00e1m r\u00e9szletez\u00e9s', notAnswered: 'nem v\u00e1laszolt'
    };

  // Resolve a Unicode-capable font for Hungarian characters
  const fontDir = path.join(__dirname, '..', '..', 'fonts');
  const regularFontPath = path.join(fontDir, 'NotoSans-Regular.ttf');
  const boldFontPath = path.join(fontDir, 'NotoSans-Bold.ttf');
  const hasCustomFont = fs.existsSync(regularFontPath);

  const doc = new PDFDocument({ size: 'A4', margin: 60, bufferPages: true });
  const filename = (data.house.name || 'house').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}_report.pdf"`);
  doc.pipe(res);

  // Register custom fonts for Hungarian character support
  if (hasCustomFont) {
    doc.registerFont('main', regularFontPath);
    doc.registerFont('bold', boldFontPath);
    doc.font('main');
  }

  const mainFont = hasCustomFont ? 'main' : 'Helvetica';
  const boldFont = hasCustomFont ? 'bold' : 'Helvetica-Bold';
  const pageWidth = 595.28 - 120; // A4 minus margins
  const accentColor = '#1a237e';
  const mutedColor = '#616161';

  function getConditionLabel(score) {
    if (score >= 75) return labels.excellent;
    if (score >= 50) return labels.good;
    if (score >= 25) return labels.fair;
    return labels.poor;
  }

  function getConditionColor(score) {
    if (score >= 75) return '#2e7d32';
    if (score >= 50) return '#f57c00';
    if (score >= 25) return '#e65100';
    return '#c62828';
  }

  function drawScoreBar(x, y, width, score) {
    doc.save();
    doc.roundedRect(x, y, width, 8, 4).fill('#e0e0e0');
    if (score > 0) {
      const fillWidth = Math.max(8, width * score / 100);
      doc.roundedRect(x, y, fillWidth, 8, 4).fill(getConditionColor(score));
    }
    doc.restore();
  }

  // ==========================================
  // TITLE PAGE
  // ==========================================
  doc.rect(0, 0, 595.28, 200).fill(accentColor);
  doc.fill('#ffffff').font(boldFont).fontSize(32)
    .text(labels.title, 60, 70, { width: pageWidth, align: 'center' });
  doc.fontSize(14).font(mainFont)
    .text(new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU', { year: 'numeric', month: 'long', day: 'numeric' }), 60, 120, { width: pageWidth, align: 'center' });

  doc.fill('#000000');
  doc.moveDown(4);
  doc.y = 240;
  doc.font(boldFont).fontSize(26).text(data.house.name, { align: 'center' });
  doc.moveDown(0.5);
  if (data.house.address) {
    doc.font(mainFont).fontSize(13).fillColor(mutedColor)
      .text(data.house.address, { align: 'center' });
  }
  doc.moveDown(1);
  if (data.house.asking_price) {
    doc.font(mainFont).fontSize(13).fillColor(mutedColor)
      .text(`${labels.price}: ${Number(data.house.asking_price).toLocaleString()} Ft`, { align: 'center' });
  }

  // Big score circle
  doc.moveDown(2);
  const scoreY = doc.y + 20;
  const scoreCenterX = 595.28 / 2;
  doc.save();
  doc.circle(scoreCenterX, scoreY + 50, 60).fill('#f5f5f5');
  doc.circle(scoreCenterX, scoreY + 50, 55).fill(getConditionColor(data.overallScore));
  doc.fill('#ffffff').font(boldFont).fontSize(36)
    .text(`${data.overallScore}%`, scoreCenterX - 50, scoreY + 32, { width: 100, align: 'center' });
  doc.restore();

  doc.fill('#000000').font(mainFont).fontSize(12)
    .text(`${labels.score} — ${getConditionLabel(data.overallScore)}`, 60, scoreY + 125, { width: pageWidth, align: 'center' });

  if (data.house.notes) {
    doc.moveDown(2);
    doc.font(mainFont).fontSize(10).fillColor(mutedColor)
      .text(`${labels.notes}: ${data.house.notes}`, { align: 'center' });
  }

  // ==========================================
  // SCORE BREAKDOWN PAGE
  // ==========================================
  doc.addPage();
  doc.fillColor(accentColor).font(boldFont).fontSize(22)
    .text(labels.scoreBreakdown);
  doc.moveDown(0.3);
  doc.moveTo(60, doc.y).lineTo(60 + pageWidth, doc.y).strokeColor(accentColor).lineWidth(2).stroke();
  doc.moveDown(1);

  for (const g of data.groups) {
    if (doc.y > 700) doc.addPage();
    doc.fillColor('#000000').font(boldFont).fontSize(12).text(g.name, { continued: false });
    doc.font(mainFont).fontSize(10).fillColor(mutedColor)
      .text(`${g.answered}/${g.total} ${labels.notAnswered.replace('nem ', '')} — ${getConditionLabel(g.score)}`);
    doc.moveDown(0.3);
    drawScoreBar(60, doc.y, pageWidth - 60, g.score);
    doc.moveDown(0.3);
    doc.fillColor(getConditionColor(g.score)).font(boldFont).fontSize(10)
      .text(`${g.score}%`, { align: 'right' });
    doc.moveDown(0.8);
  }

  // ==========================================
  // DETAILED FINDINGS — Narrative style, no Q&A numbers
  // ==========================================
  doc.addPage();
  doc.fillColor(accentColor).font(boldFont).fontSize(22)
    .text(labels.findings);
  doc.moveDown(0.3);
  doc.moveTo(60, doc.y).lineTo(60 + pageWidth, doc.y).strokeColor(accentColor).lineWidth(2).stroke();
  doc.moveDown(1);

  for (const g of data.groups) {
    if (doc.y > 650) doc.addPage();

    // Section header
    doc.fillColor(accentColor).font(boldFont).fontSize(15).text(g.name);
    doc.moveDown(0.2);
    drawScoreBar(60, doc.y, 150, g.score);
    doc.moveDown(0.6);

    // Build narrative: plain text paragraph from all answers
    const sentences = [];
    for (const q of g.questions) {
      if (q.selectedOption) {
        sentences.push(q.selectedOption.text);
        if (q.selectedOption.estimatedCost) {
          const costNote = lang === 'en'
            ? `Estimated cost: ${q.selectedOption.estimatedCost}.`
            : `Becs\u00fclt k\u00f6lts\u00e9g: ${q.selectedOption.estimatedCost}.`;
          sentences.push(costNote);
        }
      }
      if (q.answer && q.answer.notes) {
        sentences.push(q.answer.notes);
      }
      if (q.answer && q.answer.image_description) {
        sentences.push(q.answer.image_description);
      }
    }

    if (sentences.length > 0) {
      const paragraph = sentences.map(s => {
        const trimmed = s.trim();
        if (!trimmed) return '';
        return trimmed.endsWith('.') ? trimmed : trimmed + '.';
      }).filter(Boolean).join(' ');

      doc.fillColor('#212121').font(mainFont).fontSize(10)
        .text(paragraph, { align: 'justify', lineGap: 3 });
    } else {
      const noData = lang === 'en' ? 'No inspection data recorded for this section.' : 'Nincs r\u00f6gz\u00edtett szemle adat ehhez a r\u00e9szhez.';
      doc.fillColor(mutedColor).font(mainFont).fontSize(10).text(noData);
    }

    doc.moveDown(1.2);
  }

  // ==========================================
  // AI REPORTS (if any)
  // ==========================================
  const db2 = getDb();
  try {
    const aiReports = db2.prepare(
      'SELECT * FROM ai_reports WHERE house_id = ? AND status = ? ORDER BY created_at DESC'
    ).all(data.house.id, 'completed');

    if (aiReports.length > 0) {
      doc.addPage();
      doc.fillColor(accentColor).font(boldFont).fontSize(22)
        .text(lang === 'en' ? 'AI Analysis Reports' : 'AI elemz\u00e9si jelent\u00e9sek');
      doc.moveDown(0.3);
      doc.moveTo(60, doc.y).lineTo(60 + pageWidth, doc.y).strokeColor(accentColor).lineWidth(2).stroke();
      doc.moveDown(1);

      for (const report of aiReports) {
        if (doc.y > 650) doc.addPage();

        doc.fillColor(mutedColor).font(mainFont).fontSize(9)
          .text(`${labels.generated}: ${report.created_at}`);
        doc.moveDown(0.3);

        if (report.summary) {
          doc.fillColor('#212121').font(mainFont).fontSize(10)
            .text(report.summary, { align: 'justify', lineGap: 3 });
          doc.moveDown(0.8);
        }

        // Section details
        let sections = [];
        try { sections = JSON.parse(report.report_text).sections || []; } catch { /* ignore */ }
        for (const sec of sections) {
          if (doc.y > 680) doc.addPage();
          doc.fillColor(accentColor).font(boldFont).fontSize(11).text(sec.section_name);
          doc.moveDown(0.2);
          doc.fillColor('#212121').font(mainFont).fontSize(10)
            .text(sec.report_text, { align: 'justify', lineGap: 3 });
          doc.moveDown(0.6);
        }
        doc.moveDown(1);
      }
    }
  } finally {
    db2.close();
  }

  // ==========================================
  // FOOTER on every page
  // ==========================================
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    // Footer line
    doc.save();
    doc.moveTo(60, 770).lineTo(60 + pageWidth, 770).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    doc.restore();
    doc.fillColor(mutedColor).font(mainFont).fontSize(7)
      .text(
        `${data.house.name} | ${labels.generated}: ${new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU')} | ${labels.page} ${i + 1}/${pages.count}`,
        60, 775,
        { align: 'center', width: pageWidth }
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

// POST /api/ai/analyze/:houseId — Start async AI analysis
router.post('/ai/analyze/:houseId', (req, res) => {
  const lang = req.lang || 'hu';
  const data = getHouseExportData(req.params.houseId, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  const config = getAIConfig();
  if (!config.provider || !config.endpoint) {
    return res.status(400).json({ error: lang === 'en' ? 'AI not configured. Please set up AI provider in settings.' : 'Az AI nincs konfigur\u00e1lva. K\u00e9rlek \u00e1ll\u00edtsd be az AI szolg\u00e1ltat\u00f3t a be\u00e1ll\u00edt\u00e1sokban.' });
  }

  // Start async generation — don't await, return immediately
  generateReport(req.params.houseId, data, lang).catch(err => {
    console.error('[AI] Report generation failed:', err.message);
  });

  res.json({
    success: true,
    message: lang === 'en' ? 'AI analysis started. You will be notified when complete.' : 'AI elemz\u00e9s elindult. \u00c9rtes\u00edt\u00e9st kapsz, ha k\u00e9sz.',
    config: { provider: config.provider, model: config.model }
  });
});

// GET /api/ai/reports/:houseId — List all AI reports for a house
router.get('/ai/reports/:houseId', (req, res) => {
  const db = getDb();
  try {
    const reports = db.prepare(
      'SELECT id, status, lang, summary, created_at, completed_at FROM ai_reports WHERE house_id = ? ORDER BY created_at DESC'
    ).all(req.params.houseId);
    res.json(reports);
  } finally {
    db.close();
  }
});

// GET /api/ai/report/:reportId — Get full AI report
router.get('/ai/report/:reportId', (req, res) => {
  const db = getDb();
  try {
    const report = db.prepare('SELECT * FROM ai_reports WHERE id = ?').get(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    let sections = [];
    try { sections = JSON.parse(report.report_text).sections || []; } catch { /* empty */ }

    res.json({
      ...report,
      sections
    });
  } finally {
    db.close();
  }
});

// POST /api/ai/analyze-image — Analyze image and cache description
router.post('/ai/analyze-image', async (req, res) => {
  const { imagePath, answerId } = req.body;
  if (!imagePath) return res.status(400).json({ error: 'imagePath required' });

  const config = getAIConfig();
  if (!config.provider || !config.endpoint) {
    return res.status(400).json({ error: 'AI not configured' });
  }

  try {
    const description = await analyzeImage(imagePath, config);
    if (!description) {
      return res.status(500).json({ error: 'Image analysis failed or model does not support vision' });
    }

    // Update answer image_description if answerId provided
    if (answerId) {
      const db = getDb();
      try {
        db.prepare('UPDATE answers SET image_description = ? WHERE id = ?').run(description, answerId);
      } finally {
        db.close();
      }
    }

    res.json({ success: true, description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/answers/:answerId/description — Update image description (manual edit)
router.put('/answers/:answerId/description', (req, res) => {
  const { description } = req.body;
  const db = getDb();
  try {
    const answer = db.prepare('SELECT id, image_path FROM answers WHERE id = ?').get(req.params.answerId);
    if (!answer) return res.status(404).json({ error: 'Answer not found' });

    db.prepare('UPDATE answers SET image_description = ? WHERE id = ?').run(description || null, answer.id);

    // Also update cache if image exists
    if (answer.image_path && description) {
      const hash = computeImageHash(answer.image_path);
      if (hash) {
        const crypto = require('crypto');
        db.prepare(
          'INSERT OR REPLACE INTO image_descriptions (id, image_hash, image_path, description) VALUES (?, ?, ?, ?)'
        ).run(crypto.randomUUID(), hash, answer.image_path, description);
      }
    }

    res.json({ success: true });
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
