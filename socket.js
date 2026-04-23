'use strict';

/**
 * socket.js — HDM Bot Socket.IO Handler
 *
 * Initializes all real-time socket events for the dashboard.
 * Called from server.js via: initSocket(io)
 *
 * Events emitted TO dashboard:
 *   hdm:sessions_status     — full sessions map on any change
 *   hdm:qr                  — { sessionId, qr } when QR generated
 *   hdm:ready               — { sessionId, phone, name } on connect
 *   hdm:authenticated       — { sessionId }
 *   hdm:disconnected        — { sessionId, reason }
 *   hdm:auth_failure        — { sessionId, message }
 *   hdm:state_change        — { sessionId, state }
 *   hdm:new_message         — incoming message payload
 *   hdm:message_sent        — outgoing message confirmation
 *   hdm:message_deleted     — anti-delete payload
 *   hdm:commands_reloaded   — broadcast after reload
 *   hdm:rules_reloaded      — broadcast after reload
 *   hdm:error               — { action, message }
 *
 * Events received FROM dashboard:
 *   hdm:connect             — start default session
 *   hdm:disconnect_wa       — stop default session
 *   hdm:get_status          — get connection status
 *   hdm:get_qr              — fetch current QR code
 *   hdm:connect_session     — { sessionId } start named session
 *   hdm:disconnect_session  — { sessionId } stop named session
 *   hdm:get_sessions_status — fetch all sessions
 *   hdm:toggle_autostart    — { sessionId, autoStart }
 *   hdm:send_message        — { to, message, sessionId }
 *   hdm:send_message_session— { sessionId, to, message }
 *   hdm:get_messages        — { chat, limit, sessionId }
 *   hdm:reload_commands     — force reload from DB
 *   hdm:reload_rules        — force reload from DB
 */

const logger  = require('./utils/logger');
const Message = require('./models/Message');

// ── Normalize session IDs (strip "session-" prefix) ───────
const normalizeSessionId = (sid) => {
  if (!sid) return sid;
  return String(sid).startsWith('session-') ? String(sid).substring(8) : sid;
};

// ── Track connected dashboard clients ─────────────────────
const connectedSockets = new Map();

// ============================================
// INIT SOCKET
// ============================================
const initSocket = (io) => {

  io.on('connection', (socket) => {
    const sid      = socket.id;
    const clientIp = socket.handshake.address;

    connectedSockets.set(sid, { id: sid, ip: clientIp, connectedAt: new Date() });
    logger.info(`🔌 Dashboard connected [${sid}] from ${clientIp} (total: ${connectedSockets.size})`);

    // ── Lazy-load WhatsApp helpers (avoid circular deps) ──
    const {
      startClient,
      startClientSession,
      getAllSessionsStatus,
      disconnectSession,
      sendMessageFromSession,
      getCurrentQR,
      restoreAllSessions,
      toggleSessionAutoStart,
      getConnectionStatus,
    } = require('./whatsapp/client');

    const { loadCommandsFromDB } = require('./whatsapp/commandHandler');
    const { loadRules }          = require('./whatsapp/ruleEngine');

    // ── Send initial state on connect ──────────────────
    getAllSessionsStatus().then((status) => {
      socket.emit('hdm:sessions_status', status);
    });

    // ============================================
    // QR CODE
    // ============================================
    socket.on('hdm:get_qr', (callback) => {
      const qr = getCurrentQR();
      logger.info(`📷 QR requested by [${sid}]`);
      if (typeof callback === 'function') callback({ qr: qr || null });
    });

    // ============================================
    // LEGACY SINGLE-SESSION (default)
    // ============================================
    socket.on('hdm:connect', async () => {
      logger.info(`📱 Connect (default) requested by [${sid}]`);
      try {
        await startClient(io);
        io.emit('hdm:sessions_status', await getAllSessionsStatus());
      } catch (err) {
        logger.error(`Connect error: ${err.message}`);
        socket.emit('hdm:error', { action: 'connect', message: err.message });
      }
    });

    socket.on('hdm:disconnect_wa', async () => {
      logger.info(`🔌 Disconnect (default) requested by [${sid}]`);
      try {
        await disconnectSession('default');
        io.emit('hdm:sessions_status', await getAllSessionsStatus());
      } catch (err) {
        socket.emit('hdm:error', { action: 'disconnect', message: err.message });
      }
    });

    socket.on('hdm:get_status', (callback) => {
      const status = getConnectionStatus('default');
      logger.info(`📊 Status check by [${sid}]: ${status.state}`);
      if (typeof callback === 'function') callback(status);
      else socket.emit('hdm:status', status);
    });

    // ============================================
    // MULTI-SESSION
    // ============================================
    socket.on('hdm:connect_session', async ({ sessionId }, callback) => {
      const clean = normalizeSessionId(sessionId);
      logger.info(`📱 Connect session [${clean}] requested by [${sid}]`);
      try {
        await startClientSession(io, clean);
        callback?.({ success: true, sessionId: clean });
        io.emit('hdm:sessions_status', await getAllSessionsStatus());
      } catch (err) {
        logger.error(`Connect session [${clean}] error: ${err.message}`);
        callback?.({ success: false, error: err.message });
        socket.emit('hdm:error', { action: 'connect_session', message: err.message });
      }
    });

    socket.on('hdm:get_sessions_status', async (callback) => {
      const status = await getAllSessionsStatus();
      if (typeof callback === 'function') callback(status);
      else socket.emit('hdm:sessions_status', status);
    });

    socket.on('hdm:disconnect_session', async ({ sessionId }, callback) => {
      const clean = normalizeSessionId(sessionId);
      logger.info(`🔌 Disconnect session [${clean}] by [${sid}]`);
      try {
        const result = await disconnectSession(clean);
        callback?.({ success: result, sessionId: clean });
        io.emit('hdm:sessions_status', await getAllSessionsStatus());
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on('hdm:toggle_autostart', async ({ sessionId, autoStart }, callback) => {
      const clean = normalizeSessionId(sessionId);
      logger.info(`🔧 Toggle autostart [${clean}] → ${autoStart} by [${sid}]`);
      try {
        const result = await toggleSessionAutoStart(clean, autoStart);
        callback?.({ success: result });
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    // ============================================
    // MESSAGING
    // ============================================
    socket.on('hdm:send_message', async ({ to, message, sessionId = 'default' }, callback) => {
      const clean = normalizeSessionId(sessionId);
      logger.info(`📤 Send message via [${clean}] to ${to} by [${sid}]`);
      try {
        const result = await sendMessageFromSession(clean, to, message);

        // Persist to DB
        await Message.create({
          messageId: result.id?.id || null,
          to,
          body:      message,
          direction: 'outgoing',
          status:    'sent',
          sessionId: clean,
        });

        // Broadcast to all dashboard clients
        io.emit('hdm:message_sent', {
          sessionId: clean,
          to,
          message,
          messageId: result.id?.id,
          timestamp: new Date(),
        });

        callback?.({ success: true, messageId: result.id?.id });
      } catch (err) {
        logger.error(`Send message error [${clean}]: ${err.message}`);
        callback?.({ success: false, error: err.message });
        socket.emit('hdm:error', { action: 'send_message', message: err.message });
      }
    });

    // Multi-session explicit variant
    socket.on('hdm:send_message_session', async ({ sessionId, to, message }, callback) => {
      const clean = normalizeSessionId(sessionId);
      logger.info(`📤 [Session] Send via [${clean}] to ${to} by [${sid}]`);
      try {
        const result = await sendMessageFromSession(clean, to, message);
        await Message.create({
          messageId: result.id?.id || null,
          to,
          body:      message,
          direction: 'outgoing',
          status:    'sent',
          sessionId: clean,
        });
        io.emit('hdm:message_sent', {
          sessionId: clean, to, message,
          messageId: result.id?.id, timestamp: new Date(),
        });
        callback?.({ success: true, messageId: result.id?.id });
      } catch (err) {
        logger.error(`Send message session error [${clean}]: ${err.message}`);
        callback?.({ success: false, error: err.message });
      }
    });

    // ============================================
    // MESSAGE HISTORY
    // ============================================
    socket.on('hdm:get_messages', async ({ chat, limit = 50, sessionId } = {}, callback) => {
      try {
        const query = {};
        if (sessionId) query.sessionId = normalizeSessionId(sessionId);
        if (chat)      query.$or = [{ from: chat }, { to: chat }];

        const messages = await Message.find(query)
          .sort({ timestamp: -1 })
          .limit(Math.min(limit, 200))
          .lean();

        if (typeof callback === 'function') callback({ success: true, data: messages });
        else socket.emit('hdm:messages', messages);
      } catch (err) {
        logger.error(`Get messages error: ${err.message}`);
        callback?.({ success: false, error: err.message });
      }
    });

    // ============================================
    // RELOAD COMMANDS / RULES
    // ============================================
    socket.on('hdm:reload_commands', async (callback) => {
      logger.info(`🔄 Reload commands requested by [${sid}]`);
      try {
        await loadCommandsFromDB();
        io.emit('hdm:commands_reloaded');
        callback?.({ success: true });
      } catch (err) {
        logger.error(`Reload commands error: ${err.message}`);
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on('hdm:reload_rules', async (callback) => {
      logger.info(`🔄 Reload rules requested by [${sid}]`);
      try {
        await loadRules();
        io.emit('hdm:rules_reloaded');
        callback?.({ success: true });
      } catch (err) {
        logger.error(`Reload rules error: ${err.message}`);
        callback?.({ success: false, error: err.message });
      }
    });

    // ============================================
    // DISCONNECT
    // ============================================
    socket.on('disconnect', (reason) => {
      connectedSockets.delete(sid);
      logger.info(`🔌 Dashboard disconnected [${sid}] — ${reason} (remaining: ${connectedSockets.size})`);
    });
  });

  logger.info('✅ Socket.IO initialized');
};

// ── Expose connected socket count (for admin status) ─────
const getConnectedCount = () => connectedSockets.size;

module.exports = { initSocket, getConnectedCount };
