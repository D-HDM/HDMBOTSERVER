'use strict';

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const BotSetting = require('../models/BotSetting');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

// GET /api/settings/:sessionId
router.get('/:sessionId', async (req, res) => {
  try {
    const settings = await BotSetting.find({ sessionId: req.params.sessionId }).lean();
    // Convert to key-value map
    const map = {};
    settings.forEach((s) => { map[s.key] = s.value; });

    // Apply defaults for missing keys
    const defaults = {
      commandPrefix: '.',
      mode: 'public',
      footerText: '🤖 HDM Bot • Powered by WA',
      alwaysOnline: false,
      autoViewStatus: false,
      antiDelete: true,
    };

    res.json({ success: true, data: { ...defaults, ...map }, sessionId: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/settings/:sessionId (mod or admin)
router.put(
  '/:sessionId',
  authorize('admin', 'mod'),
  [
    body('key').trim().notEmpty(),
    body('value').exists(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const { sessionId } = req.params;
      const { key, value } = req.body;

      const setting = await BotSetting.findOneAndUpdate(
        { sessionId, key },
        { sessionId, key, value, updatedAt: new Date() },
        { upsert: true, new: true }
      );

      // Emit to sockets so live bot picks up the change
      const io = req.app.get('io');
      if (io) io.emit('hdm:setting_updated', { sessionId, key, value });

      res.json({ success: true, data: setting });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// PUT /api/settings/:sessionId/bulk (mod or admin) — update multiple keys at once
router.put(
  '/:sessionId/bulk',
  authorize('admin', 'mod'),
  [body('settings').isObject()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const { sessionId } = req.params;
      const { settings } = req.body;

      const ops = Object.entries(settings).map(([key, value]) => ({
        updateOne: {
          filter: { sessionId, key },
          update: { $set: { sessionId, key, value, updatedAt: new Date() } },
          upsert: true,
        },
      }));

      await BotSetting.bulkWrite(ops);

      const io = req.app.get('io');
      if (io) io.emit('hdm:settings_bulk_updated', { sessionId, settings });

      res.json({ success: true, message: `Updated ${ops.length} settings` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// DELETE /api/settings/:sessionId/:key (admin only)
router.delete('/:sessionId/:key', authorize('admin'), async (req, res) => {
  try {
    await BotSetting.findOneAndDelete({ sessionId: req.params.sessionId, key: req.params.key });
    res.json({ success: true, message: 'Setting deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/settings/:sessionId (admin only — wipe all settings for a session)
router.delete('/:sessionId', authorize('admin'), async (req, res) => {
  try {
    const result = await BotSetting.deleteMany({ sessionId: req.params.sessionId });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
