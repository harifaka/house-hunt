const express = require('express');
const router = express.Router();

// GET /calculators/energy — Energy calculator page
router.get('/energy', (req, res) => {
  res.render('energy-calculator', {
    pageTitle: res.locals.t.energy_calculator,
    currentPath: '/calculators/energy'
  });
});

// GET /calculators/heating — Heating calculator page
router.get('/heating', (req, res) => {
  res.render('heating-calculator', {
    pageTitle: res.locals.t.heating_calculator,
    currentPath: '/calculators/heating'
  });
});

module.exports = router;
