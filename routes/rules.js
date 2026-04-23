'use strict';

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Rule = require('../models/Rule');
const { protect, authorize } = require('../middleware/auth');
const { loadRules } = require('../whatsapp/ruleEngine');

router.use(protect);

// GET /api/rules
router.get('/', async (req, res) => {
  try {
    const { enabled, scope, page = 1, limit = 50, search } = req.query;
    const filter = {};
    if (enabled !== undefined) filter.enabled = enabled === 'true';
    if (scope) filter.scope = scope;
    if (search) filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { triggerValue: { $regex: search, $options: 'i' } },
    ];

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [rules, total] = await Promise.all([
      Rule.find(filter).sort({ priority: -1, createdAt: 1 }).skip(skip).limit(parseInt(limit)).lean(),
      Rule.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: rules,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/rules/:id
router.get('/:id', async (req, res) => {
  try {
    const rule = await Rule.findById(req.params.id).lean();
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found' });
    res.json({ success: true, data: rule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/rules (mod or admin)
router.post(
  '/',
  authorize('admin', 'mod'),
  [
    body('name').trim().notEmpty().isLength({ max: 100 }),
    body('triggerType').isIn(['contains', 'startsWith', 'endsWith', 'exact', 'regex']),
    body('triggerValue').trim().notEmpty(),
    body('response').trim().notEmpty(),
    body('scope').optional().isIn(['all', 'group', 'private']),
    body('cooldownSeconds').optional().isInt({ min: 0 }),
    body('priority').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      // Validate regex if applicable
      if (req.body.triggerType === 'regex') {
        try { new RegExp(req.body.triggerValue); } catch {
          return res.status(400).json({ success: false, error: 'Invalid regular expression' });
        }
      }

      const rule = await Rule.create({ ...req.body, createdBy: req.user._id });
      await loadRules();
      const io = req.app.get('io');
      if (io) io.emit('hdm:rules_reloaded');

      res.status(201).json({ success: true, data: rule });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// PUT /api/rules/:id (mod or admin)
router.put(
  '/:id',
  authorize('admin', 'mod'),
  [
    body('triggerType').optional().isIn(['contains', 'startsWith', 'endsWith', 'exact', 'regex']),
    body('scope').optional().isIn(['all', 'group', 'private']),
    body('cooldownSeconds').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      if (req.body.triggerType === 'regex' && req.body.triggerValue) {
        try { new RegExp(req.body.triggerValue); } catch {
          return res.status(400).json({ success: false, error: 'Invalid regular expression' });
        }
      }

      const rule = await Rule.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
      if (!rule) return res.status(404).json({ success: false, error: 'Rule not found' });

      await loadRules();
      const io = req.app.get('io');
      if (io) io.emit('hdm:rules_reloaded');

      res.json({ success: true, data: rule });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// PATCH /api/rules/:id/toggle
router.patch('/:id/toggle', authorize('admin', 'mod'), async (req, res) => {
  try {
    const rule = await Rule.findById(req.params.id);
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found' });
    rule.enabled = !rule.enabled;
    await rule.save();

    await loadRules();
    const io = req.app.get('io');
    if (io) io.emit('hdm:rules_reloaded');

    res.json({ success: true, data: rule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/rules/:id (admin only)
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const rule = await Rule.findByIdAndDelete(req.params.id);
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found' });

    await loadRules();
    const io = req.app.get('io');
    if (io) io.emit('hdm:rules_reloaded');

    res.json({ success: true, message: 'Rule deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
