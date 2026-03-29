const express = require('express');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const { initDb } = require('./src/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
initDb();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Language middleware
app.use((req, res, next) => {
  if (req.query.lang && ['hu', 'en'].includes(req.query.lang)) {
    req.session.lang = req.query.lang;
  }
  req.lang = req.session.lang || 'hu';
  res.locals.lang = req.lang;
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
    property_finder: 'Property Finder'
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
    property_finder: 'Ingatlan Kereső'
  };
  next();
});

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

app.listen(PORT, () => {
  console.log(`House Hunt running at http://localhost:${PORT}`);
});

module.exports = app;
