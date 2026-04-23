'use strict';

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const Command = require('../models/Command');
const { protect, authorize } = require('../middleware/auth');
const logger = require('../utils/logger');

// All command routes require authentication
router.use(protect);

// GET /api/commands
router.get('/', async (req, res) => {
  try {
    const { category, enabled, search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (enabled !== undefined) filter.enabled = enabled === 'true';
    if (search) filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
    ];

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [commands, total] = await Promise.all([
      Command.find(filter).sort({ category: 1, name: 1 }).skip(skip).limit(parseInt(limit)).lean(),
      Command.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: commands,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/commands/:id
router.get('/:id', async (req, res) => {
  try {
    const cmd = await Command.findById(req.params.id).lean();
    if (!cmd) return res.status(404).json({ success: false, error: 'Command not found' });
    res.json({ success: true, data: cmd });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/commands (mod or admin)
router.post(
  '/',
  authorize('admin', 'mod'),
  [
    body('name').trim().toLowerCase().notEmpty().matches(/^[a-z0-9_-]+$/),
    body('response').trim().notEmpty(),
    body('description').optional().trim(),
    body('category').optional().isIn(['general','utility','group','ai','fun','media','settings','admin','bug','privacy','custom']),
    body('requiredRole').optional().isIn(['user', 'mod', 'admin']),
    body('adminOnly').optional().isBoolean(),
    body('aliases').optional().isArray(),
    body('cooldownSeconds').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const cmd = await Command.create({ ...req.body, createdBy: req.user._id });
      logger.info(`Command created: ${cmd.name} by ${req.user.email}`);

      // Reload commands cache
      const { loadCommandsFromDB } = require('../whatsapp/commandHandler');
      await loadCommandsFromDB();
      // Notify all sockets
      const io = req.app.get('io');
      if (io) io.emit('hdm:commands_reloaded');

      res.status(201).json({ success: true, data: cmd });
    } catch (err) {
      if (err.code === 11000)
        return res.status(409).json({ success: false, error: 'Command name already exists' });
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// PUT /api/commands/:id (mod or admin)
router.put(
  '/:id',
  authorize('admin', 'mod'),
  [
    body('name').optional().trim().toLowerCase().matches(/^[a-z0-9_-]+$/),
    body('response').optional().trim().notEmpty(),
    body('requiredRole').optional().isIn(['user', 'mod', 'admin']),
    body('adminOnly').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const cmd = await Command.findByIdAndUpdate(
        req.params.id,
        { ...req.body, updatedBy: req.user._id },
        { new: true, runValidators: true }
      );
      if (!cmd) return res.status(404).json({ success: false, error: 'Command not found' });

      const { loadCommandsFromDB } = require('../whatsapp/commandHandler');
      await loadCommandsFromDB();
      const io = req.app.get('io');
      if (io) io.emit('hdm:commands_reloaded');

      res.json({ success: true, data: cmd });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// PATCH /api/commands/:id/toggle (mod or admin)
router.patch('/:id/toggle', authorize('admin', 'mod'), async (req, res) => {
  try {
    const cmd = await Command.findById(req.params.id);
    if (!cmd) return res.status(404).json({ success: false, error: 'Command not found' });
    cmd.enabled = !cmd.enabled;
    await cmd.save();

    const { loadCommandsFromDB } = require('../whatsapp/commandHandler');
    await loadCommandsFromDB();
    const io = req.app.get('io');
    if (io) io.emit('hdm:commands_reloaded');

    res.json({ success: true, data: cmd });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/commands/:id (admin only)
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const cmd = await Command.findByIdAndDelete(req.params.id);
    if (!cmd) return res.status(404).json({ success: false, error: 'Command not found' });

    const { loadCommandsFromDB } = require('../whatsapp/commandHandler');
    await loadCommandsFromDB();
    const io = req.app.get('io');
    if (io) io.emit('hdm:commands_reloaded');

    logger.info(`Command deleted: ${cmd.name} by ${req.user.email}`);
    res.json({ success: true, message: 'Command deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/commands/stats/summary
router.get('/stats/summary', authorize('admin', 'mod'), async (req, res) => {
  try {
    const [total, enabled, byCategory] = await Promise.all([
      Command.countDocuments(),
      Command.countDocuments({ enabled: true }),
      Command.aggregate([{ $group: { _id: '$category', count: { $sum: 1 }, totalUsed: { $sum: '$timesUsed' } } }]),
    ]);
    res.json({ success: true, data: { total, enabled, disabled: total - enabled, byCategory } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
