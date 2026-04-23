'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const Session = require('../models/Session');

// ============================================
// STATE
// ============================================
const clients = new Map();        // sessionId → Client instance
const qrCodes = new Map();        // sessionId → qr string
const connectionStatus = new Map(); // sessionId → status object

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, '../sessions');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 5;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS) || 5000;
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS) || 30000;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL;

if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

// ============================================
// STATUS HELPER
// ============================================
const buildStatus = (sessionId, extra = {}) => ({
  sessionId,
  connected: false,
  state: 'DISCONNECTED',
  phone: null,
  name: null,
  qr: qrCodes.get(sessionId) || null,
  ...(connectionStatus.get(sessionId) || {}),
  ...extra,
});

// ============================================
// PUPPETEER ARGS
// ============================================
const getPuppeteerArgs = () => {
  const raw = process.env.PUPPETEER_ARGS || '';
  const defaults = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
  ];
  return raw ? raw.split(',').map((a) => a.trim()) : defaults;
};

// ============================================
// CREATE CLIENT
// ============================================
const createWhatsAppClient = (sessionId) => {
  const puppeteerConfig = BROWSERLESS_URL
    ? {
        browserWSEndpoint: BROWSERLESS_URL,
        headless: true,
        args: getPuppeteerArgs(),
      }
    : {
        headless: true,
        args: getPuppeteerArgs(),
      };

  return new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: SESSION_PATH,
    }),
    puppeteer: puppeteerConfig,
    qrMaxRetries: MAX_RETRIES,
    restartOnAuthFail: process.env.AUTO_RECONNECT !== 'false',
    markOnlineOnConnect: process.env.MARK_ONLINE !== 'false',
    printQRInTerminal: process.env.PRINT_QR_IN_TERMINAL === 'true',
  });
};

// ============================================
// REGISTER CLIENT EVENTS
// ============================================
const registerClientEvents = (client, sessionId, io) => {
  const emit = (event, data) => {
    if (io) io.emit(event, data);
  };

  // QR code
  client.on('qr', (qr) => {
    logger.info(`[${sessionId}] QR code generated`);
    qrCodes.set(sessionId, qr);
    connectionStatus.set(sessionId, { connected: false, state: 'QR_READY', sessionId });
    emit('hdm:qr', { sessionId, qr });
    emit('hdm:sessions_status', getAllSessionsStatusSync());
  });

  // Authenticated
  client.on('authenticated', () => {
    logger.info(`[${sessionId}] Authenticated`);
    qrCodes.delete(sessionId);
    connectionStatus.set(sessionId, { connected: false, state: 'AUTHENTICATED', sessionId });
    emit('hdm:authenticated', { sessionId });
  });

  // Auth failure
  client.on('auth_failure', (msg) => {
    logger.error(`[${sessionId}] Auth failure: ${msg}`);
    connectionStatus.set(sessionId, { connected: false, state: 'AUTH_FAILED', sessionId, error: msg });
    emit('hdm:auth_failure', { sessionId, message: msg });
  });

  // Ready
  client.on('ready', async () => {
    const info = client.info;
    const phone = info?.wid?.user || 'unknown';
    const name = info?.pushname || 'HDM Bot';

    logger.info(`[${sessionId}] Ready ✅ — ${phone} (${name})`);
    qrCodes.delete(sessionId);
    connectionStatus.set(sessionId, {
      connected: true,
      state: 'CONNECTED',
      sessionId,
      phone,
      name,
      connectedAt: new Date().toISOString(),
    });

    emit('hdm:ready', { sessionId, phone, name });
    emit('hdm:sessions_status', getAllSessionsStatusSync());

    // Update DB record
    try {
      await Session.findOneAndUpdate(
        { sessionId },
        { status: 'active', phoneNumber: phone, displayName: name, connectedAt: new Date() },
        { upsert: true }
      );
    } catch (err) {
      logger.warn(`[${sessionId}] Failed to update session DB record: ${err.message}`);
    }

    // Keep-alive
    if (KEEP_ALIVE_INTERVAL > 0) {
      setInterval(() => {
        try { client.getState(); } catch {}
      }, KEEP_ALIVE_INTERVAL);
    }
  });

  // Disconnected
  client.on('disconnected', async (reason) => {
    logger.warn(`[${sessionId}] Disconnected: ${reason}`);
    connectionStatus.set(sessionId, {
      connected: false,
      state: 'DISCONNECTED',
      sessionId,
      reason,
    });
    emit('hdm:disconnected', { sessionId, reason });
    emit('hdm:sessions_status', getAllSessionsStatusSync());

    try {
      await Session.findOneAndUpdate(
        { sessionId },
        { status: 'disconnected', disconnectedAt: new Date() }
      );
    } catch {}

    // Auto-reconnect
    if (process.env.AUTO_RECONNECT !== 'false' && reason !== 'LOGOUT') {
      logger.info(`[${sessionId}] Scheduling reconnect in ${RETRY_DELAY}ms…`);
      setTimeout(async () => {
        try {
          await startClientSession(io, sessionId);
        } catch (err) {
          logger.error(`[${sessionId}] Reconnect failed: ${err.message}`);
        }
      }, RETRY_DELAY);
    }
  });

  // Incoming messages
  client.on('message', async (msg) => {
    try {
      const { handleMessage } = require('./messageHandler');
      await handleMessage(client, msg, sessionId, io);
    } catch (err) {
      logger.error(`[${sessionId}] Message handler error: ${err.message}`);
    }
  });

  // Message revoked (anti-delete)
  client.on('message_revoke_everyone', async (after, before) => {
    try {
      const { handleMessageRevoke } = require('./messageHandler');
      await handleMessageRevoke(client, after, before, sessionId, io);
    } catch (err) {
      logger.error(`[${sessionId}] Revoke handler error: ${err.message}`);
    }
  });

  // Group join
  client.on('group_join', async (notification) => {
    try {
      const { handleGroupJoin } = require('./commandHandler');
      await handleGroupJoin(client, notification, sessionId);
    } catch (err) {
      logger.error(`[${sessionId}] Group join handler error: ${err.message}`);
    }
  });

  // Group leave
  client.on('group_leave', async (notification) => {
    try {
      const { handleGroupLeave } = require('./commandHandler');
      await handleGroupLeave(client, notification, sessionId);
    } catch (err) {
      logger.error(`[${sessionId}] Group leave handler error: ${err.message}`);
    }
  });

  // State change
  client.on('change_state', (state) => {
    logger.info(`[${sessionId}] State changed → ${state}`);
    const current = connectionStatus.get(sessionId) || {};
    connectionStatus.set(sessionId, { ...current, state, sessionId });
    emit('hdm:state_change', { sessionId, state });
  });
};

// ============================================
// START SESSION
// ============================================
const startClientSession = async (io, sessionId = 'default') => {
  if (clients.has(sessionId)) {
    logger.info(`[${sessionId}] Already running — skipping`);
    return clients.get(sessionId);
  }

  logger.info(`[${sessionId}] Initializing WhatsApp client…`);
  connectionStatus.set(sessionId, { connected: false, state: 'INITIALIZING', sessionId });
  if (io) io.emit('hdm:sessions_status', getAllSessionsStatusSync());

  const client = createWhatsAppClient(sessionId);
  clients.set(sessionId, client);
  registerClientEvents(client, sessionId, io);

  await client.initialize();
  return client;
};

// ============================================
// LEGACY SINGLE-SESSION HELPER
// ============================================
const startClient = (io) => startClientSession(io, 'default');

// ============================================
// DISCONNECT SESSION
// ============================================
const disconnectSession = async (sessionId) => {
  const client = clients.get(sessionId);
  if (!client) return false;

  try {
    await client.destroy();
  } catch (err) {
    logger.warn(`[${sessionId}] Destroy error: ${err.message}`);
  }

  clients.delete(sessionId);
  qrCodes.delete(sessionId);
  connectionStatus.set(sessionId, { connected: false, state: 'DISCONNECTED', sessionId });

  try {
    await Session.findOneAndUpdate({ sessionId }, { status: 'inactive', disconnectedAt: new Date() });
  } catch {}

  return true;
};

// ============================================
// SEND MESSAGE FROM SESSION
// ============================================
const sendMessageFromSession = async (sessionId, to, message) => {
  const client = clients.get(sessionId);
  if (!client) throw new Error(`Session "${sessionId}" not found or not connected`);

  const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@c.us`;
  return client.sendMessage(jid, message);
};

// ============================================
// GET STATUS
// ============================================
const getAllSessionsStatusSync = () => {
  const result = {};
  for (const [sessionId, status] of connectionStatus.entries()) {
    result[sessionId] = {
      ...status,
      qr: qrCodes.get(sessionId) || null,
    };
  }
  return result;
};

const getAllSessionsStatus = async () => {
  const result = getAllSessionsStatusSync();

  // Supplement with DB records for sessions that aren't in-memory
  try {
    const dbSessions = await Session.find({}).lean();
    dbSessions.forEach((s) => {
      if (!result[s.sessionId]) {
        result[s.sessionId] = {
          sessionId: s.sessionId,
          connected: false,
          state: s.status || 'DISCONNECTED',
          phone: s.phoneNumber,
          name: s.displayName,
          autoStart: s.autoStart,
          qr: null,
        };
      }
    });
  } catch {}

  return result;
};

const getConnectionStatus = (sessionId = 'default') => buildStatus(sessionId);

const getCurrentQR = (sessionId = 'default') => qrCodes.get(sessionId) || null;

// ============================================
// TOGGLE AUTO-START
// ============================================
const toggleSessionAutoStart = async (sessionId, autoStart) => {
  try {
    await Session.findOneAndUpdate(
      { sessionId },
      { autoStart, sessionId },
      { upsert: true }
    );
    return true;
  } catch (err) {
    logger.error(`toggleSessionAutoStart error: ${err.message}`);
    return false;
  }
};

// ============================================
// RESTORE ALL AUTO-START SESSIONS
// ============================================
const restoreAllSessions = async (io) => {
  try {
    const sessions = await Session.find({ autoStart: true }).lean();
    if (!sessions.length) {
      logger.info('No saved sessions to restore');
      return;
    }

    logger.info(`Restoring ${sessions.length} session(s)…`);
    for (const session of sessions) {
      if (!clients.has(session.sessionId)) {
        try {
          await startClientSession(io, session.sessionId);
          await new Promise((r) => setTimeout(r, 2000)); // stagger starts
        } catch (err) {
          logger.error(`Failed to restore session [${session.sessionId}]: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`restoreAllSessions error: ${err.message}`);
  }
};

// ============================================
// LEGACY DISCONNECT (single session)
// ============================================
const disconnect = () => disconnectSession('default');

module.exports = {
  clients,
  startClient,
  startClientSession,
  disconnectSession,
  disconnect,
  sendMessageFromSession,
  getConnectionStatus,
  getAllSessionsStatus,
  getAllSessionsStatusSync,
  getCurrentQR,
  toggleSessionAutoStart,
  restoreAllSessions,
};
