'use strict';

const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Command = require('../models/Command');
const Rule = require('../models/Rule');
const Session = require('../models/Session');
const { protect, authorize } = require('../middleware/auth');
const { getAllSessionsStatus } = require('../whatsapp/client');

router.use(protect);
router.use(authorize('admin', 'mod'));

// GET /api/analytics/overview
router.get('/overview', async (req, res) => {
  try {
    const { sessionId, days = 7 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86_400_000);
    const msgFilter = { timestamp: { $gte: since } };
    if (sessionId) msgFilter.sessionId = sessionId;

    const [
      totalMessages,
      incomingMessages,
      outgoingMessages,
      commandMessages,
      deletedMessages,
      totalCommands,
      activeCommands,
      totalRules,
      activeRules,
      sessions,
    ] = await Promise.all([
      Message.countDocuments(msgFilter),
      Message.countDocuments({ ...msgFilter, direction: 'incoming' }),
      Message.countDocuments({ ...msgFilter, direction: 'outgoing' }),
      Message.countDocuments({ ...msgFilter, isCommand: true }),
      Message.countDocuments({ ...msgFilter, isDeleted: true }),
      Command.countDocuments(),
      Command.countDocuments({ enabled: true }),
      Rule.countDocuments(),
      Rule.countDocuments({ enabled: true }),
      getAllSessionsStatus(),
    ]);

    const connectedSessions = Object.values(sessions).filter((s) => s.connected).length;

    res.json({
      success: true,
      data: {
        messages: {
          total: totalMessages,
          incoming: incomingMessages,
          outgoing: outgoingMessages,
          commands: commandMessages,
          deleted: deletedMessages,
        },
        commands: { total: totalCommands, active: activeCommands },
        rules: { total: totalRules, active: activeRules },
        sessions: {
          total: Object.keys(sessions).length,
          connected: connectedSessions,
          list: sessions,
        },
        period: { days: parseInt(days), since: since.toISOString() },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/messages/daily
router.get('/messages/daily', async (req, res) => {
  try {
    const { sessionId, days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86_400_000);
    const filter = { timestamp: { $gte: since } };
    if (sessionId) filter.sessionId = sessionId;

    const daily = await Message.aggregate([
      { $match: filter },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            direction: '$direction',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ]);

    res.json({ success: true, data: daily });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/commands/top
router.get('/commands/top', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const top = await Command.find({ timesUsed: { $gt: 0 } })
      .sort({ timesUsed: -1 })
      .limit(parseInt(limit))
      .select('name description timesUsed category lastUsedAt')
      .lean();
    res.json({ success: true, data: top });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/messages/by-session
router.get('/messages/by-session', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86_400_000);

    const bySession = await Message.aggregate([
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: '$sessionId',
          total: { $sum: 1 },
          incoming: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'outgoing'] }, 1, 0] } },
          commands: { $sum: { $cond: ['$isCommand', 1, 0] } },
        },
      },
      { $sort: { total: -1 } },
    ]);

    res.json({ success: true, data: bySession });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/rules/top
router.get('/rules/top', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const top = await Rule.find({ timesTriggered: { $gt: 0 } })
      .sort({ timesTriggered: -1 })
      .limit(parseInt(limit))
      .select('name triggerValue timesTriggered lastTriggeredAt scope')
      .lean();
    res.json({ success: true, data: top });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/server
router.get('/server', async (req, res) => {
  try {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    res.json({
      success: true,
      data: {
        uptime: { seconds: uptime, formatted: formatUptime(uptime) },
        memory: {
          rss: formatBytes(mem.rss),
          heapUsed: formatBytes(mem.heapUsed),
          heapTotal: formatBytes(mem.heapTotal),
          external: formatBytes(mem.external),
        },
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        env: process.env.NODE_ENV,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}h ${m}m ${sec}s`;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

module.exports = router;
