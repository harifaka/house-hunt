const crypto = require('crypto');
const { getDb } = require('./database');
const { publicUrlFor } = require('./image-service');

/**
 * Call the configured LLM endpoint with a prompt.
 * Supports OpenAI-compatible APIs (OpenAI, Ollama, LM Studio, etc.)
 */
async function callLLM(prompt, config) {
  const endpoint = (config.endpoint || '').replace(/\/+$/, '');
  const url = endpoint + '/v1/chat/completions';

  const headers = { 'Content-Type': 'application/json' };
  if (config.api_key) {
    headers.Authorization = 'Bearer ' + config.api_key;
  }

  const body = {
    model: config.model || 'default',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 2048
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  throw new Error('Unexpected LLM response format');
}

/**
 * Get the AI configuration from settings.
 */
async function getAIConfig() {
  const db = await getDb();
  try {
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const config = {};
    for (const r of rows) config[r.key.replace('ai_', '')] = r.value;
    return config;
  } finally {
    await db.close();
  }
}

/**
 * Download the bytes for a stored image. Images live in Cloudflare R2, so the
 * value stored on the answer (a public URL or key) is resolved and fetched
 * over HTTP instead of being read from the local filesystem.
 */
async function fetchImageBuffer(imagePath) {
  const url = publicUrlFor(imagePath);
  if (!url) return null;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: (response.headers.get('content-type') || '').split(';')[0] || guessMimeType(url)
    };
  } catch {
    return null;
  }
}

function guessMimeType(url) {
  const pathname = url.split('?')[0].toLowerCase();
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

/**
 * Compute SHA-256 hash of a stored image for caching AI descriptions.
 */
async function computeImageHash(imagePath) {
  const image = await fetchImageBuffer(imagePath);
  if (!image) return null;
  return crypto.createHash('sha256').update(image.buffer).digest('hex');
}

/**
 * Analyze an image using the LLM (vision-capable models).
 * Caches result by image hash.
 */
async function analyzeImage(imagePath, config, lang) {
  const image = await fetchImageBuffer(imagePath);
  if (!image) return null;

  const hash = crypto.createHash('sha256').update(image.buffer).digest('hex');

  // Check cache
  const db = await getDb();
  try {
    const cached = await db.prepare('SELECT description FROM image_descriptions WHERE image_hash = ?').get(hash);
    if (cached) return cached.description;
  } finally {
    await db.close();
  }

  const base64Image = image.buffer.toString('base64');
  const mimeType = image.contentType || 'image/jpeg';

  const endpoint = (config.endpoint || '').replace(/\/+$/, '');
  const url = endpoint + '/v1/chat/completions';

  const headers = { 'Content-Type': 'application/json' };
  if (config.api_key) {
    headers.Authorization = 'Bearer ' + config.api_key;
  }

  const body = {
    model: config.model || 'default',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: (lang === 'en' ? 'Answer in English.' : 'Válaszolj magyarul.') + ' Describe what you see in this house inspection image. Focus on the condition of the property, any visible issues, materials, and overall state. Be concise but thorough.' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
      ]
    }],
    max_tokens: 512
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) return null;

    const data = await response.json();
    const description = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (description) {
      // Cache the result
      const db2 = await getDb();
      try {
        await db2.prepare(
          'INSERT OR REPLACE INTO image_descriptions (id, image_hash, image_path, description) VALUES (?, ?, ?, ?)'
        ).run(crypto.randomUUID(), hash, imagePath, description);
      } finally {
        await db2.close();
      }
    }

    return description;
  } catch {
    return null;
  }
}

/**
 * Build a section prompt for the AI report.
 */
function buildSectionPrompt(section, houseData, lang) {
  const langInstr = lang === 'en'
    ? 'Answer in English.'
    : 'Válaszolj magyarul.';

  const houseInfo = `Property: ${houseData.house.name}` +
    (houseData.house.address ? `, Address: ${houseData.house.address}` : '') +
    (houseData.house.asking_price ? `, Asking price: ${Number(houseData.house.asking_price).toLocaleString()} Ft` : '') +
    (houseData.house.notes ? `\nNotes: ${houseData.house.notes}` : '');

  const answers = section.questions.map(q => {
    const parts = [];
    if (q.selectedOption) {
      parts.push(`${q.text}: ${q.selectedOption.text} (score: ${q.selectedOption.score}/10, impact: ${q.selectedOption.impact || 'neutral'})`);
      if (q.selectedOption.estimatedCost) parts.push(`  Estimated cost: ${q.selectedOption.estimatedCost}`);
    } else {
      parts.push(`${q.text}: Not answered`);
    }
    if (q.answer && q.answer.notes) parts.push(`  Notes: ${q.answer.notes}`);
    if (q.answer && q.answer.image_description) parts.push(`  Image observation: ${q.answer.image_description}`);
    return parts.join('\n');
  }).join('\n');

  return `${langInstr}

You are a professional house inspector writing a report section about "${section.name}" for a property inspection report.

${houseInfo}

Section: ${section.name} (Score: ${section.score}%)
Inspection findings:
${answers}

Write a professional, flowing narrative paragraph about this section's findings. Do NOT use bullet points, question numbers, or Q&A format. Write it as if you are describing the property in a book — natural, readable prose that a buyer would find easy to understand. Include specific findings, condition assessments, and any cost implications where relevant.`;
}

/**
 * Build a summary prompt from all section reports.
 */
function buildSummaryPrompt(sectionReports, houseData, lang) {
  const langInstr = lang === 'en'
    ? 'Answer in English.'
    : 'Válaszolj magyarul.';

  const houseInfo = `Property: ${houseData.house.name}` +
    (houseData.house.address ? `, Address: ${houseData.house.address}` : '') +
    (houseData.house.asking_price ? `, Asking price: ${Number(houseData.house.asking_price).toLocaleString()} Ft` : '');

  const sectionsText = sectionReports.map(r =>
    `--- ${r.section_name} ---\n${r.report_text}`
  ).join('\n\n');

  return `${langInstr}

You are a professional house inspector writing an executive summary for a property inspection report.

${houseInfo}
Overall Score: ${houseData.overallScore}%

The following section reports have been written:

${sectionsText}

Write a comprehensive executive summary that synthesizes all the section findings into a cohesive overview. Include:
- Overall property condition assessment
- Key strengths and concerns
- Major cost items if any
- A clear buy/don't-buy recommendation with reasoning

Write in natural, flowing prose — like a professional report summary. No bullet points or numbered lists.`;
}

/**
 * Run async AI report generation for a house.
 * Generates section-by-section, then a summary.
 * Stores results in ai_reports table (old reports preserved).
 */
async function generateReport(houseId, houseData, lang) {
  const config = await getAIConfig();
  const reportId = crypto.randomUUID();

  // Create initial pending report
  const db = await getDb();
  try {
    const inputSnapshot = JSON.stringify({
      overallScore: houseData.overallScore,
      groups: houseData.groups.map(g => ({
        name: g.name,
        score: g.score,
        answered: g.answered,
        total: g.total,
        questions: g.questions.map(q => ({
          text: q.text,
          answer: q.selectedOption ? q.selectedOption.text : null,
          score: q.selectedOption ? q.selectedOption.score : null,
          notes: q.answer ? q.answer.notes : null,
          imageDescription: q.answer ? q.answer.image_description : null
        }))
      }))
    });

    await db.prepare(
      'INSERT INTO ai_reports (id, house_id, status, lang, input_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(reportId, houseId, 'generating', lang, inputSnapshot, new Date().toISOString());
  } finally {
    await db.close();
  }

  try {
    // Generate section reports
    const sectionReports = [];
    for (const group of houseData.groups) {
      if (group.answered === 0) continue;

      const prompt = buildSectionPrompt(group, houseData, lang);
      const text = await callLLM(prompt, config);

      sectionReports.push({
        section_name: group.name,
        report_text: text,
        score: group.score
      });
    }

    // Generate summary from all sections
    let summary = '';
    if (sectionReports.length > 0) {
      const summaryPrompt = buildSummaryPrompt(sectionReports, houseData, lang);
      summary = await callLLM(summaryPrompt, config);
    }

    // Save completed report
    const db2 = await getDb();
    try {
      const reportData = JSON.stringify({ sections: sectionReports });
      await db2.prepare(
        'UPDATE ai_reports SET status = ?, report_text = ?, summary = ?, completed_at = ? WHERE id = ?'
      ).run('completed', reportData, summary, new Date().toISOString(), reportId);
    } finally {
      await db2.close();
    }

    return { id: reportId, status: 'completed' };
  } catch (err) {
    // Mark as failed
    const db3 = await getDb();
    try {
      await db3.prepare(
        'UPDATE ai_reports SET status = ?, report_text = ?, completed_at = ? WHERE id = ?'
      ).run('failed', err.message, new Date().toISOString(), reportId);
    } finally {
      await db3.close();
    }

    return { id: reportId, status: 'failed', error: err.message };
  }
}

module.exports = {
  callLLM,
  getAIConfig,
  computeImageHash,
  analyzeImage,
  generateReport,
  buildSectionPrompt,
  buildSummaryPrompt
};
