'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { protect, authorize } = require('../middleware/auth');
const Command = require('../models/Command');
const Rule = require('../models/Rule');
const BotSetting = require('../models/BotSetting');
const Message = require('../models/Message');
const logger = require('../utils/logger');

router.use(protect);
router.use(authorize('admin'));

// GET /api/backup/export — full data export as JSON
router.get('/export', async (req, res) => {
  try {
    const { include = 'commands,rules,settings' } = req.query;
    const parts = include.split(',').map((s) => s.trim());
    const backup = {
      exportedAt: new Date().toISOString(),
      version: process.env.BOT_VERSION || '2.0.0',
      bot: process.env.BOT_NAME || 'HDM',
    };

    if (parts.includes('commands')) {
      backup.commands = await Command.find({}).lean();
    }
    if (parts.includes('rules')) {
      backup.rules = await Rule.find({}).lean();
    }
    if (parts.includes('settings')) {
      backup.settings = await BotSetting.find({}).lean();
    }
    if (parts.includes('messages')) {
      // Only last 1000 messages to keep file size reasonable
      backup.messages = await Message.find({}).sort({ timestamp: -1 }).limit(1000).lean();
    }

    const filename = `hdm-backup-${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);

    logger.info(`Backup exported by ${req.user.email}`);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/backup/import — restore from JSON
router.post('/import', async (req, res) => {
  try {
    const { data, overwrite = false } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid backup data' });
    }

    const results = { commands: 0, rules: 0, settings: 0 };

    // Import commands
    if (Array.isArray(data.commands)) {
      for (const cmd of data.commands) {
        const { _id, createdAt, updatedAt, __v, ...rest } = cmd;
        if (overwrite) {
          await Command.findOneAndUpdate({ name: rest.name }, rest, { upsert: true });
        } else {
          const exists = await Command.findOne({ name: rest.name });
          if (!exists) await Command.create(rest);
        }
        results.commands++;
      }
    }

    // Import rules
    if (Array.isArray(data.rules)) {
      for (const rule of data.rules) {
        const { _id, createdAt, updatedAt, __v, ...rest } = rule;
        if (overwrite) {
          await Rule.findOneAndUpdate({ name: rest.name }, rest, { upsert: true });
        } else {
          const exists = await Rule.findOne({ name: rest.name });
          if (!exists) await Rule.create(rest);
        }
        results.rules++;
      }
    }

    // Import settings
    if (Array.isArray(data.settings)) {
      for (const setting of data.settings) {
        const { _id, createdAt, updatedAt, __v, ...rest } = setting;
        await BotSetting.findOneAndUpdate(
          { sessionId: rest.sessionId, key: rest.key },
          rest,
          { upsert: true }
        );
        results.settings++;
      }
    }

    // Reload caches
    const { loadCommandsFromDB } = require('../whatsapp/commandHandler');
    const { loadRules } = require('../whatsapp/ruleEngine');
    await Promise.all([loadCommandsFromDB(), loadRules()]);

    const io = req.app.get('io');
    if (io) {
      io.emit('hdm:commands_reloaded');
      io.emit('hdm:rules_reloaded');
    }

    logger.info(`Backup imported by ${req.user.email}: ${JSON.stringify(results)}`);
    res.json({ success: true, imported: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/backup/logs — list log files
router.get('/logs', (req, res) => {
  try {
    const logDir = process.env.LOG_DIR || path.join(__dirname, '../logs');
    if (!fs.existsSync(logDir)) return res.json({ success: true, data: [] });

    const files = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const stat = fs.statSync(path.join(logDir, f));
        return { name: f, size: stat.size, modifiedAt: stat.mtime };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/backup/logs/:filename — download a log file
router.get('/logs/:filename', (req, res) => {
  try {
    const logDir = process.env.LOG_DIR || path.join(__dirname, '../logs');
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(logDir, filename);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ success: false, error: 'Log file not found' });

    res.download(filePath);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/backup/logs/:filename — delete a log file
router.delete('/logs/:filename', (req, res) => {
  try {
    const logDir = process.env.LOG_DIR || path.join(__dirname, '../logs');
    const filename = path.basename(req.params.filename);
    const filePath = path.join(logDir, filename);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ success: false, error: 'Log file not found' });

    fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Log file deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
