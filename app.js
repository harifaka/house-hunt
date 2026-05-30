const express = require('express');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const { initDb, getDb } = require('./src/database');
const { logger } = require('./src/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database, then logger
const dbReady = initDb().then(() => {
  logger.init(getDb);
  // Run initial log cleanup, then schedule periodic cleanup (every 24h)
  logger.cleanup();
  setInterval(() => logger.cleanup(), 24 * 60 * 60 * 1000);
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(async (_req, _res, next) => {
  try {
    await dbReady;
    next();
  } catch (error) {
    next(error);
  }
});
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Language middleware
app.use((req, res, next) => {
  if (req.query.lang && ['hu', 'en'].includes(req.query.lang)) {
    req.session.lang = req.query.lang;
  }
  req.lang = req.session.lang || 'hu';
  res.locals.lang = req.lang;
  // Full URL path for language switcher (preserves quiz paths etc.)
  res.locals.currentUrl = req.path;
  res.locals.t = req.lang === 'en' ? {
    home: 'Home', quiz: 'Inspection Quiz', admin: 'Admin', houses: 'Houses',
    new_house: 'New House', score: 'Score', results: 'Results', save: 'Save',
    next: 'Next', prev: 'Previous', finish: 'Finish', cancel: 'Cancel',
    delete: 'Delete', edit: 'Edit', name: 'Name', address: 'Address',
    price: 'Asking Price (HUF)', notes: 'Notes', actions: 'Actions',
    start_quiz: 'Start Inspection', continue_quiz: 'Continue', view_results: 'View Results',
    no_houses: 'No houses added yet.', add_first: 'Add your first house to start inspecting.',
    question: 'Question', of: 'of', group: 'Group', weight: 'Weight',
    upload_image: 'Upload Image', overall_score: 'Overall Score',
    settings: 'Settings', language: 'Language', questions: 'Questions',
    back_to_houses: 'Back to Houses', progress: 'Progress',
    estimated_cost: 'Estimated Cost', impact: 'Impact',
    value_increasing: 'Value Increasing', value_decreasing: 'Value Decreasing',
    strong_value_decreasing: 'Strongly Decreasing', neutral: 'Neutral',
    app_title: 'House Hunt', tagline: 'Professional House Inspection Tool',
    select_option: 'Select an option', skip: 'Skip', answered: 'answered',
    not_started: 'Not started', completed: 'Completed', in_progress: 'In Progress',
    house_details: 'House Details', inspection_progress: 'Inspection Progress',
    category_scores: 'Category Scores', recommendation: 'Recommendation',
    good_condition: 'Good condition', needs_attention: 'Needs attention',
    critical_issues: 'Critical issues found', add_notes: 'Add notes...',
    excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor',
    created: 'Created', asking_price_label: 'Asking Price',
    confirm_delete: 'Are you sure you want to delete this house and all its inspection data?',
    energy_calculator: 'Energy Calculator', heating_calculator: 'Heating Calculator',
    calculators: 'Calculators', export: 'Export', ai_analysis: 'AI Analysis',
    wattage: 'Wattage', duty_cycle: 'Duty Cycle', daily_hours: 'Daily Hours',
    consumption: 'Consumption', cost: 'Cost',
    wall_type: 'Wall Type', insulation: 'Insulation', window: 'Window',
    door: 'Door', glass_layers: 'Glass Layers', heat_loss: 'Heat Loss',
    temperature: 'Temperature',
    download: 'Download', format: 'Format', preview: 'Preview',
    analyze: 'Analyze', provider: 'Provider', endpoint: 'Endpoint',
    model: 'Model', api_key: 'API Key',
    total: 'Total', monthly: 'Monthly', yearly: 'Yearly', daily: 'Daily',
    add_row: 'Add Row', remove_row: 'Remove Row',
    property_finder: 'Property Finder',
    save_scenario: 'Save Scenario', load_scenario: 'Load Scenario', copy_scenario: 'Copy Scenario',
    delete_scenario: 'Delete Scenario', new_scenario: 'New Scenario',
    link_to_house: 'Link to House', item_library: 'Item Library',
    add_from_library: 'Add from Library', save_to_library: 'Save to Library',
    ai_energy_analysis: 'AI Energy Analysis', generate_analysis: 'Generate Analysis',
    export_pdf: 'Export PDF', saved_calculations: 'Saved Calculations',
    energy_items: 'Energy Items', category: 'Category',
    scenario_name: 'Scenario Name', no_saved: 'No saved calculations yet'
  } : {
    home: 'Főoldal', quiz: 'Szemle kérdőív', admin: 'Admin', houses: 'Házak',
    new_house: 'Új ház', score: 'Pontszám', results: 'Eredmények', save: 'Mentés',
    next: 'Következő', prev: 'Előző', finish: 'Befejezés', cancel: 'Mégse',
    delete: 'Törlés', edit: 'Szerkesztés', name: 'Név', address: 'Cím',
    price: 'Kért ár (Ft)', notes: 'Megjegyzések', actions: 'Műveletek',
    start_quiz: 'Szemle indítása', continue_quiz: 'Folytatás', view_results: 'Eredmények',
    no_houses: 'Még nincs ház hozzáadva.', add_first: 'Add hozzá az első házat a szemle indításához.',
    question: 'Kérdés', of: '/', group: 'Csoport', weight: 'Súly',
    upload_image: 'Kép feltöltése', overall_score: 'Összesített pontszám',
    settings: 'Beállítások', language: 'Nyelv', questions: 'Kérdések',
    back_to_houses: 'Vissza a házakhoz', progress: 'Haladás',
    estimated_cost: 'Becsült költség', impact: 'Hatás',
    value_increasing: 'Értéknövelő', value_decreasing: 'Értékcsökkentő',
    strong_value_decreasing: 'Erősen csökkentő', neutral: 'Semleges',
    app_title: 'House Hunt', tagline: 'Professzionális ingatlan szemle eszköz',
    select_option: 'Válassz egy opciót', skip: 'Kihagyás', answered: 'megválaszolva',
    not_started: 'Nem kezdődött el', completed: 'Befejezve', in_progress: 'Folyamatban',
    house_details: 'Ház részletei', inspection_progress: 'Szemle haladás',
    category_scores: 'Kategória pontszámok', recommendation: 'Javaslat',
    good_condition: 'Jó állapot', needs_attention: 'Figyelmet igényel',
    critical_issues: 'Kritikus problémák', add_notes: 'Megjegyzés...',
    excellent: 'Kiváló', good: 'Jó', fair: 'Közepes', poor: 'Gyenge',
    created: 'Létrehozva', asking_price_label: 'Kért ár',
    confirm_delete: 'Biztosan törölni szeretnéd ezt a házat és az összes szemle adatot?',
    energy_calculator: 'Energia kalkulátor', heating_calculator: 'Fűtés kalkulátor',
    calculators: 'Kalkulátorok', export: 'Exportálás', ai_analysis: 'AI elemzés',
    wattage: 'Teljesítmény', duty_cycle: 'Üzemidő', daily_hours: 'Napi órák',
    consumption: 'Fogyasztás', cost: 'Költség',
    wall_type: 'Fal típusa', insulation: 'Szigetelés', window: 'Ablak',
    door: 'Ajtó', glass_layers: 'Üvegrétegek', heat_loss: 'Hőveszteség',
    temperature: 'Hőmérséklet',
    download: 'Letöltés', format: 'Formátum', preview: 'Előnézet',
    analyze: 'Elemzés', provider: 'Szolgáltató', endpoint: 'Végpont',
    model: 'Modell', api_key: 'API kulcs',
    total: 'Összesen', monthly: 'Havi', yearly: 'Éves', daily: 'Napi',
    add_row: 'Sor hozzáadása', remove_row: 'Sor törlése',
    property_finder: 'Ingatlan Kereső',
    save_scenario: 'Sablon mentése', load_scenario: 'Sablon betöltése', copy_scenario: 'Sablon másolása',
    delete_scenario: 'Sablon törlése', new_scenario: 'Új sablon',
    link_to_house: 'Házhoz rendelés', item_library: 'Eszköztár',
    add_from_library: 'Hozzáadás eszköztárból', save_to_library: 'Mentés eszköztárba',
    ai_energy_analysis: 'AI Energia Elemzés', generate_analysis: 'Elemzés generálása',
    export_pdf: 'PDF Exportálás', saved_calculations: 'Mentett számítások',
    energy_items: 'Energia tételek', category: 'Kategória',
    scenario_name: 'Sablon neve', no_saved: 'Még nincs mentett számítás'
  };

  // Cookie consent flag (read from cookie, not session — to work before consent)
  res.locals.cookieConsent = req.headers.cookie && req.headers.cookie.includes('cookie_consent=accepted');

  next();
});

// Request logging middleware (non-blocking, fire-and-forget)
app.use((req, res, next) => {
  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
  // Skip static assets and favicon from logging
  if (!req.path.startsWith('/css/') && !req.path.startsWith('/js/') && !req.path.startsWith('/favicon') && !req.path.startsWith('/uploads/')) {
    logger.pageView(req.path, meta).catch(() => {});
  }
  next();
});

// Legal pages
app.use('/legal', require('./src/routes/legal'));

// Routes
app.use('/', require('./src/routes/home'));
app.use('/quiz', require('./src/routes/quiz'));
app.use('/admin', require('./src/routes/admin'));
app.use('/api', require('./src/routes/api'));
app.use('/calculators', require('./src/routes/calculators'));
app.use('/property-finder', require('./src/routes/property-finder'));

// Convenience routes that delegate to admin router handlers
app.get('/export', (req, res, next) => {
  req.url = '/export';
  require('./src/routes/admin').handle(req, res, next);
});
app.get('/ai', (req, res, next) => {
  req.url = '/ai-analysis';
  require('./src/routes/admin').handle(req, res, next);
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    pageTitle: '404 — Not Found',
    currentPath: req.path,
    statusCode: 404,
    message: res.locals.lang === 'en' ? 'Page not found' : 'Az oldal nem található',
    detail: res.locals.lang === 'en'
      ? `The requested URL ${req.originalUrl} was not found on this server.`
      : `A kért URL (${req.originalUrl}) nem található a szerveren.`,
    stack: null
  });
});

// General error handler
app.use((err, req, res, _next) => {
  const statusCode = err.status || 500;
  const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
  console.error(`[${new Date().toISOString()}] Error ${statusCode}: ${err.message}`);
  console.error(err.stack);
  // Persist error to audit log (non-blocking)
  logger.appError(statusCode, err.message, err.stack, meta).catch(() => {});
  res.status(statusCode).render('error', {
    pageTitle: `${statusCode} — Error`,
    currentPath: req.path,
    statusCode,
    message: statusCode === 500
      ? (res.locals.lang === 'en' ? 'Internal Server Error' : 'Szerverhiba')
      : err.message,
    detail: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });
});

// Start server only when run directly (not when imported for testing)
if (require.main === module) {
  dbReady.then(() => {
    app.listen(PORT, () => {
      console.log(`House Hunt running at http://localhost:${PORT}`);
    });
  }).catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
}

module.exports = app;
