const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const { getDb } = require('../database');
const { scrapeProperty, searchCity, calculatePriceStats } = require('../scraper');

// Price classification thresholds (HUF)
const PRICE_PREMIUM_THRESHOLD = 50000000;
const PRICE_MIDRANGE_THRESHOLD = 25000000;

// GET /property-finder — Main page
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const properties = db.prepare('SELECT * FROM scraped_properties ORDER BY created_at DESC').all();
    const reports = db.prepare('SELECT * FROM property_reports ORDER BY created_at DESC').all();
    const cities = db.prepare('SELECT * FROM city_info ORDER BY city_name ASC').all();

    res.render('property-finder', {
      pageTitle: res.locals.t.property_finder || 'Property Finder',
      currentPath: '/property-finder',
      properties,
      reports,
      cities,
    });
  } finally {
    db.close();
  }
});

// GET /property-finder/property/:id — View single scraped property
router.get('/property/:id', (req, res) => {
  const db = getDb();
  try {
    const property = db.prepare('SELECT * FROM scraped_properties WHERE id = ?').get(req.params.id);
    if (!property) return res.redirect('/property-finder');

    // Parse JSON fields
    property.imageUrls = safeJsonParse(property.image_urls, []);
    property.scrapedData = safeJsonParse(property.scraped_data, {});
    property.llmAnalysis = safeJsonParse(property.llm_analysis, null);

    // Get city info if available
    let cityInfo = null;
    if (property.city) {
      cityInfo = db.prepare('SELECT * FROM city_info WHERE city_name = ?').get(property.city);
      if (cityInfo) {
        cityInfo.extraData = safeJsonParse(cityInfo.extra_data, {});
      }
    }

    res.render('property-detail', {
      pageTitle: property.title || 'Property Detail',
      currentPath: '/property-finder',
      property,
      cityInfo,
    });
  } finally {
    db.close();
  }
});

// GET /property-finder/report/:id — View report
router.get('/report/:id', (req, res) => {
  const db = getDb();
  try {
    const report = db.prepare('SELECT * FROM property_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.redirect('/property-finder');

    const propertyIds = safeJsonParse(report.property_ids, []);
    const properties = propertyIds.length > 0
      ? db.prepare(`SELECT * FROM scraped_properties WHERE id IN (${propertyIds.map(() => '?').join(',')})`).all(...propertyIds)
      : [];

    // Parse JSON fields for each property
    properties.forEach(p => {
      p.imageUrls = safeJsonParse(p.image_urls, []);
      p.scrapedData = safeJsonParse(p.scraped_data, {});
      p.llmAnalysis = safeJsonParse(p.llm_analysis, null);
    });

    let cityInfo = null;
    if (report.city_info_id) {
      cityInfo = db.prepare('SELECT * FROM city_info WHERE id = ?').get(report.city_info_id);
      if (cityInfo) cityInfo.extraData = safeJsonParse(cityInfo.extra_data, {});
    }

    const reportData = safeJsonParse(report.report_data, {});

    res.render('property-report', {
      pageTitle: report.title || 'Property Report',
      currentPath: '/property-finder',
      report,
      reportData,
      properties,
      cityInfo,
    });
  } finally {
    db.close();
  }
});

// POST /property-finder/scrape — Scrape a single property URL
router.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('ingatlan.com')) {
    return res.status(400).json({ error: 'Please provide a valid ingatlan.com URL' });
  }

  const db = getDb();
  try {
    // Check if already scraped
    const existing = db.prepare('SELECT * FROM scraped_properties WHERE url = ?').get(url);
    if (existing) {
      return res.json({ success: true, property: existing, cached: true });
    }

    const data = await scrapeProperty(url);
    const id = uuidv4();

    db.prepare(`INSERT INTO scraped_properties (id, url, title, price, price_text, location, city, size_sqm, rooms, description, property_type, listing_id, image_urls, scraped_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, data.url, data.title, data.price, data.priceText,
      data.location, data.city, data.sizeSqm, data.rooms,
      data.description, data.propertyType, data.listingId,
      JSON.stringify(data.imageUrls),
      JSON.stringify({ parameters: data.parameters, structuredData: data.structuredData })
    );

    const property = db.prepare('SELECT * FROM scraped_properties WHERE id = ?').get(id);
    res.json({ success: true, property, cached: false });
  } catch (err) {
    console.error('Scrape error:', err);
    res.status(500).json({ error: 'Failed to scrape property: ' + err.message });
  } finally {
    db.close();
  }
});

// POST /property-finder/scrape-demo — Demo scrape with sample data (for testing without network)
router.post('/scrape-demo', (req, res) => {
  const { url } = req.body;
  const db = getDb();
  try {
    const id = uuidv4();
    const listingId = url ? url.split('/').filter(Boolean).pop() : 'demo-' + Date.now();

    // Generate realistic demo data
    const demoData = generateDemoProperty(url || 'https://ingatlan.com/demo/' + listingId, listingId);

    db.prepare(`INSERT OR REPLACE INTO scraped_properties (id, url, title, price, price_text, location, city, size_sqm, rooms, description, property_type, listing_id, image_urls, scraped_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, demoData.url, demoData.title, demoData.price, demoData.priceText,
      demoData.location, demoData.city, demoData.sizeSqm, demoData.rooms,
      demoData.description, demoData.propertyType, listingId,
      JSON.stringify(demoData.imageUrls),
      JSON.stringify(demoData.scrapedData)
    );

    const property = db.prepare('SELECT * FROM scraped_properties WHERE id = ?').get(id);
    res.json({ success: true, property, cached: false, demo: true });
  } finally {
    db.close();
  }
});

// POST /property-finder/search-city — Search for all properties in a city
router.post('/search-city', async (req, res) => {
  const { city, maxPages } = req.body;
  if (!city) {
    return res.status(400).json({ error: 'Please provide a city name' });
  }

  try {
    const results = await searchCity(city, parseInt(maxPages) || 1);
    const prices = results.map(r => r.price).filter(Boolean);
    const stats = calculatePriceStats(prices);

    // Store/update city info
    const db = getDb();
    try {
      const existingCity = db.prepare('SELECT * FROM city_info WHERE city_name = ?').get(city);
      if (existingCity) {
        db.prepare(`UPDATE city_info SET avg_price = ?, median_price = ?, updated_at = datetime('now') WHERE city_name = ?`)
          .run(stats.avg, stats.median, city);
      } else {
        db.prepare(`INSERT INTO city_info (id, city_name, avg_price, median_price) VALUES (?, ?, ?, ?)`)
          .run(uuidv4(), city, stats.avg, stats.median);
      }
    } finally {
      db.close();
    }

    res.json({ success: true, city, results, stats });
  } catch (err) {
    console.error('City search error:', err);
    res.status(500).json({ error: 'Failed to search city: ' + err.message });
  }
});

// POST /property-finder/search-city-demo — Demo city search
router.post('/search-city-demo', (req, res) => {
  const { city } = req.body;
  if (!city) {
    return res.status(400).json({ error: 'Please provide a city name' });
  }

  const results = generateDemoCityListings(city);
  const prices = results.map(r => r.price).filter(Boolean);
  const stats = calculatePriceStats(prices);

  // Store city info
  const db = getDb();
  try {
    const existingCity = db.prepare('SELECT * FROM city_info WHERE city_name = ?').get(city);
    const cityData = generateDemoCityInfo(city);

    if (existingCity) {
      db.prepare(`UPDATE city_info SET population = ?, gdp_info = ?, security_info = ?, infrastructure = ?, current_mayor = ?, previous_mayor = ?, general_info = ?, extra_data = ?, avg_price = ?, median_price = ?, updated_at = datetime('now') WHERE city_name = ?`)
        .run(cityData.population, cityData.gdpInfo, cityData.securityInfo, cityData.infrastructure, cityData.currentMayor, cityData.previousMayor, cityData.generalInfo, JSON.stringify(cityData.extraData), stats.avg, stats.median, city);
    } else {
      db.prepare(`INSERT INTO city_info (id, city_name, population, gdp_info, security_info, infrastructure, current_mayor, previous_mayor, general_info, extra_data, avg_price, median_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uuidv4(), city, cityData.population, cityData.gdpInfo, cityData.securityInfo, cityData.infrastructure, cityData.currentMayor, cityData.previousMayor, cityData.generalInfo, JSON.stringify(cityData.extraData), stats.avg, stats.median);
    }
  } finally {
    db.close();
  }

  res.json({ success: true, city, results, stats, cityInfo: generateDemoCityInfo(city), demo: true });
});

// POST /property-finder/city-info — Save/update city info
router.post('/city-info', (req, res) => {
  const db = getDb();
  try {
    const { city_name, population, gdp_info, security_info, infrastructure, current_mayor, previous_mayor, general_info } = req.body;
    if (!city_name) return res.status(400).json({ error: 'City name required' });

    const existing = db.prepare('SELECT * FROM city_info WHERE city_name = ?').get(city_name);
    if (existing) {
      db.prepare(`UPDATE city_info SET population = ?, gdp_info = ?, security_info = ?, infrastructure = ?, current_mayor = ?, previous_mayor = ?, general_info = ?, updated_at = datetime('now') WHERE city_name = ?`)
        .run(population || null, gdp_info || null, security_info || null, infrastructure || null, current_mayor || null, previous_mayor || null, general_info || null, city_name);
    } else {
      db.prepare(`INSERT INTO city_info (id, city_name, population, gdp_info, security_info, infrastructure, current_mayor, previous_mayor, general_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uuidv4(), city_name, population || null, gdp_info || null, security_info || null, infrastructure || null, current_mayor || null, previous_mayor || null, general_info || null);
    }

    res.json({ success: true });
  } finally {
    db.close();
  }
});

// POST /property-finder/analyze — LLM analysis of a scraped property
router.post('/analyze/:id', async (req, res) => {
  const db = getDb();
  try {
    const property = db.prepare('SELECT * FROM scraped_properties WHERE id = ?').get(req.params.id);
    if (!property) return res.status(404).json({ error: 'Property not found' });

    // Check AI config
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const config = {};
    for (const r of rows) config[r.key.replace('ai_', '')] = r.value;

    const imageUrls = safeJsonParse(property.image_urls, []);
    const scrapedData = safeJsonParse(property.scraped_data, {});

    // Build analysis prompt
    const prompt = buildAnalysisPrompt(property, imageUrls, scrapedData, req.lang || 'hu');

    let analysis;
    if (config.provider && config.endpoint && config.api_key) {
      // Call real LLM
      try {
        analysis = await callLLM(config, prompt, imageUrls);
      } catch (err) {
        console.error('LLM call failed:', err);
        analysis = generateDemoAnalysis(property, req.lang || 'hu');
        analysis._note = 'LLM call failed, showing demo analysis. Error: ' + err.message;
      }
    } else {
      // Generate demo analysis
      analysis = generateDemoAnalysis(property, req.lang || 'hu');
    }

    // Store analysis
    db.prepare(`UPDATE scraped_properties SET llm_analysis = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(analysis), req.params.id);

    res.json({ success: true, analysis });
  } finally {
    db.close();
  }
});

// POST /property-finder/report — Create a comparison report
router.post('/report', (req, res) => {
  const { title, propertyIds, city } = req.body;
  if (!propertyIds || !Array.isArray(propertyIds) || propertyIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one property' });
  }

  const db = getDb();
  try {
    const id = uuidv4();
    const properties = propertyIds.length > 0
      ? db.prepare(`SELECT * FROM scraped_properties WHERE id IN (${propertyIds.map(() => '?').join(',')})`).all(...propertyIds)
      : [];

    const prices = properties.map(p => p.price).filter(Boolean);
    const stats = calculatePriceStats(prices);

    let cityInfoId = null;
    const cityName = city || properties[0]?.city;
    if (cityName) {
      const ci = db.prepare('SELECT * FROM city_info WHERE city_name = ?').get(cityName);
      if (ci) cityInfoId = ci.id;
    }

    const reportData = {
      priceStats: stats,
      propertyCount: properties.length,
      generatedAt: new Date().toISOString(),
    };

    db.prepare(`INSERT INTO property_reports (id, title, city, property_ids, city_info_id, report_data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, title || 'Property Comparison Report', cityName || null, JSON.stringify(propertyIds), cityInfoId, JSON.stringify(reportData));

    res.json({ success: true, reportId: id });
  } finally {
    db.close();
  }
});

// GET /property-finder/report/:id/pdf — Download PDF report
router.get('/report/:id/pdf', (req, res) => {
  const db = getDb();
  try {
    const lang = req.lang || 'hu';
    const report = db.prepare('SELECT * FROM property_reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const propertyIds = safeJsonParse(report.property_ids, []);
    const properties = propertyIds.length > 0
      ? db.prepare(`SELECT * FROM scraped_properties WHERE id IN (${propertyIds.map(() => '?').join(',')})`).all(...propertyIds)
      : [];

    properties.forEach(p => {
      p.imageUrls = safeJsonParse(p.image_urls, []);
      p.llmAnalysis = safeJsonParse(p.llm_analysis, null);
    });

    let cityInfo = null;
    if (report.city_info_id) {
      cityInfo = db.prepare('SELECT * FROM city_info WHERE id = ?').get(report.city_info_id);
      if (cityInfo) cityInfo.extraData = safeJsonParse(cityInfo.extra_data, {});
    }

    const reportData = safeJsonParse(report.report_data, {});
    const labels = lang === 'en'
      ? { title: 'Property Comparison Report', city: 'City', price: 'Price', size: 'Size', rooms: 'Rooms', avg: 'Average Price', median: 'Median Price', analysis: 'Pre-Inspection Analysis', generated: 'Generated', location: 'Location', overview: 'Market Overview', properties: 'Properties', population: 'Population', security: 'Security', infrastructure: 'Infrastructure', mayor: 'Mayor', generalInfo: 'General Info' }
      : { title: 'Ingatlan összehasonlító jelentés', city: 'Város', price: 'Ár', size: 'Méret', rooms: 'Szobák', avg: 'Átlagár', median: 'Medián ár', analysis: 'Előzetes szemle elemzés', generated: 'Generálva', location: 'Helyszín', overview: 'Piaci áttekintés', properties: 'Ingatlanok', population: 'Lakosság', security: 'Biztonság', infrastructure: 'Infrastruktúra', mayor: 'Polgármester', generalInfo: 'Általános információ' };

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const filename = (report.title || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    // Title page
    doc.fontSize(28).text(labels.title, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(20).text(report.title, { align: 'center' });
    doc.moveDown(0.5);
    if (report.city) {
      doc.fontSize(14).text(`${labels.city}: ${report.city}`, { align: 'center' });
    }
    doc.moveDown(0.5);
    doc.fontSize(12).text(`${labels.generated}: ${new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'hu-HU')}`, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).text(`${labels.properties}: ${properties.length}`, { align: 'center' });

    // City info section
    if (cityInfo) {
      doc.addPage();
      doc.fontSize(20).text(`${report.city || cityInfo.city_name} — ${labels.overview}`, { underline: true });
      doc.moveDown(1);

      if (cityInfo.population) doc.fontSize(12).text(`${labels.population}: ${Number(cityInfo.population).toLocaleString()}`);
      if (cityInfo.gdp_info) doc.text(`GDP: ${cityInfo.gdp_info}`);
      if (cityInfo.security_info) doc.text(`${labels.security}: ${cityInfo.security_info}`);
      if (cityInfo.infrastructure) doc.text(`${labels.infrastructure}: ${cityInfo.infrastructure}`);
      if (cityInfo.current_mayor) doc.text(`${labels.mayor}: ${cityInfo.current_mayor}`);
      if (cityInfo.general_info) {
        doc.moveDown(0.5);
        doc.text(`${labels.generalInfo}: ${cityInfo.general_info}`);
      }

      doc.moveDown(1);
      if (reportData.priceStats) {
        doc.fontSize(14).text(labels.overview, { underline: true });
        doc.fontSize(12);
        doc.text(`${labels.avg}: ${Number(reportData.priceStats.avg || 0).toLocaleString()} Ft`);
        doc.text(`${labels.median}: ${Number(reportData.priceStats.median || 0).toLocaleString()} Ft`);
        doc.text(`Min: ${Number(reportData.priceStats.min || 0).toLocaleString()} Ft`);
        doc.text(`Max: ${Number(reportData.priceStats.max || 0).toLocaleString()} Ft`);
      }
    }

    // Property pages
    for (const prop of properties) {
      doc.addPage();
      doc.fontSize(18).text(prop.title || 'Property', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12);
      if (prop.price) doc.text(`${labels.price}: ${Number(prop.price).toLocaleString()} Ft`);
      if (prop.location) doc.text(`${labels.location}: ${prop.location}`);
      if (prop.size_sqm) doc.text(`${labels.size}: ${prop.size_sqm} m²`);
      if (prop.rooms) doc.text(`${labels.rooms}: ${prop.rooms}`);
      if (prop.description) {
        doc.moveDown(0.5);
        doc.fontSize(10).text(prop.description.substring(0, 500));
      }

      // LLM Analysis
      if (prop.llmAnalysis) {
        doc.moveDown(1);
        doc.fontSize(14).text(labels.analysis, { underline: true });
        doc.fontSize(10);
        if (prop.llmAnalysis.summary) doc.text(prop.llmAnalysis.summary);
        if (prop.llmAnalysis.condition) doc.text(`Condition: ${prop.llmAnalysis.condition}`);
        if (prop.llmAnalysis.estimatedValue) doc.text(`Estimated Value: ${prop.llmAnalysis.estimatedValue}`);
        if (prop.llmAnalysis.pros && prop.llmAnalysis.pros.length > 0) {
          doc.moveDown(0.3);
          doc.text('Pros:');
          prop.llmAnalysis.pros.forEach(p => doc.text(`  + ${p}`));
        }
        if (prop.llmAnalysis.cons && prop.llmAnalysis.cons.length > 0) {
          doc.moveDown(0.3);
          doc.text('Cons:');
          prop.llmAnalysis.cons.forEach(c => doc.text(`  - ${c}`));
        }
      }
    }

    // Footer
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).text(
        `House Hunt — ${report.title} — ${new Date().toISOString()}`,
        50, 780, { align: 'center', width: 495 }
      );
    }

    doc.end();
  } finally {
    db.close();
  }
});

// DELETE /property-finder/property/:id — Delete scraped property
router.post('/property/:id/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM scraped_properties WHERE id = ?').run(req.params.id);
    res.redirect('/property-finder');
  } finally {
    db.close();
  }
});

// DELETE /property-finder/report/:id — Delete report
router.post('/report/:id/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM property_reports WHERE id = ?').run(req.params.id);
    res.redirect('/property-finder');
  } finally {
    db.close();
  }
});


// --- Helpers ---

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function buildAnalysisPrompt(property, imageUrls, scrapedData, lang) {
  const langLabel = lang === 'en' ? 'English' : 'Hungarian';
  return `You are a professional house inspector. Analyze this property listing and provide a pre-inspection report in ${langLabel}.

Property: ${property.title}
Location: ${property.location || 'Unknown'}
Price: ${property.price_text || (property.price ? property.price + ' Ft' : 'Unknown')}
Size: ${property.size_sqm ? property.size_sqm + ' m²' : 'Unknown'}
Rooms: ${property.rooms || 'Unknown'}
Type: ${property.property_type || 'Unknown'}
Description: ${property.description || 'No description'}
Parameters: ${JSON.stringify(scrapedData.parameters || {})}

${imageUrls.length > 0 ? `The property has ${imageUrls.length} photos available.` : 'No photos available.'}

Please provide a JSON response with:
{
  "summary": "Brief overall assessment",
  "condition": "excellent/good/fair/poor",
  "estimatedValue": "estimated market value range",
  "priceAssessment": "overpriced/fair/underpriced with reasoning",
  "pros": ["list of advantages"],
  "cons": ["list of concerns/issues"],
  "inspectionPriorities": ["what to check first during physical inspection"],
  "renovationEstimate": "estimated renovation costs if needed",
  "investmentScore": 1-10,
  "recommendation": "buy/consider/avoid with reasoning"
}`;
}

async function callLLM(config, prompt, imageUrls) {
  const body = {
    model: config.model || 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a professional house inspector and real estate analyst. Always respond with valid JSON.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 2000,
    temperature: 0.3,
  };

  // Add images if provider supports vision
  if (imageUrls && imageUrls.length > 0 && (config.model || '').includes('vision')) {
    body.messages[1].content = [
      { type: 'text', text: prompt },
      ...imageUrls.slice(0, 4).map(url => ({ type: 'image_url', image_url: { url } }))
    ];
  }

  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.api_key}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`LLM API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';

  try {
    return JSON.parse(content);
  } catch {
    return { summary: content, condition: 'unknown', pros: [], cons: [] };
  }
}

function generateDemoAnalysis(property, lang) {
  const isEn = lang === 'en';
  const priceLevel = property.price > PRICE_PREMIUM_THRESHOLD ? 'premium' : property.price > PRICE_MIDRANGE_THRESHOLD ? 'mid-range' : 'affordable';

  return {
    summary: isEn
      ? `This ${property.property_type || 'property'} in ${property.location || 'the listed location'} appears to be a ${priceLevel} listing. Based on the available information, the property shows typical characteristics for its price range. A physical inspection is recommended to verify the condition.`
      : `Ez az ${property.property_type || 'ingatlan'} ${property.location || 'a megadott helyen'} egy ${priceLevel === 'premium' ? 'prémium' : priceLevel === 'mid-range' ? 'közepes' : 'megfizethető'} kategóriás hirdetésnek tűnik. A rendelkezésre álló információk alapján az ingatlan az árkategóriájára jellemző tulajdonságokat mutatja. Személyes megtekintés javasolt az állapot ellenőrzéséhez.`,
    condition: 'fair',
    estimatedValue: property.price ? `${Math.round(property.price * 0.9).toLocaleString()} - ${Math.round(property.price * 1.1).toLocaleString()} Ft` : 'N/A',
    priceAssessment: isEn ? 'Fair price for the area based on available data' : 'A terület alapján megfelelő ár a rendelkezésre álló adatok alapján',
    pros: isEn
      ? ['Listed on reputable platform', `${property.size_sqm || 'Unknown'} m² living space`, `${property.rooms || 'Unknown'} rooms available`, 'Location appears accessible']
      : ['Megbízható platformon hirdetve', `${property.size_sqm || 'Ismeretlen'} m² lakótér`, `${property.rooms || 'Ismeretlen'} szoba elérhető`, 'A helyszín megközelíthetőnek tűnik'],
    cons: isEn
      ? ['Physical inspection needed', 'Structural condition unknown from listing', 'Utility costs not verified', 'Neighborhood noise levels unknown']
      : ['Személyes megtekintés szükséges', 'Szerkezeti állapot ismeretlen a hirdetésből', 'Rezsiköltségek nem ellenőrzöttek', 'Környék zajszintje ismeretlen'],
    inspectionPriorities: isEn
      ? ['Check roof condition and attic', 'Inspect foundation and walls for cracks', 'Test electrical system and plumbing', 'Check for moisture/mold in basement', 'Verify heating system efficiency']
      : ['Tető és padlástér ellenőrzése', 'Alap és falak repedésvizsgálata', 'Elektromos rendszer és vízvezeték tesztelése', 'Pince nedvesség/penész vizsgálata', 'Fűtési rendszer hatékonyságának ellenőrzése'],
    renovationEstimate: property.price ? `${Math.round(property.price * 0.05).toLocaleString()} - ${Math.round(property.price * 0.15).toLocaleString()} Ft` : 'N/A',
    investmentScore: 6,
    recommendation: isEn
      ? 'Consider — Schedule a physical inspection to verify the condition and negotiate based on findings.'
      : 'Megfontolandó — Egyeztessen személyes megtekintést az állapot ellenőrzéséhez és az eredmények alapján tárgyaljon.',
    _demo: true,
  };
}

function generateDemoProperty(url, listingId) {
  const cities = ['Budapest', 'Debrecen', 'Szeged', 'Pécs', 'Győr'];
  const streets = ['Fő utca', 'Kossuth Lajos utca', 'Petőfi Sándor utca', 'Rákóczi út', 'Széchenyi tér'];
  const city = cities[Math.floor(Math.random() * cities.length)];
  const street = streets[Math.floor(Math.random() * streets.length)];
  const num = Math.floor(Math.random() * 100) + 1;
  const price = (Math.floor(Math.random() * 80) + 15) * 1000000;
  const sqm = Math.floor(Math.random() * 150) + 50;
  const rooms = Math.floor(Math.random() * 5) + 1;

  return {
    url,
    title: `${rooms} szobás családi ház, ${city} — ${street} ${num}`,
    price,
    priceText: `${(price / 1000000).toFixed(1)} M Ft`,
    location: `${city}, ${street} ${num}.`,
    city,
    sizeSqm: sqm,
    rooms,
    description: `Eladó ${rooms} szobás, ${sqm} m² alapterületű családi ház ${city} városban, a ${street} ${num}. szám alatt. Az ingatlan jó állapotú, felújított, csendes környezetben található. Kert, garázs és pince tartozik hozzá.`,
    propertyType: 'Családi ház',
    imageUrls: [
      'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800',
      'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800',
      'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=800',
      'https://images.unsplash.com/photo-1576941089067-2de3c901e126?w=800',
      'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800',
      'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800',
    ],
    scrapedData: {
      parameters: {
        'Alapterület': `${sqm} m²`,
        'Szobák száma': `${rooms}`,
        'Építés éve': `${Math.floor(Math.random() * 40) + 1980}`,
        'Fűtés': 'Gáz (cirkó)',
        'Állapot': 'Felújított',
        'Energetikai besorolás': ['A+', 'A', 'B', 'C', 'D'][Math.floor(Math.random() * 5)],
        'Telek méret': `${sqm + Math.floor(Math.random() * 500)} m²`,
        'Emelet': 'Földszint',
        'Parkolás': 'Garázs',
        'Kilátás': 'Kertre néző',
      }
    }
  };
}

function generateDemoCityListings(city) {
  const results = [];
  const count = Math.floor(Math.random() * 8) + 5;
  for (let i = 0; i < count; i++) {
    const price = (Math.floor(Math.random() * 80) + 15) * 1000000;
    const sqm = Math.floor(Math.random() * 150) + 50;
    const rooms = Math.floor(Math.random() * 5) + 1;
    results.push({
      url: `https://ingatlan.com/demo/${city.toLowerCase()}-${i + 1}`,
      title: `${rooms} szobás ház, ${city} — ${sqm} m²`,
      priceText: `${(price / 1000000).toFixed(1)} M Ft`,
      price,
      location: `${city}, Demo utca ${i + 1}.`,
    });
  }
  return results;
}

function generateDemoCityInfo(city) {
  const cityData = {
    'Budapest': { population: 1752286, gdpInfo: 'GDP per capita: ~$42,000 (highest in Hungary)', securityInfo: 'Generally safe, some pickpocket risk in tourist areas. Police presence: Good.', infrastructure: 'Excellent public transport (Metro, BKK), hospitals, universities, international airport.', currentMayor: 'Karácsony Gergely (since 2019)', previousMayor: 'Tarlós István (2010-2019)', generalInfo: 'Capital city of Hungary. Cultural, economic, and political center. UNESCO World Heritage sites along the Danube.' },
    'Debrecen': { population: 201981, gdpInfo: 'GDP per capita: ~$18,000. Growing economic center.', securityInfo: 'Low crime rate. Safe residential areas.', infrastructure: 'University city, airport, modern tram system, hospitals.', currentMayor: 'Papp László (since 2014)', previousMayor: 'Kósa Lajos (2006-2014)', generalInfo: 'Second largest city in Hungary. Known for Debrecen University and the Reformed Great Church.' },
    'Szeged': { population: 160766, gdpInfo: 'GDP per capita: ~$16,000. University-driven economy.', securityInfo: 'Very safe city with low crime rates.', infrastructure: 'University of Szeged, tram network, close to Serbian border.', currentMayor: 'Botka László (since 2002)', previousMayor: 'Lippai Pál (1994-2002)', generalInfo: 'City of Sunshine. Known for paprika, salami, and the Szeged Open Air Festival.' },
    'Pécs': { population: 142873, gdpInfo: 'GDP per capita: ~$14,000. Cultural economy.', securityInfo: 'Safe city, moderate crime rate.', infrastructure: 'University city, cultural capital 2010, good road connections.', currentMayor: 'Péterffy Attila (since 2019)', previousMayor: 'Páva Zsolt (2009-2019)', generalInfo: 'European Capital of Culture 2010. Known for Zsolnay porcelain and early Christian necropolis.' },
    'Győr': { population: 132038, gdpInfo: 'GDP per capita: ~$25,000. Industrial center (Audi).', securityInfo: 'Very safe, low crime rate.', infrastructure: 'Audi factory, university, good highway connections to Vienna and Budapest.', currentMayor: 'Dézsi Csaba András (since 2019)', previousMayor: 'Borkai Zsolt (2006-2019)', generalInfo: 'One of the wealthiest cities in Hungary. Known for Audi factory, Baroque old town.' },
  };

  const defaultData = { population: Math.floor(Math.random() * 100000) + 20000, gdpInfo: 'Regional economic center', securityInfo: 'Moderate crime rate, generally safe residential areas.', infrastructure: 'Basic public services, schools, healthcare available.', currentMayor: 'Information pending', previousMayor: 'Information pending', generalInfo: `${city} is a Hungarian city with local cultural heritage and community.` };

  const data = cityData[city] || defaultData;
  return {
    ...data,
    extraData: {
      county: city === 'Budapest' ? 'Pest megye' : 'County information pending',
      nearestAirport: city === 'Budapest' ? 'Budapest Liszt Ferenc (BUD)' : 'Regional airport',
      averageTemperature: '10.5°C',
      educationFacilities: 'Universities, secondary schools available',
    }
  };
}

module.exports = router;
