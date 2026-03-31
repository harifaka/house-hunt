const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database');
const { getAllQuestions, getGroups, getGroupQuestions, calculateScore } = require('../questions');
const { getAIConfig, generateReport, analyzeImage, computeImageHash } = require('../ai-service');
const { logger } = require('../logger');

// --- Helpers ---

const expensiveApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

async function getHouseExportData(houseId, lang) {
  const db = await getDb();
  try {
    const house = await db.prepare('SELECT * FROM houses WHERE id = ?').get(houseId);
    if (!house) return null;

    const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
    const groups = getGroups(lang);
    const allQuestions = getAllQuestions(lang);
    const { overallScore, groupScores } = calculateScore(answers, lang);

    const detailedGroups = groups.map(g => {
      const groupQ = getGroupQuestions(g.id, lang);
      const questions = groupQ.questions.map(q => {
        const ans = answers.find(a => a.question_id === q.id);
        let selectedOption = null;
        let selectedOptions = [];
        if (ans && ans.option_id) {
          if (q.type === 'multi_choice') {
            const ids = ans.option_id.split(',').filter(Boolean);
            selectedOptions = ids.map(id => q.options.find(o => o.id === id)).filter(Boolean);
            selectedOption = selectedOptions[0] || null;
          } else {
            selectedOption = q.options.find(o => o.id === ans.option_id) || null;
          }
        }
        return { ...q, answer: ans || null, selectedOption, selectedOptions };
      });
      const gs = groupScores[g.id] || { score: 0, answered: 0, total: g.questionCount };
      return { ...g, questions, score: gs.score, answered: gs.answered, total: gs.total };
    });

    return { house, answers, groups: detailedGroups, overallScore, groupScores, totalQuestions: allQuestions.length };
  } finally {
    await db.close();
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

router.get('/export/:houseId/json', async (req, res) => {
  const startTime = Date.now();
  const lang = req.lang || 'hu';
  const data = await getHouseExportData(req.params.houseId, lang);
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
  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
  logger.reportGenerated('json', req.params.houseId, Date.now() - startTime, meta).catch(() => {});
  res.json(exportData);
});

router.get('/export/:houseId/csv', async (req, res) => {
  const startTime = Date.now();
  const lang = req.lang || 'hu';
  const data = await getHouseExportData(req.params.houseId, lang);
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
  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
  logger.reportGenerated('csv', req.params.houseId, Date.now() - startTime, meta).catch(() => {});
  res.send('\uFEFF' + rows.join('\r\n'));
});

router.get('/export/:houseId/pdf', expensiveApiLimiter, async (req, res) => {
  const startTime = Date.now();
  const lang = req.lang || 'hu';
  const data = await getHouseExportData(req.params.houseId, lang);
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
  const db2 = await getDb();
  try {
    const aiReports = await db2.prepare(
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
        try { sections = JSON.parse(report.report_text).sections || []; } catch (e) { console.error('[PDF] Failed to parse AI report sections:', e.message); }
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
    await db2.close();
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

  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
  logger.reportGenerated('pdf', req.params.houseId, Date.now() - startTime, meta).catch(() => {});
  doc.end();
});

// --- Energy Calculation PDF Export ---

router.get('/export/energy/:calcId/pdf', expensiveApiLimiter, async (req, res) => {
  const startTime = Date.now();
  const lang = req.lang || 'hu';
  const db = await getDb();
  let calc;
  try {
    calc = await db.prepare('SELECT * FROM energy_calculations WHERE id = ?').get(req.params.calcId);
  } finally {
    await db.close();
  }
  if (!calc) return res.status(404).json({ error: 'Calculation not found' });

  let params, results;
  try {
    params = JSON.parse(calc.parameters);
    results = JSON.parse(calc.results);
  } catch (_e) {
    return res.status(500).json({ error: 'Invalid calculation data' });
  }

  // Resolve house name if linked
  let houseName = null;
  if (calc.house_id) {
    const db2 = await getDb();
    try {
      const house = await db2.prepare('SELECT name FROM houses WHERE id = ?').get(calc.house_id);
      if (house) houseName = house.name;
    } finally {
      await db2.close();
    }
  }

  const mainFontPath = path.join(__dirname, '../../fonts/NotoSans-Regular.ttf');
  const boldFontPath = path.join(__dirname, '../../fonts/NotoSans-Bold.ttf');
  const mainFont = fs.existsSync(mainFontPath) ? mainFontPath : undefined;
  const boldFont = fs.existsSync(boldFontPath) ? boldFontPath : undefined;

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const filename = (calc.name || 'energy').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}_energy_report.pdf"`);
  doc.pipe(res);

  if (mainFont) doc.registerFont('main', mainFont);
  if (boldFont) doc.registerFont('bold', boldFont);
  const fMain = mainFont ? 'main' : 'Helvetica';
  const fBold = boldFont ? 'bold' : 'Helvetica-Bold';

  const pageWidth = 495;
  const accentColor = '#2563eb';
  const textColor = '#1e293b';
  const mutedColor = '#64748b';
  const successColor = '#16a34a';
  const warningColor = '#ea580c';

  const labels = lang === 'en' ? {
    title: 'Energy Consumption Report',
    generated: 'Generated',
    page: 'Page',
    property: 'Property',
    scenario: 'Scenario',
    params: 'Parameters',
    electricityPrice: 'Electricity Price',
    currency: 'Currency',
    dutyCycle: 'Default Duty Cycle',
    appliances: 'Appliances',
    name: 'Name',
    wattage: 'W',
    qty: 'Qty',
    duty: 'Duty%',
    hours: 'h/day',
    dailyKwh: 'Daily kWh',
    monthlyKwh: 'Monthly kWh',
    summary: 'Consumption Summary',
    dailyConsumption: 'Daily Consumption',
    monthlyConsumption: 'Monthly Consumption',
    yearlyConsumption: 'Yearly Consumption',
    monthlyCost: 'Monthly Cost',
    yearlyCost: 'Yearly Cost',
    aiAnalysis: 'AI Energy Analysis',
    noAi: 'No AI analysis available for this calculation.',
    created: 'Created',
    updated: 'Last Updated',
  } : {
    title: 'Energiafogyasztási Jelentés',
    generated: 'Generálva',
    page: 'Oldal',
    property: 'Ingatlan',
    scenario: 'Számítás',
    params: 'Paraméterek',
    electricityPrice: 'Áram ára',
    currency: 'Pénznem',
    dutyCycle: 'Alapértelmezett üzemidő',
    appliances: 'Készülékek',
    name: 'Név',
    wattage: 'W',
    qty: 'Db',
    duty: 'Üzem%',
    hours: 'h/nap',
    dailyKwh: 'Napi kWh',
    monthlyKwh: 'Havi kWh',
    summary: 'Fogyasztás összesítés',
    dailyConsumption: 'Napi fogyasztás',
    monthlyConsumption: 'Havi fogyasztás',
    yearlyConsumption: 'Éves fogyasztás',
    monthlyCost: 'Havi költség',
    yearlyCost: 'Éves költség',
    aiAnalysis: 'AI Energia Elemzés',
    noAi: 'Ehhez a számításhoz nem áll rendelkezésre AI elemzés.',
    created: 'Létrehozva',
    updated: 'Utolsó módosítás',
  };

  // --- TITLE PAGE ---
  doc.rect(0, 0, 612, 120).fill(accentColor);
  doc.fillColor('#ffffff').font(fBold).fontSize(28)
    .text(labels.title, 50, 40, { width: pageWidth, align: 'center' });
  doc.fontSize(12).font(fMain)
    .text(calc.name, 50, 78, { width: pageWidth, align: 'center' });

  let y = 140;

  // Property info
  if (houseName) {
    doc.fillColor(mutedColor).font(fMain).fontSize(10)
      .text(`${labels.property}: ${houseName}`, 50, y);
    y += 18;
  }
  doc.fillColor(mutedColor).font(fMain).fontSize(9)
    .text(`${labels.created}: ${new Date(calc.created_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU')}  |  ${labels.updated}: ${new Date(calc.updated_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU')}`, 50, y);
  y += 25;

  // --- SUMMARY CARDS ---
  doc.fillColor(textColor).font(fBold).fontSize(14).text(labels.summary, 50, y);
  y += 22;

  const cardWidth = (pageWidth - 20) / 3;
  const summaryCards = [
    { label: labels.dailyConsumption, value: `${(results.dailyKwh || 0).toFixed(2)} kWh`, color: accentColor },
    { label: labels.monthlyConsumption, value: `${(results.monthlyKwh || 0).toFixed(1)} kWh`, color: accentColor },
    { label: labels.yearlyConsumption, value: `${(results.yearlyKwh || 0).toFixed(0)} kWh`, color: accentColor },
  ];

  summaryCards.forEach((card, i) => {
    const cx = 50 + i * (cardWidth + 10);
    doc.roundedRect(cx, y, cardWidth, 55, 6).fill('#f1f5f9');
    doc.fillColor(card.color).font(fBold).fontSize(16)
      .text(card.value, cx + 8, y + 10, { width: cardWidth - 16, align: 'center' });
    doc.fillColor(mutedColor).font(fMain).fontSize(8)
      .text(card.label, cx + 8, y + 34, { width: cardWidth - 16, align: 'center' });
  });
  y += 70;

  // Cost cards
  const costCardWidth = (pageWidth - 10) / 2;
  const costCards = [
    { label: labels.monthlyCost, value: `${Math.round(results.monthlyCost || 0).toLocaleString()} ${params.currency || 'HUF'}`, color: warningColor },
    { label: labels.yearlyCost, value: `${Math.round(results.yearlyCost || 0).toLocaleString()} ${params.currency || 'HUF'}`, color: warningColor },
  ];
  costCards.forEach((card, i) => {
    const cx = 50 + i * (costCardWidth + 10);
    doc.roundedRect(cx, y, costCardWidth, 55, 6).fill('#fef3c7');
    doc.fillColor(card.color).font(fBold).fontSize(16)
      .text(card.value, cx + 8, y + 10, { width: costCardWidth - 16, align: 'center' });
    doc.fillColor(mutedColor).font(fMain).fontSize(8)
      .text(card.label, cx + 8, y + 34, { width: costCardWidth - 16, align: 'center' });
  });
  y += 70;

  // --- PARAMETERS ---
  doc.fillColor(textColor).font(fBold).fontSize(12).text(labels.params, 50, y);
  y += 18;
  doc.fillColor(textColor).font(fMain).fontSize(9)
    .text(`${labels.electricityPrice}: ${params.electricityPrice || 68} ${params.currency || 'HUF'}/kWh`, 50, y);
  y += 14;
  doc.text(`${labels.dutyCycle}: ${params.defaultDuty || 100}%`, 50, y);
  y += 22;

  // --- APPLIANCE TABLE ---
  const items = params.items || [];
  if (items.length > 0) {
    doc.fillColor(textColor).font(fBold).fontSize(12).text(labels.appliances, 50, y);
    y += 18;

    // Table header
    const cols = [
      { label: labels.name, width: 165, align: 'left' },
      { label: labels.wattage, width: 50, align: 'right' },
      { label: labels.qty, width: 35, align: 'right' },
      { label: labels.duty, width: 50, align: 'right' },
      { label: labels.hours, width: 50, align: 'right' },
      { label: labels.dailyKwh, width: 65, align: 'right' },
      { label: labels.monthlyKwh, width: 80, align: 'right' },
    ];

    doc.rect(50, y, pageWidth, 18).fill(accentColor);
    let hx = 50;
    cols.forEach(col => {
      doc.fillColor('#ffffff').font(fBold).fontSize(7.5)
        .text(col.label, hx + 3, y + 4, { width: col.width - 6, align: col.align });
      hx += col.width;
    });
    y += 18;

    // Table rows
    items.forEach((item, idx) => {
      if (y > 720) { doc.addPage(); y = 50; }
      const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
      doc.rect(50, y, pageWidth, 16).fill(bg);

      const dailyKwh = ((item.wattage || 0) * (item.qty || 1) * ((item.duty || 100) / 100) * (item.hours || 0)) / 1000;
      const monthlyKwh = dailyKwh * 30;

      const rowData = [
        item.name || '',
        String(item.wattage || 0),
        String(item.qty || 1),
        String(item.duty || 100),
        String(item.hours || 0),
        dailyKwh.toFixed(3),
        monthlyKwh.toFixed(2),
      ];

      let rx = 50;
      cols.forEach((col, ci) => {
        doc.fillColor(textColor).font(fMain).fontSize(7.5)
          .text(rowData[ci], rx + 3, y + 3, { width: col.width - 6, align: col.align });
        rx += col.width;
      });
      y += 16;
    });

    // Table total row
    const totalDaily = items.reduce((sum, item) => sum + ((item.wattage || 0) * (item.qty || 1) * ((item.duty || 100) / 100) * (item.hours || 0)) / 1000, 0);
    const totalMonthly = totalDaily * 30;
    doc.rect(50, y, pageWidth, 18).fill('#e2e8f0');
    doc.fillColor(textColor).font(fBold).fontSize(8)
      .text(lang === 'en' ? 'TOTAL' : 'ÖSSZESEN', 53, y + 4, { width: 165 });
    doc.text(totalDaily.toFixed(3), 50 + 165 + 50 + 35 + 50 + 50 + 3, y + 4, { width: 62, align: 'right' });
    doc.text(totalMonthly.toFixed(2), 50 + 165 + 50 + 35 + 50 + 50 + 65 + 3, y + 4, { width: 77, align: 'right' });
    y += 30;
  }

  // --- TOP CONSUMERS CHART (horizontal bars) ---
  if (items.length > 1) {
    if (y > 580) { doc.addPage(); y = 50; }
    doc.fillColor(textColor).font(fBold).fontSize(12)
      .text(lang === 'en' ? 'Top Energy Consumers' : 'Legnagyobb fogyasztók', 50, y);
    y += 20;

    const sorted = items.map(item => ({
      name: item.name || '?',
      monthlyKwh: ((item.wattage || 0) * (item.qty || 1) * ((item.duty || 100) / 100) * (item.hours || 0)) / 1000 * 30
    })).sort((a, b) => b.monthlyKwh - a.monthlyKwh).slice(0, 8);

    const maxKwh = sorted[0]?.monthlyKwh || 1;
    const barMaxWidth = 280;

    sorted.forEach(item => {
      if (y > 730) { doc.addPage(); y = 50; }
      const barWidth = Math.max(2, (item.monthlyKwh / maxKwh) * barMaxWidth);
      const barColor = item.monthlyKwh > maxKwh * 0.7 ? warningColor : item.monthlyKwh > maxKwh * 0.3 ? '#eab308' : successColor;

      doc.fillColor(textColor).font(fMain).fontSize(8)
        .text(item.name, 50, y + 1, { width: 150, lineBreak: false });
      doc.roundedRect(205, y, barWidth, 12, 3).fill(barColor);
      doc.fillColor(textColor).font(fBold).fontSize(7)
        .text(`${item.monthlyKwh.toFixed(1)} kWh/${lang === 'en' ? 'mo' : 'hó'}`, 210 + barWidth + 5, y + 2);
      y += 18;
    });
    y += 15;
  }

  // --- AI ANALYSIS ---
  if (calc.ai_analysis) {
    if (y > 500) { doc.addPage(); y = 50; }
    doc.rect(50, y, pageWidth, 24).fill(successColor);
    doc.fillColor('#ffffff').font(fBold).fontSize(13)
      .text(`🤖 ${labels.aiAnalysis}`, 58, y + 5, { width: pageWidth - 16 });
    y += 32;

    doc.fillColor(textColor).font(fMain).fontSize(9)
      .text(calc.ai_analysis, 50, y, { width: pageWidth, lineGap: 3 });
    y = doc.y + 20;
  }

  // --- Footer on all pages ---
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.fillColor('#e2e8f0').rect(50, 768, pageWidth, 0.5).fill();
    doc.fillColor(mutedColor).font(fMain).fontSize(7)
      .text(
        `${calc.name} | ${labels.generated}: ${new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU')} | ${labels.page} ${i + 1}/${pages.count}`,
        60, 775,
        { align: 'center', width: pageWidth }
      );
  }

  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
  logger.reportGenerated('energy_pdf', req.params.calcId, Date.now() - startTime, meta).catch(() => {});
  doc.end();
});

// --- AI / LLM Endpoints ---

router.get('/ai/config', async (req, res) => {
  const db = await getDb();
  try {
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const config = {};
    for (const r of rows) {
      config[r.key.replace('ai_', '')] = r.value;
    }
    res.json(config);
  } finally {
    await db.close();
  }
});

router.post('/ai/config', async (req, res) => {
  const db = await getDb();
  try {
    const { provider, endpoint, model, apiKey } = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    await db.transaction(async () => {
      if (provider) await upsert.run('ai_provider', provider);
      if (endpoint) await upsert.run('ai_endpoint', endpoint);
      if (model) await upsert.run('ai_model', model);
      if (apiKey !== undefined) await upsert.run('ai_api_key', apiKey);
    });
    res.json({ success: true });
  } finally {
    await db.close();
  }
});

// POST /api/ai/analyze/:houseId — Start async AI analysis
router.post('/ai/analyze/:houseId', async (req, res) => {
  const startTime = Date.now();
  const lang = req.lang || 'hu';
  const data = await getHouseExportData(req.params.houseId, lang);
  if (!data) return res.status(404).json({ error: 'House not found' });

  const config = await getAIConfig();
  if (!config.provider || !config.endpoint) {
    return res.status(400).json({ error: lang === 'en' ? 'AI not configured. Please set up AI provider in settings.' : 'Az AI nincs konfigur\u00e1lva. K\u00e9rlek \u00e1ll\u00edtsd be az AI szolg\u00e1ltat\u00f3t a be\u00e1ll\u00edt\u00e1sokban.' });
  }

  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };

  // Start async generation — don't await, return immediately.
  // Timing: startTime is before generation, .then() fires after completion so duration is accurate.
  generateReport(req.params.houseId, data, lang).then(() => {
    logger.reportGenerated('ai_analysis', req.params.houseId, Date.now() - startTime, meta).catch(() => {});
  }).catch(err => {
    console.error('[AI] Report generation failed:', err.message);
    logger.error('report', 'ai_analysis_failed', { houseId: req.params.houseId, error: err.message }, meta).catch(() => {});
  });

  res.json({
    success: true,
    message: lang === 'en' ? 'AI analysis started. You will be notified when complete.' : 'AI elemz\u00e9s elindult. \u00c9rtes\u00edt\u00e9st kapsz, ha k\u00e9sz.',
    config: { provider: config.provider, model: config.model }
  });
});

// GET /api/ai/reports/:houseId — List all AI reports for a house
router.get('/ai/reports/:houseId', async (req, res) => {
  const db = await getDb();
  try {
    const reports = await db.prepare(
      'SELECT id, status, lang, summary, created_at, completed_at FROM ai_reports WHERE house_id = ? ORDER BY created_at DESC'
    ).all(req.params.houseId);
    res.json(reports);
  } finally {
    await db.close();
  }
});

// GET /api/ai/report/:reportId — Get full AI report
router.get('/ai/report/:reportId', async (req, res) => {
  const db = await getDb();
  try {
    const report = await db.prepare('SELECT * FROM ai_reports WHERE id = ?').get(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    let sections = [];
    try { sections = JSON.parse(report.report_text).sections || []; } catch (e) { console.error('[AI] Failed to parse report sections:', e.message); }

    res.json({
      ...report,
      sections
    });
  } finally {
    await db.close();
  }
});

// POST /api/ai/analyze-image — Analyze image and cache description
router.post('/ai/analyze-image', expensiveApiLimiter, async (req, res) => {
  const { imagePath, answerId } = req.body;
  if (!imagePath) return res.status(400).json({ error: 'imagePath required' });

  const config = await getAIConfig();
  if (!config.provider || !config.endpoint) {
    return res.status(400).json({ error: 'AI not configured' });
  }

  try {
    const description = await analyzeImage(imagePath, config, req.lang || 'hu');
    if (!description) {
      return res.status(500).json({ error: 'Image analysis failed or model does not support vision' });
    }

    // Update answer image_description if answerId provided
    if (answerId) {
      const db = await getDb();
      try {
        await db.prepare('UPDATE answers SET image_description = ? WHERE id = ?').run(description, answerId);
      } finally {
        await db.close();
      }
    }

    res.json({ success: true, description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/answers/:answerId/description — Update image description (manual edit)
router.put('/answers/:answerId/description', async (req, res) => {
  const { description } = req.body;
  const db = await getDb();
  try {
    const answer = await db.prepare('SELECT id, image_path FROM answers WHERE id = ?').get(req.params.answerId);
    if (!answer) return res.status(404).json({ error: 'Answer not found' });

    await db.prepare('UPDATE answers SET image_description = ? WHERE id = ?').run(description || null, answer.id);

    // Also update cache if image exists
    if (answer.image_path && description) {
      const hash = computeImageHash(answer.image_path);
      if (hash) {
        await db.prepare(
          'INSERT OR REPLACE INTO image_descriptions (id, image_hash, image_path, description) VALUES (?, ?, ?, ?)'
        ).run(crypto.randomUUID(), hash, answer.image_path, description);
      }
    }

    res.json({ success: true });
  } finally {
    await db.close();
  }
});

// --- General API ---

router.get('/houses', async (req, res) => {
  const db = await getDb();
  try {
    const lang = req.lang || 'hu';
    const houses = await db.prepare('SELECT * FROM houses ORDER BY created_at DESC').all();
    const result = await Promise.all(houses.map(async house => {
      const answers = await db.prepare('SELECT * FROM answers WHERE house_id = ?').all(house.id);
      const answeredCount = answers.filter(a => a.option_id).length;
      const totalQuestions = getAllQuestions(lang).length;
      const { overallScore } = calculateScore(answers, lang);
      const progress = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;
      return { ...house, overallScore, progress, answeredCount, totalQuestions };
    }));
    res.json(result);
  } finally {
    await db.close();
  }
});

router.get('/houses/:id', async (req, res) => {
  const lang = req.lang || 'hu';
  const data = await getHouseExportData(req.params.id, lang);
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
