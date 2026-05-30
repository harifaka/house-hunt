const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../database');
const { logger } = require('../logger');

// GET /calculators/energy — Energy calculator page
router.get('/energy', async (req, res) => {
  const db = await getDb();
  try {
    const houses = await db.prepare('SELECT id, name FROM houses ORDER BY name').all();
    const savedCalcs = await db.prepare('SELECT id, name, house_id, created_at, updated_at FROM energy_calculations ORDER BY updated_at DESC LIMIT 20').all();
    const itemTemplates = await db.prepare('SELECT * FROM energy_item_templates ORDER BY is_default DESC, category, name').all();

    res.render('energy-calculator', {
      pageTitle: res.locals.t.energy_calculator,
      currentPath: '/calculators/energy',
      houses,
      savedCalcs,
      itemTemplates
    });
  } finally {
    await db.close();
  }
});

// --- Energy Calculation API ---

// POST /calculators/energy/save — Save an energy calculation
router.post('/energy/save', async (req, res) => {
  const db = await getDb();
  try {
    const { id, name, houseId, parameters, results } = req.body;
    if (!name || !parameters || !results) {
      return res.status(400).json({ error: 'name, parameters, and results are required' });
    }

    const calcId = id || crypto.randomUUID();
    let paramsStr, resultsStr;
    try {
      paramsStr = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
      resultsStr = typeof results === 'string' ? results : JSON.stringify(results);
    } catch (_e) {
      return res.status(400).json({ error: 'Invalid parameters or results format' });
    }

    if (id) {
      const existing = await db.prepare('SELECT id FROM energy_calculations WHERE id = ?').get(id);
      if (existing) {
        await db.prepare(
          'UPDATE energy_calculations SET name = ?, house_id = ?, parameters = ?, results = ?, updated_at = ? WHERE id = ?'
        ).run(name, houseId || null, paramsStr, resultsStr, new Date().toISOString(), id);

        const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
        logger.audit('calculator', 'energy_calculation_updated', { calcId: id, name, houseId }, meta).catch(() => {});

        return res.json({ success: true, id });
      }
    }

    await db.prepare(
      'INSERT INTO energy_calculations (id, house_id, name, parameters, results) VALUES (?, ?, ?, ?, ?)'
    ).run(calcId, houseId || null, name, paramsStr, resultsStr);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'energy_calculation_saved', { calcId, name, houseId }, meta).catch(() => {});

    res.json({ success: true, id: calcId });
  } finally {
    await db.close();
  }
});

// GET /calculators/energy/load/:id — Load a saved energy calculation
router.get('/energy/load/:id', async (req, res) => {
  const db = await getDb();
  try {
    const calc = await db.prepare('SELECT * FROM energy_calculations WHERE id = ?').get(req.params.id);
    if (!calc) return res.status(404).json({ error: 'Calculation not found' });

    res.json({
      id: calc.id,
      name: calc.name,
      houseId: calc.house_id,
      parameters: JSON.parse(calc.parameters),
      results: JSON.parse(calc.results),
      aiAnalysis: calc.ai_analysis || null,
      createdAt: calc.created_at,
      updatedAt: calc.updated_at
    });
  } finally {
    await db.close();
  }
});

// POST /calculators/energy/delete/:id — Delete a saved energy calculation
router.post('/energy/delete/:id', async (req, res) => {
  const db = await getDb();
  try {
    await db.prepare('DELETE FROM energy_calculations WHERE id = ?').run(req.params.id);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'energy_calculation_deleted', { calcId: req.params.id }, meta).catch(() => {});

    res.json({ success: true });
  } finally {
    await db.close();
  }
});

// GET /calculators/energy/list — List saved energy calculations
router.get('/energy/list', async (req, res) => {
  const db = await getDb();
  try {
    const calcs = await db.prepare(
      'SELECT c.id, c.name, c.house_id, c.created_at, c.updated_at, h.name as house_name FROM energy_calculations c LEFT JOIN houses h ON c.house_id = h.id ORDER BY c.updated_at DESC'
    ).all();
    res.json(calcs);
  } finally {
    await db.close();
  }
});

// POST /calculators/energy/copy/:id — Clone an energy calculation
router.post('/energy/copy/:id', async (req, res) => {
  const db = await getDb();
  try {
    const original = await db.prepare('SELECT * FROM energy_calculations WHERE id = ?').get(req.params.id);
    if (!original) return res.status(404).json({ error: 'Calculation not found' });

    const newId = crypto.randomUUID();
    const newName = (req.body.name || original.name) + ' (copy)';
    const houseId = req.body.houseId !== undefined ? (req.body.houseId || null) : original.house_id;

    await db.prepare(
      'INSERT INTO energy_calculations (id, house_id, name, parameters, results) VALUES (?, ?, ?, ?, ?)'
    ).run(newId, houseId, newName, original.parameters, original.results);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'energy_calculation_copied', { sourceId: req.params.id, newId, newName }, meta).catch(() => {});

    res.json({ success: true, id: newId, name: newName });
  } finally {
    await db.close();
  }
});

// --- Energy Item Template API ---

// GET /calculators/energy/items — List all energy item templates
router.get('/energy/items', async (req, res) => {
  const db = await getDb();
  try {
    const items = await db.prepare('SELECT * FROM energy_item_templates ORDER BY is_default DESC, category, name').all();
    res.json(items);
  } finally {
    await db.close();
  }
});

// POST /calculators/energy/items — Create a new energy item template
router.post('/energy/items', async (req, res) => {
  const db = await getDb();
  try {
    const { name, name_hu, wattage, duty_cycle, daily_hours, category } = req.body;
    if (!name || wattage === undefined) {
      return res.status(400).json({ error: 'name and wattage are required' });
    }

    const id = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO energy_item_templates (id, name, name_hu, wattage, duty_cycle, daily_hours, category, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, name_hu || null, parseFloat(wattage) || 0, parseFloat(duty_cycle) || 100, parseFloat(daily_hours) || 0, category || 'other', 0);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'energy_item_created', { itemId: id, name }, meta).catch(() => {});

    res.json({ success: true, id });
  } finally {
    await db.close();
  }
});

// POST /calculators/energy/items/:id/delete — Delete an energy item template (only non-default)
router.post('/energy/items/:id/delete', async (req, res) => {
  const db = await getDb();
  try {
    const item = await db.prepare('SELECT * FROM energy_item_templates WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item template not found' });
    if (item.is_default === 1) return res.status(400).json({ error: 'Cannot delete default item templates' });

    await db.prepare('DELETE FROM energy_item_templates WHERE id = ?').run(req.params.id);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'energy_item_deleted', { itemId: req.params.id }, meta).catch(() => {});

    res.json({ success: true });
  } finally {
    await db.close();
  }
});

// POST /calculators/energy/ai-analysis — Generate AI energy analysis
router.post('/energy/ai-analysis', async (req, res) => {
  const { getAIConfig, callLLM } = require('../ai-service');
  try {
    const config = await getAIConfig();
    if (!config.endpoint) {
      return res.status(400).json({ error: 'AI not configured. Please set up AI in Admin settings.' });
    }

    const { parameters, results, lang } = req.body;
    if (!parameters || !results) {
      return res.status(400).json({ error: 'parameters and results are required' });
    }

    const params = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
    const res_data = typeof results === 'string' ? JSON.parse(results) : results;

    const langInstr = lang === 'en' ? 'Answer in English.' : 'Válaszolj magyarul.';
    const prompt = `${langInstr}

You are a professional energy consultant analyzing a household energy consumption calculation.

Electricity Price: ${params.electricityPrice || 68} ${params.currency || 'HUF'}/kWh
Default Duty Cycle: ${params.defaultDuty || 100}%

Appliances:
${(params.items || []).map(item =>
  `- ${item.name}: ${item.wattage}W × ${item.qty} units, ${item.duty}% duty cycle, ${item.hours}h/day`
).join('\n')}

Calculated Results:
- Daily consumption: ${res_data.dailyKwh || 0} kWh
- Monthly consumption: ${res_data.monthlyKwh || 0} kWh
- Yearly consumption: ${res_data.yearlyKwh || 0} kWh
- Monthly cost: ${res_data.monthlyCost || 0} ${params.currency || 'HUF'}
- Yearly cost: ${res_data.yearlyCost || 0} ${params.currency || 'HUF'}

Please provide a comprehensive energy analysis report that includes:

1. **Overall Assessment** - How does this consumption compare to typical households?
2. **Top Energy Consumers** - Which appliances consume the most energy and cost?
3. **Energy Saving Recommendations** - Specific, actionable suggestions to reduce consumption:
   - Quick wins (no/low cost changes)
   - Medium-term investments (moderate cost)
   - Long-term upgrades (higher cost but significant savings)
4. **Estimated Savings** - How much could be saved with each recommendation?
5. **Priority Actions** - Ranked list of what to address first

Write in a professional, easy-to-read format suitable for a property evaluation report.`;

    const analysis = await callLLM(prompt, config);

    // If there's an active calculation ID, save the analysis
    if (req.body.calculationId) {
      const db = await getDb();
      try {
        await db.prepare('UPDATE energy_calculations SET ai_analysis = ? WHERE id = ?').run(analysis, req.body.calculationId);
      } finally {
        await db.close();
      }
    }

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'energy_ai_analysis', { lang }, meta).catch(() => {});

    res.json({ success: true, analysis });
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed: ' + err.message });
  }
});

// GET /calculators/heating — Heating calculator page
router.get('/heating', async (req, res) => {
  const db = await getDb();
  try {
    const houses = await db.prepare('SELECT id, name FROM houses ORDER BY name').all();
    const templates = await db.prepare('SELECT * FROM window_door_templates ORDER BY is_standard DESC, name').all();
    const savedCalcs = await db.prepare('SELECT id, name, house_id, created_at, updated_at FROM heating_calculations ORDER BY updated_at DESC LIMIT 20').all();
    
    res.render('heating-calculator', {
      pageTitle: res.locals.t.heating_calculator,
      currentPath: '/calculators/heating',
      houses,
      templates,
      savedCalcs
    });
  } finally {
    await db.close();
  }
});

// --- Heating Calculation API ---

// POST /calculators/heating/save — Save a heating calculation
router.post('/heating/save', async (req, res) => {
  const db = await getDb();
  try {
    const { id, name, houseId, parameters, results } = req.body;
    if (!name || !parameters || !results) {
      return res.status(400).json({ error: 'name, parameters, and results are required' });
    }

    const calcId = id || crypto.randomUUID();
    let paramsStr, resultsStr;
    try {
      paramsStr = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
      resultsStr = typeof results === 'string' ? results : JSON.stringify(results);
    } catch (_e) {
      return res.status(400).json({ error: 'Invalid parameters or results format' });
    }

    // Check if updating existing
    if (id) {
      const existing = await db.prepare('SELECT id FROM heating_calculations WHERE id = ?').get(id);
      if (existing) {
        await db.prepare(
          'UPDATE heating_calculations SET name = ?, house_id = ?, parameters = ?, results = ?, updated_at = ? WHERE id = ?'
        ).run(name, houseId || null, paramsStr, resultsStr, new Date().toISOString(), id);
        
        const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
        logger.audit('calculator', 'calculation_updated', { calcId: id, name, houseId }, meta).catch(() => {});
        
        return res.json({ success: true, id });
      }
    }

    await db.prepare(
      'INSERT INTO heating_calculations (id, house_id, name, parameters, results) VALUES (?, ?, ?, ?, ?)'
    ).run(calcId, houseId || null, name, paramsStr, resultsStr);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'calculation_saved', { calcId, name, houseId }, meta).catch(() => {});

    res.json({ success: true, id: calcId });
  } finally {
    await db.close();
  }
});

// GET /calculators/heating/load/:id — Load a saved calculation
router.get('/heating/load/:id', async (req, res) => {
  const db = await getDb();
  try {
    const calc = await db.prepare('SELECT * FROM heating_calculations WHERE id = ?').get(req.params.id);
    if (!calc) return res.status(404).json({ error: 'Calculation not found' });
    
    res.json({
      id: calc.id,
      name: calc.name,
      houseId: calc.house_id,
      parameters: JSON.parse(calc.parameters),
      results: JSON.parse(calc.results),
      createdAt: calc.created_at,
      updatedAt: calc.updated_at
    });
  } finally {
    await db.close();
  }
});

// DELETE /calculators/heating/delete/:id — Delete a saved calculation
router.post('/heating/delete/:id', async (req, res) => {
  const db = await getDb();
  try {
    await db.prepare('DELETE FROM heating_calculations WHERE id = ?').run(req.params.id);
    
    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'calculation_deleted', { calcId: req.params.id }, meta).catch(() => {});
    
    res.json({ success: true });
  } finally {
    await db.close();
  }
});

// GET /calculators/heating/list — List saved calculations
router.get('/heating/list', async (req, res) => {
  const db = await getDb();
  try {
    const calcs = await db.prepare(
      'SELECT c.id, c.name, c.house_id, c.created_at, c.updated_at, h.name as house_name FROM heating_calculations c LEFT JOIN houses h ON c.house_id = h.id ORDER BY c.updated_at DESC'
    ).all();
    res.json(calcs);
  } finally {
    await db.close();
  }
});

// --- Window/Door Template API ---

// GET /calculators/templates — List all templates
router.get('/templates', async (req, res) => {
  const db = await getDb();
  try {
    const templates = await db.prepare('SELECT * FROM window_door_templates ORDER BY is_standard DESC, name').all();
    res.json(templates);
  } finally {
    await db.close();
  }
});

// POST /calculators/templates — Create a new template
router.post('/templates', async (req, res) => {
  const db = await getDb();
  try {
    const { name, width, height, type, u_value } = req.body;
    if (!name || !width || !height) {
      return res.status(400).json({ error: 'name, width, and height are required' });
    }

    const id = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO window_door_templates (id, name, width, height, type, u_value, is_standard) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, parseFloat(width), parseFloat(height), type || 'double', parseFloat(u_value) || 2.8, 0);

    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'template_created', { templateId: id, name }, meta).catch(() => {});

    res.json({ success: true, id });
  } finally {
    await db.close();
  }
});

// POST /calculators/templates/:id/delete — Delete a template (only non-standard)
router.post('/templates/:id/delete', async (req, res) => {
  const db = await getDb();
  try {
    // Don't allow deleting standard templates
    const template = await db.prepare('SELECT * FROM window_door_templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    if (template.is_standard === 1) return res.status(400).json({ error: 'Cannot delete standard templates' });

    await db.prepare('DELETE FROM window_door_templates WHERE id = ?').run(req.params.id);
    
    const meta = { ip: req.ip, ua: (req.headers['user-agent'] || '').substring(0, 255) };
    logger.audit('calculator', 'template_deleted', { templateId: req.params.id }, meta).catch(() => {});
    
    res.json({ success: true });
  } finally {
    await db.close();
  }
});

module.exports = router;
