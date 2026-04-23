'use strict';

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { protect, authorize } = require('../middleware/auth');
const {
  startClientSession,
  disconnectSession,
  getAllSessionsStatus,
  getCurrentQR,
  sendMessageFromSession,
  toggleSessionAutoStart,
} = require('../whatsapp/client');
const Session = require('../models/Session');
const logger = require('../utils/logger');

router.use(protect);

// GET /api/whatsapp/sessions
router.get('/sessions', async (req, res) => {
  try {
    const status = await getAllSessionsStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/sessions/:sessionId
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const all = await getAllSessionsStatus();
    const session = all[req.params.sessionId];
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, data: session });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/sessions/connect (mod or admin)
router.post(
  '/sessions/connect',
  authorize('admin', 'mod'),
  [body('sessionId').optional().trim()],
  async (req, res) => {
    try {
      const sessionId = req.body.sessionId || 'default';
      const io = req.app.get('io');
      // Non-blocking — client init happens in background
      startClientSession(io, sessionId).catch((err) =>
        logger.error(`[${sessionId}] Connect error: ${err.message}`)
      );
      res.json({ success: true, message: `Connecting session "${sessionId}"…` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /api/whatsapp/sessions/disconnect (mod or admin)
router.post(
  '/sessions/disconnect',
  authorize('admin', 'mod'),
  [body('sessionId').optional().trim()],
  async (req, res) => {
    try {
      const sessionId = req.body.sessionId || 'default';
      const result = await disconnectSession(sessionId);
      const io = req.app.get('io');
      if (io) {
        const status = await getAllSessionsStatus();
        io.emit('hdm:sessions_status', status);
      }
      res.json({ success: result, message: result ? 'Disconnected' : 'Session not found' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /api/whatsapp/sessions/:sessionId/qr
router.get('/sessions/:sessionId/qr', async (req, res) => {
  try {
    const qr = getCurrentQR(req.params.sessionId);
    if (!qr) return res.status(404).json({ success: false, error: 'No QR available' });
    res.json({ success: true, qr });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/whatsapp/sessions/:sessionId/autostart (admin only)
router.patch(
  '/sessions/:sessionId/autostart',
  authorize('admin'),
  [body('autoStart').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const result = await toggleSessionAutoStart(req.params.sessionId, req.body.autoStart);
      res.json({ success: result, message: `Auto-start ${req.body.autoStart ? 'enabled' : 'disabled'}` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /api/whatsapp/send (mod or admin)
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
      res.json({ success: true, messageId: result.id?.id || null });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /api/whatsapp/sessions-db (admin only — DB records)
router.get('/sessions-db', authorize('admin'), async (req, res) => {
  try {
    const sessions = await Session.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/whatsapp/sessions/:sessionId (admin only — clear saved session files)
router.delete('/sessions/:sessionId', authorize('admin'), async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const sessionId = req.params.sessionId;

    // Disconnect if running
    await disconnectSession(sessionId).catch(() => {});

    // Remove session files
    const sessionPath = process.env.SESSION_PATH || path.join(__dirname, '../sessions');
    const clientDir = path.join(sessionPath, `session-${sessionId}`);
    if (fs.existsSync(clientDir)) {
      fs.rmSync(clientDir, { recursive: true, force: true });
    }

    // Remove DB record
    await Session.findOneAndDelete({ sessionId });

    res.json({ success: true, message: `Session "${sessionId}" cleared` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
