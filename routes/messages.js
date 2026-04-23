'use strict';

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const Message = require('../models/Message');
const { protect, authorize } = require('../middleware/auth');
const { sendMessageFromSession } = require('../whatsapp/client');

router.use(protect);

// GET /api/messages
router.get('/', async (req, res) => {
  try {
    const {
      sessionId, from, chat, direction, isCommand,
      page = 1, limit = 50, startDate, endDate,
    } = req.query;

    const filter = {};
    if (sessionId) filter.sessionId = sessionId;
    if (direction) filter.direction = direction;
    if (isCommand !== undefined) filter.isCommand = isCommand === 'true';
    if (from) filter.from = { $regex: from, $options: 'i' };
    if (chat) filter.$or = [{ from: chat }, { to: chat }];
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate);
      if (endDate) filter.timestamp.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Message.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: messages,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/messages/stats
router.get('/stats', authorize('admin', 'mod'), async (req, res) => {
  try {
    const { sessionId, days = 7 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86_400_000);
    const filter = { timestamp: { $gte: since } };
    if (sessionId) filter.sessionId = sessionId;

    const [total, incoming, outgoing, commands, deleted] = await Promise.all([
      Message.countDocuments(filter),
      Message.countDocuments({ ...filter, direction: 'incoming' }),
      Message.countDocuments({ ...filter, direction: 'outgoing' }),
      Message.countDocuments({ ...filter, isCommand: true }),
      Message.countDocuments({ ...filter, isDeleted: true }),
    ]);

    // Daily breakdown
    const daily = await Message.aggregate([
      { $match: filter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    res.json({ success: true, data: { total, incoming, outgoing, commands, deleted, daily } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/messages/:id
router.get('/:id', async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id).lean();
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });
    res.json({ success: true, data: msg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/messages/send (mod or admin)
router.post(
  '/send',
  authorize('admin', 'mod'),
  [
    body('to').trim().notEmpty(),
    body('message').trim().notEmpty(),
    body('sessionId').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const { to, message, sessionId = 'default' } = req.body;
      const result = await sendMessageFromSession(sessionId, to, message);

      const saved = await Message.create({
        messageId: result.id?.id || null,
        sessionId,
        to,
        body: message,
        direction: 'outgoing',
        status: 'sent',
      });

      const io = req.app.get('io');
      if (io) io.emit('hdm:message_sent', { sessionId, to, message, messageId: saved.messageId });

      res.json({ success: true, data: saved });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// DELETE /api/messages/purge (admin only — clear old messages)
router.delete('/purge', authorize('admin'), async (req, res) => {
  try {
    const { olderThanDays = 30 } = req.query;
    const cutoff = new Date(Date.now() - parseInt(olderThanDays) * 86_400_000);
    const result = await Message.deleteMany({ timestamp: { $lt: cutoff } });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
