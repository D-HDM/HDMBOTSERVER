const { Client, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const MongoStore = require('./mongoAuthStore');

// Store multiple clients
const clients = new Map();
const clientStatus = new Map();
const initializingSessions = new Set();

const SESSIONS_DIR = process.env.SESSION_PATH || path.join('./sessions');

// Ensure sessions directory exists
try {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`📁 Created sessions directory: ${SESSIONS_DIR}`);
  }
} catch (err) {
  console.error('❌ Cannot access sessions directory:', err.message);
}

// ============================================
// SESSION NAME UTILITIES
// ============================================
const normalizeSessionName = (name) => {
  if (!name) return 'default';
  if (name.startsWith('RemoteAuth-')) return name;
  return `RemoteAuth-${name}`;
};

const getDisplayName = (name) => {
  if (!name) return 'default';
  return name.replace(/^RemoteAuth-/, '');
};

const getClientId = (name) => name.replace(/^RemoteAuth-/, '');

// ============================================
// CHECK IF SESSION EXISTS ON DISK
// ============================================
const sessionExistsOnDisk = (sessionId) => {
  const normalizedName = normalizeSessionName(sessionId);
  const folderPath = path.join(SESSIONS_DIR, normalizedName);
  return fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory();
};

// ============================================
// GET ALL SESSIONS FROM DISK
// ============================================
const getAllDiskSessions = () => {
  try {
    const items = fs.readdirSync(SESSIONS_DIR);
    const sessions = [];
    for (const item of items) {
      const itemPath = path.join(SESSIONS_DIR, item);
      if (!fs.statSync(itemPath).isDirectory()) continue;
      if (item.startsWith('.') || !item.startsWith('RemoteAuth-')) continue;
      sessions.push(item);
    }
    return sessions;
  } catch (err) {
    return [];
  }
};

// ============================================
// BROWSERLESS ENDPOINT
// ============================================
const getBrowserlessEndpoint = () => {
  const endpoint = process.env.BROWSERLESS_URL;
  if (!endpoint) throw new Error('Browserless URL is required');
  return endpoint;
};

// ============================================
// DATABASE OPERATIONS
// ============================================
const saveSessionToDB = async (sessionId, phoneNumber) => {
  try {
    const Session = require('../models/Session');
    const displayName = getDisplayName(sessionId);
    await Session.findOneAndUpdate(
      { sessionId: displayName },
      {
        sessionId: displayName,
        phoneNumber: phoneNumber || '',
        lastConnected: new Date(),
        autoStart: true,
        name: displayName,
        fullPath: sessionId
      },
      { upsert: true }
    );
    console.log(`💾 Session "${displayName}" saved to database`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to save session:`, err.message);
    return false;
  }
};

const removeSessionFromDB = async (sessionId) => {
  try {
    const Session = require('../models/Session');
    const displayName = getDisplayName(sessionId);
    await Session.deleteOne({ sessionId: displayName });
    console.log(`🗑️ Session "${displayName}" removed from database`);
    return true;
  } catch (err) {
    return false;
  }
};

// ============================================
// DELETE AUTH STATE
// ============================================
const deleteAuthState = async (sessionId) => {
  try {
    const normalizedName = normalizeSessionName(sessionId);
    const displayName = getDisplayName(sessionId);
    await MongoStore.delete({ session: displayName });
    const folderPath = path.join(SESSIONS_DIR, normalizedName);
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log(`🗑️ Deleted: ${normalizedName}`);
    }
  } catch (err) {
    console.error(`❌ Failed to delete auth state:`, err.message);
  }
};

// ============================================
// PROCESS MESSAGE
// ============================================
const processSessionMessage = async (message, sessionId, client, socketIo) => {
  const from = message.from;
  const body = message.body;
  const isGroup = from.includes('@g.us');
  const isStatus = from.includes('status@broadcast');
  if (isStatus) return;

  const displayName = getDisplayName(sessionId);
  console.log(`📨 [${displayName}] ${from} - ${body.substring(0, 50)}`);

  if (socketIo) {
    socketIo.emit('hdm:session_message', {
      sessionId: displayName, from, body, isGroup, timestamp: new Date()
    });
  }

  try {
    const { handleIncomingMessage } = require('./messageHandler');
    await handleIncomingMessage(message, client, socketIo, displayName);
  } catch (err) {
    console.error(`❌ [${displayName}] Handler error:`, err.message);
  }
};

// ============================================
// START CLIENT
// ============================================
const startClient = async (socketIo, sessionId = 'default') => {
  const normalizedName = normalizeSessionName(sessionId);
  const displayName = getDisplayName(sessionId);
  const clientId = getClientId(sessionId);

  if (initializingSessions.has(normalizedName)) {
    console.log(`⏳ Session "${displayName}" is already initializing...`);
    return clients.get(normalizedName);
  }

  const existingClient = clients.get(normalizedName);
  if (existingClient && clientStatus.get(normalizedName)?.connected) {
    console.log(`✅ WhatsApp already connected for: ${displayName}`);
    return existingClient;
  }

  initializingSessions.add(normalizedName);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🤖 Starting WhatsApp Client: ${displayName}`);
  console.log(`📂 Session folder: ${normalizedName}`);
  console.log(`${'='.repeat(50)}`);

  if (existingClient) {
    try { await existingClient.destroy(); } catch {}
    clients.delete(normalizedName);
  }

  const browserWSEndpoint = getBrowserlessEndpoint();
  console.log(`🌐 Browserless: ${browserWSEndpoint.replace(/token=.*/, 'token=HIDDEN')}`);

  const clientOptions = {
    authStrategy: new RemoteAuth({
      clientId: clientId,
      dataPath: SESSIONS_DIR,
      store: MongoStore,
      backupSyncIntervalMs: 60000
    }),
    puppeteer: {
      browserWSEndpoint,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ]
    },
    qrMaxRetries: 3,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5000,
    restartOnAuthFail: true,
  };

  const client = new Client(clientOptions);
  clients.set(normalizedName, client);
  clientStatus.set(normalizedName, {
    connected: false, phone: null, qr: null,
    sessionId: normalizedName, displayName
  });

  return new Promise((resolve, reject) => {
    const initTimeout = setTimeout(() => {
      initializingSessions.delete(normalizedName);
      clientStatus.set(normalizedName, {
        connected: false, phone: null, qr: null, error: 'Initialization timeout',
        sessionId: normalizedName, displayName
      });
      reject(new Error('Initialization timeout'));
    }, 120000);

    client.on('qr', async (qr) => {
      console.log(`📱 QR Code generated: ${displayName}`);
      clientStatus.set(normalizedName, {
        connected: false, phone: null, qr,
        hasQR: true,
        sessionId: normalizedName, displayName
      });
      if (socketIo) {
        socketIo.emit('hdm:qr_raw', { sessionId: displayName, qr });
        if (displayName === 'default') {
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, {
              errorCorrectionLevel: 'L', margin: 1, width: 250
            });
            socketIo.emit('hdm:qr', qrDataUrl);
          } catch {}
        }
      }
    });

    client.on('authenticated', () => {
      console.log(`🔐 Authenticated: ${displayName}`);
    });

    client.on('auth_failure', async (msg) => {
      clearTimeout(initTimeout);
      initializingSessions.delete(normalizedName);
      console.error(`❌ Auth failure [${displayName}]:`, msg);
      clientStatus.set(normalizedName, {
        connected: false, phone: null, qr: null, hasQR: false, error: msg,
        sessionId: normalizedName, displayName
      });
      await deleteAuthState(normalizedName);
      await removeSessionFromDB(normalizedName);
      if (socketIo && displayName === 'default') {
        socketIo.emit('hdm:auth_failure', { message: msg });
      }
      reject(new Error(`Auth failure: ${msg}`));
    });

    client.on('ready', async () => {
      clearTimeout(initTimeout);
      initializingSessions.delete(normalizedName);
      console.log(`✅ Connected: ${displayName}`);
      const phone = client.info?.wid?.user;
      clientStatus.set(normalizedName, {
        connected: true, phone, qr: null, hasQR: false,
        sessionId: normalizedName, displayName
      });
      await saveSessionToDB(normalizedName, phone);
      if (socketIo) {
        socketIo.emit('hdm:status_update', {
          sessionId: displayName, status: 'connected', phone
        });
        if (displayName === 'default') {
          socketIo.emit('hdm:ready', { phone });
          socketIo.emit('hdm:status', { connected: true, phone });
        }
      }
      resolve(client);
    });

    client.on('disconnected', async (reason) => {
      initializingSessions.delete(normalizedName);
      console.log(`⚠️ Disconnected [${displayName}]: ${reason}`);
      clientStatus.set(normalizedName, {
        connected: false, phone: null, qr: null, hasQR: false,
        sessionId: normalizedName, displayName
      });
      if (socketIo) {
        socketIo.emit('hdm:status_update', {
          sessionId: displayName, status: 'disconnected', reason
        });
      }
      if (reason === 'LOGGED_OUT') {
        await deleteAuthState(normalizedName);
        await removeSessionFromDB(normalizedName);
        clients.delete(normalizedName);
        console.log(`👋 Logged out: ${displayName}`);
        return;
      }
      if (process.env.AUTO_RECONNECT !== 'false') {
        console.log(`🔄 Reconnecting ${displayName} in 10s...`);
        setTimeout(async () => {
          try {
            await startClient(socketIo, normalizedName);
          } catch (err) {
            console.error(`❌ Reconnect failed [${displayName}]:`, err.message);
          }
        }, 10000);
      }
    });

    // Message handlers
    client.on('message', async (message) => {
      if (message.fromMe) return;
      await processSessionMessage(message, normalizedName, client, socketIo);
    });

    client.on('message_create', async (message) => {
      if (!message.fromMe) return;
      const botNumber = client.info?.wid?.user;
      const toNumber = message.to.split('@')[0];
      if (botNumber && botNumber === toNumber) {
        const { isCommandMessage } = require('./commandHandler');
        const isCommand = await isCommandMessage(message.body, displayName, true);
        if (isCommand) {
          await processSessionMessage(message, normalizedName, client, socketIo);
        }
      }
    });

    // Group events
    client.on('group_join', async (notification) => {
      const { handleGroupJoin } = require('./commandHandler');
      await handleGroupJoin(client, notification, displayName);
    });

    client.on('group_leave', async (notification) => {
      const { handleGroupLeave } = require('./commandHandler');
      await handleGroupLeave(client, notification, displayName);
    });

    console.log('⏳ Initializing...');
    client.initialize().catch(async (err) => {
      clearTimeout(initTimeout);
      initializingSessions.delete(normalizedName);
      console.error(`❌ Init error [${displayName}]:`, err.message);
      reject(err);
    });
  });
};

// ============================================
// RESTORE SESSIONS
// ============================================
const restoreAllSessions = async (socketIo) => {
  try {
    let sessionsToRestore = [];
    try {
      const Session = require('../models/Session');
      const dbSessions = await Session.find({ autoStart: true });
      sessionsToRestore = dbSessions
        .map(s => s.fullPath || normalizeSessionName(s.sessionId))
        .filter(id => getDisplayName(id) !== 'default');
    } catch {}
    
    if (sessionsToRestore.length === 0) {
      sessionsToRestore = getAllDiskSessions()
        .filter(id => getDisplayName(id) !== 'default');
    }
    
    if (sessionsToRestore.length === 0) {
      console.log('📭 No sessions to restore');
      return [];
    }
    
    const displayNames = sessionsToRestore.map(id => getDisplayName(id));
    console.log(`🔄 Restoring ${sessionsToRestore.length} session(s): ${displayNames.join(', ')}`);
    
    const restored = [];
    for (const sessionId of sessionsToRestore) {
      try {
        await startClient(socketIo, sessionId);
        restored.push(getDisplayName(sessionId));
      } catch (err) {
        console.log(`⚠️ Failed to restore "${getDisplayName(sessionId)}":`, err.message);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log(`📊 Restored ${restored.length}/${sessionsToRestore.length} sessions`);
    return restored;
  } catch (err) {
    console.error('❌ Restore failed:', err.message);
    return [];
  }
};

// ============================================
// GET ALL SESSIONS STATUS (NO HARDCODED DEFAULT)
// ============================================
const getAllSessionsStatus = async () => {
  const status = {};
  
  // Collect from memory (active clients)
  clientStatus.forEach((data, id) => {
    const displayName = getDisplayName(id);
    status[displayName] = {
      sessionId: displayName,
      name: displayName,
      fullPath: id,
      connected: data.connected || false,
      phone: data.phone || null,
      hasQR: data.hasQR || !!data.qr,
      qr: data.qr || null,
      initializing: initializingSessions.has(id)
    };
  });
  
  // Collect from disk
  const diskSessions = getAllDiskSessions();
  for (const id of diskSessions) {
    const displayName = getDisplayName(id);
    if (!status[displayName]) {
      status[displayName] = {
        sessionId: displayName,
        name: displayName,
        fullPath: id,
        connected: false,
        phone: null,
        hasQR: false,
        qr: null,
        saved: true,
        initializing: false
      };
    }
  }
  
  // Collect from database
  try {
    const Session = require('../models/Session');
    const dbSessions = await Session.find({});
    for (const sess of dbSessions) {
      const displayName = sess.sessionId;
      if (!status[displayName]) {
        status[displayName] = {
          sessionId: displayName,
          name: displayName,
          fullPath: sess.fullPath || normalizeSessionName(displayName),
          connected: false,
          phone: sess.phoneNumber || null,
          hasQR: false,
          qr: null,
          saved: true,
          autoStart: sess.autoStart ?? true,
          initializing: false
        };
      } else {
        status[displayName].saved = true;
        status[displayName].autoStart = sess.autoStart ?? true;
        if (!status[displayName].phone) {
          status[displayName].phone = sess.phoneNumber || null;
        }
      }
    }
  } catch (err) {
    // Ignore database errors
  }
  
  // ❌ NO HARDCODED DEFAULT - Only return actual sessions
  
  return status;
};

// ============================================
// PUBLIC API
// ============================================
const getSessionQR = (sessionId) => {
  const normalizedName = normalizeSessionName(sessionId);
  const status = clientStatus.get(normalizedName);
  return status?.qr || null;
};

const disconnectSession = async (sessionId, logout = false) => {
  const normalizedName = normalizeSessionName(sessionId);
  const displayName = getDisplayName(sessionId);
  const client = clients.get(normalizedName);
  
  if (client) {
    try {
      if (logout) {
        await client.logout();
        await deleteAuthState(normalizedName);
      } else {
        await client.destroy();
      }
      clients.delete(normalizedName);
      clientStatus.delete(normalizedName);
      if (logout) await removeSessionFromDB(normalizedName);
      console.log(`${logout ? '🚪 Logged out' : '🔌 Disconnected'}: ${displayName}`);
      return true;
    } catch (err) {
      console.error(`❌ Error disconnecting ${displayName}:`, err.message);
      return false;
    }
  }
  
  if (logout) {
    await deleteAuthState(normalizedName);
    await removeSessionFromDB(normalizedName);
  }
  
  return false;
};

const sendMessageFromSession = async (sessionId, to, text) => {
  const normalizedName = normalizeSessionName(sessionId);
  const displayName = getDisplayName(sessionId);
  const client = clients.get(normalizedName);
  if (!client) throw new Error(`Session "${displayName}" not found`);
  if (!clientStatus.get(normalizedName)?.connected) {
    throw new Error(`Session "${displayName}" not connected`);
  }
  let chatId = to;
  if (!to.includes('@c.us') && !to.includes('@g.us')) chatId = `${to}@c.us`;
  return await client.sendMessage(chatId, text);
};

const toggleSessionAutoStart = async (sessionId, autoStart) => {
  try {
    const Session = require('../models/Session');
    const displayName = getDisplayName(sessionId);
    await Session.findOneAndUpdate(
      { sessionId: displayName },
      { autoStart, sessionId: displayName },
      { upsert: true }
    );
    return true;
  } catch (err) {
    return false;
  }
};

const isClientConnected = (sessionId = 'default') => {
  const normalizedName = normalizeSessionName(sessionId);
  return clientStatus.get(normalizedName)?.connected || false;
};

// Legacy
const getConnectionStatus = () => {
  const s = clientStatus.get('RemoteAuth-default');
  return s?.connected ? { connected: true, phone: s.phone } : { connected: false, phone: null };
};
const sendMessage = (to, text) => sendMessageFromSession('default', to, text);
const disconnect = () => disconnectSession('default', false);
const getCurrentQR = () => clientStatus.get('RemoteAuth-default')?.qr || null;
const startDefaultClient = (io) => startClient(io, 'default');

// ============================================
// EXPORTS
// ============================================
module.exports = {
  startClient: startDefaultClient,
  startClientSession: startClient,
  restoreAllSessions,
  getConnectionStatus,
  getAllSessionsStatus,
  isClientConnected,
  getSessionQR,
  getCurrentQR,
  sendMessage,
  sendMessageFromSession,
  disconnect,
  disconnectSession,
  toggleSessionAutoStart,
  getAllDiskSessions,
  sessionExistsOnDisk,
  normalizeSessionName,
  getDisplayName,
  clients,
  clientStatus,
  initializingSessions,
};