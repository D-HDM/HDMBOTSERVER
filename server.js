#!/usr/bin/env node

// ============================================
// SUPPRESS DEPRECATION WARNINGS
// ============================================
process.env.NODE_NO_WARNINGS = '1';
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning') return;
  console.warn(warning.name, warning.message);
});

// ============================================
// DNS CONFIGURATION
// ============================================
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);

console.log('🌐 DNS Configuration:', {
  order: dns.getDefaultResultOrder(),
  servers: dns.getServers()
});

// ============================================
// GLOBAL ERROR HANDLERS
// ============================================
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
});

console.log('🚀 Starting HDM Bot Server...');
console.log('📂 Working directory:', process.cwd());

// ============================================
// ENVIRONMENT VARIABLES
// ============================================
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// Import custom modules
const connectDB = require('./config/db');
const { limiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Import routes
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const ruleRoutes = require('./routes/rules');
const commandRoutes = require('./routes/commands');
const settingRoutes = require('./routes/settings');
const analyticsRoutes = require('./routes/analytics');
const whatsappRoutes = require('./routes/whatsapp');
const backupRoutes = require('./routes/backup');

// ============================================
// CONFIGURATION
// ============================================
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const API_URL = process.env.API_URL || `http://localhost:${PORT}`;
const BOT_NAME = process.env.BOT_NAME || 'HDM';
const BOT_VERSION = process.env.BOT_VERSION || '2.0.0';
const ADMIN_HASH = 'hashdm';

// Parse CORS origins from env ONLY (strict)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || CLIENT_URL)
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// ============================================
// HELPER: Normalize Session ID (remove session- prefix)
// ============================================
const normalizeSessionId = (sessionId) => {
  if (!sessionId) return sessionId;
  if (sessionId.startsWith('session-')) {
    const normalized = sessionId.substring(8);
    console.log(`📝 Normalized session ID: ${sessionId} -> ${normalized}`);
    return normalized;
  }
  return sessionId;
};

// ============================================
// INITIALIZE EXPRESS
// ============================================
const app = express();
const server = http.createServer(app);

// ============================================
// SOCKET.IO
// ============================================
const io = socketIO(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});

app.set('io', io);

// ============================================
// DATABASE CONNECTION & SERVER START
// ============================================
const startServer = async () => {
  try {
    console.log('📡 Waiting for MongoDB connection...');
    await connectDB();
    console.log('✅ MongoDB connected, proceeding with server startup');
  } catch (err) {
    console.error('❌ Fatal MongoDB error:', err.message);
    process.exit(1);
  }

  // ============================================
  // CORS MIDDLEWARE (Strict - Only from env)
  // ============================================
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key'],
  }));

  // ============================================
  // SECURITY MIDDLEWARE
  // ============================================
  app.use(helmet({
    contentSecurityPolicy: NODE_ENV === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
        connectSrc: ["'self'", "ws:", "wss:", ...CORS_ORIGINS],
        imgSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "https:", "data:"],
      },
    } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }));

  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(limiter);
  app.set('trust proxy', 1);

  // ============================================
  // STATIC FILES
  // ============================================
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/public', express.static(path.join(__dirname, 'public')));

  if (NODE_ENV === 'production') {
    const frontendDist = path.join(__dirname, '../frontend/dist');
    if (fs.existsSync(frontendDist)) {
      app.use(express.static(frontendDist));
      console.log('📦 Serving frontend from:', frontendDist);
    }
  }

  // ============================================
  // CONSOLE COLORS
  // ============================================
  const c = {
    reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
    cyan: '\x1b[36m', gray: '\x1b[90m', blue: '\x1b[34m', magenta: '\x1b[35m',
  };

  // ============================================
  // REQUEST LOGGING
  // ============================================
  const visitLogs = [];
  const MAX_LOGS = 1000;

  app.use((req, res, next) => {
    const start = Date.now();
    const clientIp = req.ip || req.connection.remoteAddress;
    
    const visit = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: clientIp,
      userAgent: req.get('User-Agent')?.substring(0, 100),
    };
    visitLogs.unshift(visit);
    if (visitLogs.length > MAX_LOGS) visitLogs.pop();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const color = status >= 400 ? c.red : status >= 300 ? c.yellow : c.green;
      
      if (req.path === '/test' || req.path.startsWith('/public/')) return;
      
      console.log(
        `${c.cyan}${req.method.padEnd(6)}${c.reset} ` +
        `${req.path.padEnd(30)} ` +
        `${color}${status}${c.reset} ` +
        `${c.gray}${duration}ms${c.reset} ` +
        `${c.gray}${clientIp}${c.reset}`
      );
      
      if (NODE_ENV === 'production') {
        logger.info(`${req.method} ${req.path} ${status} ${duration}ms`, { ip: clientIp });
      }
    });
    
    next();
  });

  // ============================================
  // PUBLIC ROUTES
  // ============================================
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      bot: BOT_NAME,
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { connected: mongoose.connection.readyState === 1 },
    });
  });

  app.get('/', (req, res) => {
    res.json({
      success: true,
      message: `🤖 ${BOT_NAME} Bot API`,
      version: BOT_VERSION,
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      endpoints: { health: '/health', api: '/api', test: '/test' },
    });
  });

  app.get('/api', (req, res) => {
    res.json({
      success: true,
      message: `${BOT_NAME} Bot API`,
      version: BOT_VERSION,
      routes: {
        auth: '/api/auth', messages: '/api/messages', rules: '/api/rules',
        commands: '/api/commands', settings: '/api/settings', analytics: '/api/analytics',
        whatsapp: '/api/whatsapp', backup: '/api/backup',
      },
    });
  });

  app.get('/test', (req, res) => {
    const testPath = path.join(__dirname, 'public', 'test.html');
    if (fs.existsSync(testPath)) res.sendFile(testPath);
    else res.status(404).json({ error: 'test.html not found' });
  });

  // ============================================
  // LOGS ENDPOINT
  // ============================================
  app.get('/logs/visits', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== ADMIN_HASH && apiKey !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { limit = 100 } = req.query;
    res.json({ success: true, logs: visitLogs.slice(0, parseInt(limit)), total: visitLogs.length });
  });

  // ============================================
  // ADMIN ROUTES
  // ============================================
  const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    if (apiKey === ADMIN_HASH || apiKey === process.env.ADMIN_PASSWORD) return next();
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.substring(7), process.env.JWT_SECRET);
        req.user = decoded;
        return next();
      } catch (err) {}
    }
    res.status(401).json({ success: false, error: 'Unauthorized' });
  };

  app.get('/api/admin/status', adminAuth, async (req, res) => {
    const { getAllSessionsStatus } = require('./whatsapp/client');
    const sessionsStatus = await getAllSessionsStatus();
    res.json({
      success: true,
      server: { uptime: process.uptime(), platform: process.platform, memory: process.memoryUsage(), port: PORT, nodeVersion: process.version },
      database: { connected: mongoose.connection.readyState === 1 },
      whatsapp: sessionsStatus,
      logs: { total: visitLogs.length },
    });
  });

  app.post('/api/admin/restart', adminAuth, (req, res) => {
    res.json({ success: true, message: 'Server restart initiated' });
    setTimeout(() => process.exit(0), 1000);
  });

  app.post('/api/admin/stop', adminAuth, (req, res) => {
    res.json({ success: true, message: 'Server stopping' });
    setTimeout(() => process.exit(0), 500);
  });

  app.delete('/api/admin/sessions', adminAuth, (req, res) => {
    try {
      const sessionPath = process.env.SESSION_PATH || path.join(__dirname, 'sessions');
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        fs.mkdirSync(sessionPath, { recursive: true });
      }
      res.json({ success: true, message: 'Sessions cleared' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================
  // SESSION MANAGEMENT API
  // ============================================
  app.post('/api/sessions/toggle-autostart', adminAuth, async (req, res) => {
    try {
      const { sessionId, autoStart } = req.body;
      const { toggleSessionAutoStart } = require('./whatsapp/client');
      const result = await toggleSessionAutoStart(sessionId, autoStart);
      res.json({ success: result, message: `Auto-start ${autoStart ? 'enabled' : 'disabled'} for ${sessionId}` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/sessions', adminAuth, async (req, res) => {
    try {
      const { getAllSessionsStatus } = require('./whatsapp/client');
      const sessions = await getAllSessionsStatus();
      res.json({ success: true, sessions });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================
  // API ROUTES
  // ============================================
  app.use('/api/auth', authRoutes);
  app.use('/api/messages', messageRoutes);
  app.use('/api/rules', ruleRoutes);
  app.use('/api/commands', commandRoutes);
  app.use('/api/settings', settingRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/backup', backupRoutes);

  // ============================================
  // FRONTEND CATCH-ALL
  // ============================================
  if (NODE_ENV === 'production') {
    const frontendIndex = path.join(__dirname, '../frontend/dist/index.html');
    app.get('*', (req, res) => {
      if (fs.existsSync(frontendIndex) && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
        res.sendFile(frontendIndex);
      } else {
        res.status(404).json({ success: false, error: 'Route not found' });
      }
    });
  }

  // ============================================
  // 404 HANDLER
  // ============================================
  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', path: req.path });
  });

  app.use(errorHandler);

  // ============================================
  // SOCKET.IO EVENTS (MULTI-SESSION)
  // ============================================
  const { 
    startClient, 
    getAllSessionsStatus, 
    disconnectSession, 
    sendMessageFromSession,
    getCurrentQR,
    restoreAllSessions,
    toggleSessionAutoStart
  } = require('./whatsapp/client');
  const { executeCommand, loadCommandsFromDB, getCurrentPrefix } = require('./whatsapp/commandHandler');
  const { loadRules } = require('./whatsapp/ruleEngine');
  const Message = require('./models/Message');

  const connectedSockets = new Map();

  io.on('connection', (socket) => {
    const socketId = socket.id;
    const clientIp = socket.handshake.address;
    connectedSockets.set(socketId, { id: socketId, ip: clientIp, connectedAt: new Date() });
    
    console.log(`\n${c.green}🔌 FRONTEND CONNECTED${c.reset} [${socketId}] from ${clientIp}`);

    // Send initial sessions status
    getAllSessionsStatus().then(status => {
      socket.emit('hdm:sessions_status', status);
    });

    // ============================================
    // GET EXISTING QR FOR DEFAULT SESSION (PAGE REFRESH)
    // ============================================
    socket.on('hdm:get_qr', (callback) => {
      console.log(`${c.blue}📱 GET_QR REQUESTED${c.reset} by [${socketId}]`);
      const qr = getCurrentQR();
      if (callback && typeof callback === 'function') {
        callback({ qr: qr || null });
      }
    });

    // ============================================
    // LEGACY SINGLE-SESSION CONNECT (for dashboard)
    // ============================================
    socket.on('hdm:connect', async () => {
      console.log(`${c.blue}📱 LEGACY CONNECT REQUESTED${c.reset} by [${socketId}]`);
      try {
        await startClient(io);
        const status = await getAllSessionsStatus();
        io.emit('hdm:sessions_status', status);
      } catch (error) {
        socket.emit('hdm:error', { action: 'connect', message: error.message });
      }
    });

    socket.on('hdm:disconnect_wa', async () => {
      await disconnectSession('default');
      const status = await getAllSessionsStatus();
      io.emit('hdm:sessions_status', status);
    });

    // ============================================
    // MULTI-SESSION HANDLERS (WITH NORMALIZATION)
    // ============================================
    socket.on('hdm:connect_session', async ({ sessionId }, callback) => {
      // STRIP 'session-' PREFIX IF PRESENT
      const cleanSessionId = normalizeSessionId(sessionId);
      
      if (cleanSessionId !== sessionId) {
        console.log(`${c.blue}📝 Stripped prefix: ${sessionId} -> ${cleanSessionId}${c.reset}`);
      }
      
      console.log(`${c.blue}📱 CONNECT SESSION REQUESTED${c.reset} [${socketId}] for session: ${cleanSessionId}`);
      try {
        const { startClientSession } = require('./whatsapp/client');
        await startClientSession(io, cleanSessionId);
        if (callback) callback({ success: true, sessionId: cleanSessionId });
        const status = await getAllSessionsStatus();
        io.emit('hdm:sessions_status', status);
      } catch (error) {
        console.error(`${c.red}❌ Session connect error:${c.reset}`, error.message);
        if (callback) callback({ success: false, error: error.message });
      }
    });

    socket.on('hdm:get_sessions_status', async (callback) => {
      const status = await getAllSessionsStatus();
      if (callback) callback(status);
      else socket.emit('hdm:sessions_status', status);
    });

    socket.on('hdm:disconnect_session', async ({ sessionId }, callback) => {
      const cleanSessionId = normalizeSessionId(sessionId);
      console.log(`${c.red}🔌 DISCONNECT SESSION${c.reset} [${socketId}] for session: ${cleanSessionId}`);
      try {
        const result = await disconnectSession(cleanSessionId);
        if (callback) callback({ success: result, sessionId: cleanSessionId });
        const status = await getAllSessionsStatus();
        io.emit('hdm:sessions_status', status);
      } catch (error) {
        if (callback) callback({ success: false, error: error.message });
      }
    });

    socket.on('hdm:send_message_session', async ({ sessionId, to, message }, callback) => {
      const cleanSessionId = normalizeSessionId(sessionId);
      console.log(`${c.magenta}📤 SESSION MESSAGE${c.reset} [${cleanSessionId}] to ${to}`);
      try {
        const result = await sendMessageFromSession(cleanSessionId, to, message);
        await Message.create({ 
          messageId: result.id.id, 
          to, 
          body: message, 
          direction: 'outgoing', 
          status: 'sent',
          sessionId: cleanSessionId 
        });
        if (callback) callback({ success: true, messageId: result.id.id });
      } catch (error) {
        console.error(`${c.red}❌ Send error:${c.reset}`, error.message);
        if (callback) callback({ success: false, error: error.message });
      }
    });

    socket.on('hdm:toggle_autostart', async ({ sessionId, autoStart }, callback) => {
      const cleanSessionId = normalizeSessionId(sessionId);
      console.log(`${c.blue}🔧 TOGGLE AUTOSTART${c.reset} [${socketId}] for session: ${cleanSessionId} -> ${autoStart}`);
      try {
        const result = await toggleSessionAutoStart(cleanSessionId, autoStart);
        if (callback) callback({ success: result });
      } catch (error) {
        if (callback) callback({ success: false, error: error.message });
      }
    });

    // ============================================
    // COMMAND AND RULE HANDLERS
    // ============================================
    socket.on('hdm:get_status', (callback) => {
      const { getConnectionStatus } = require('./whatsapp/client');
      const status = getConnectionStatus();
      if (typeof callback === 'function') callback(status);
      else socket.emit('hdm:status', status);
    });

    socket.on('hdm:reload_commands', async (callback) => {
      try {
        await loadCommandsFromDB();
        io.emit('hdm:commands_reloaded');
        callback?.({ success: true });
      } catch (error) {
        callback?.({ success: false, error: error.message });
      }
    });

    socket.on('hdm:reload_rules', async (callback) => {
      try {
        await loadRules();
        io.emit('hdm:rules_reloaded');
        callback?.({ success: true });
      } catch (error) {
        callback?.({ success: false, error: error.message });
      }
    });

    socket.on('disconnect', (reason) => {
      connectedSockets.delete(socketId);
      console.log(`${c.red}🔌 FRONTEND DISCONNECTED${c.reset} [${socketId}] - ${reason}`);
    });
  });

  // ============================================
  // START SERVER
  // ============================================
server.listen(PORT, async () => {
    // Use a static default for the banner (simpler and reliable)
    const prefixDisplay = '.';
    
    console.log(`
${c.green}╔══════════════════════════════════════════════════════════╗
║                                                          ║
║      🚀 HDM Bot Server Started Successfully              ║
║                                                          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  🌐 Server:      ${API_URL}${' '.repeat(Math.max(0, 43 - API_URL.length))}║
║  📊 API:         ${API_URL}/api${' '.repeat(Math.max(0, 41 - API_URL.length))}║
║  💚 Health:      ${API_URL}/health${' '.repeat(Math.max(0, 37 - API_URL.length))}║
║  🧪 Test:        ${API_URL}/test${' '.repeat(Math.max(0, 39 - API_URL.length))}║
║  🔐 Admin:       ${API_URL}/api/admin/status${' '.repeat(Math.max(0, 33 - API_URL.length))}║
║                                                          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  📱 WhatsApp:    Multi-session ready                     ║
║  📊 Environment: ${(NODE_ENV).padEnd(43)}║
║  🗄️  Database:    ${mongoose.connection.readyState === 1 ? 'Connected'.padEnd(43) : 'Disconnected'.padEnd(43)}║
║  🌍 CORS:        ${CORS_ORIGINS.join(', ').substring(0, 43).padEnd(43)}║
║  🔧 Commands:    ${prefixDisplay} (default) prefix ready            ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝${c.reset}
    `);
    
    // ============================================
    // AUTO-RESTORE SESSIONS AFTER SERVER START
    // ============================================
    console.log('\n🔄 Checking for saved sessions to restore...');
    setTimeout(async () => {
      try {
        await restoreAllSessions(io);
      } catch (err) {
        console.error('❌ Failed to restore sessions:', err.message);
      }
    }, 3000);
  });

  // ============================================
  // GRACEFUL SHUTDOWN
  // ============================================
  const gracefulShutdown = (signal) => {
    console.log(`\n${c.yellow}📴 ${signal} received. Shutting down...${c.reset}`);
    server.close(async () => {
      console.log('✅ HTTP server closed');
      try { await mongoose.connection.close(false); console.log('✅ MongoDB connection closed'); } catch (err) {}
      // Disconnect all sessions
      const { clients } = require('./whatsapp/client');
      for (const [sessionId, client] of clients) {
        try { await client.destroy(); } catch (err) {}
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
};

// ============================================
// START
// ============================================
startServer().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});

module.exports = { app, server, io };