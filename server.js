#!/usr/bin/env node
'use strict';

process.env.NODE_NO_WARNINGS = '1';
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning') console.warn(w.name, w.message); });

const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);

process.on('uncaughtException',  (err) => console.error('❌ UNCAUGHT EXCEPTION:', err.message, err.stack));
process.on('unhandledRejection', (r)   => console.error('❌ UNHANDLED REJECTION:', r));

console.log('🚀 Starting HDM Bot Server…');
require('dotenv').config();

const express     = require('express');
const http        = require('http');
const socketIO    = require('socket.io');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const mongoose    = require('mongoose');

const connectDB       = require('./config/db');
const { limiter }     = require('./middleware/rateLimiter');
const errorHandler    = require('./middleware/errorHandler');
const logger          = require('./utils/logger');

const authRoutes      = require('./routes/auth');
const messageRoutes   = require('./routes/messages');
const ruleRoutes      = require('./routes/rules');
const commandRoutes   = require('./routes/commands');
const settingRoutes   = require('./routes/settings');
const analyticsRoutes = require('./routes/analytics');
const whatsappRoutes  = require('./routes/whatsapp');
const backupRoutes    = require('./routes/backup');

const NODE_ENV    = process.env.NODE_ENV || 'development';
const PORT        = process.env.PORT || 5000;
const CLIENT_URL  = process.env.CLIENT_URL || 'http://localhost:5173';
const API_URL     = process.env.API_URL || `http://localhost:${PORT}`;
const BOT_NAME    = process.env.BOT_NAME || 'HDM';
const BOT_VERSION = process.env.BOT_VERSION || '2.0.0';
const ADMIN_HASH  = process.env.ADMIN_HASH || 'hashdm';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || CLIENT_URL)
  .split(',').map((o) => o.trim()).filter(Boolean);

const normalizeSessionId = (sid) => {
  if (!sid) return sid;
  return String(sid).startsWith('session-') ? String(sid).substring(8) : sid;
};

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: CORS_ORIGINS, methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'], credentials: true },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});
app.set('io', io);

const startServer = async () => {
  logger.info('📡 Connecting to MongoDB…');
  await connectDB();

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
      logger.warn(`CORS blocked: ${origin}`);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','X-API-Key'],
  }));

  app.use(helmet({
    contentSecurityPolicy: NODE_ENV === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'", 'https://cdn.socket.io'],
        connectSrc: ["'self'", 'ws:', 'wss:', ...CORS_ORIGINS],
        imgSrc:     ["'self'", 'data:', 'https:'],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        fontSrc:    ["'self'", 'https:', 'data:'],
      },
    } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(limiter);
  app.set('trust proxy', 1);

  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/public',  express.static(path.join(__dirname, 'public')));
  if (NODE_ENV === 'production') {
    const dist = path.join(__dirname, '../frontend/dist');
    if (fs.existsSync(dist)) app.use(express.static(dist));
  }

  const visitLogs = [];
  app.use((req, res, next) => {
    const start = Date.now();
    visitLogs.unshift({ timestamp: new Date().toISOString(), method: req.method, path: req.path, ip: req.ip });
    if (visitLogs.length > 1000) visitLogs.pop();
    res.on('finish', () => {
      if (req.path === '/health' || req.path.startsWith('/public/')) return;
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now()-start}ms`, { ip: req.ip });
    });
    next();
  });

  const adminAuth = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if ([ADMIN_HASH, process.env.ADMIN_PASSWORD].filter(Boolean).includes(key)) return next();
    try {
      const jwt  = require('jsonwebtoken');
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const d = jwt.verify(auth.substring(7), process.env.JWT_SECRET);
        req.user = d; return next();
      }
    } catch {}
    res.status(401).json({ success: false, error: 'Unauthorized' });
  };

  app.get('/', (_q, r) => r.json({ success: true, message: `🤖 ${BOT_NAME} Bot API`, version: BOT_VERSION, environment: NODE_ENV, timestamp: new Date().toISOString() }));
  app.get('/health', (_q, r) => r.json({ status: 'ok', bot: BOT_NAME, environment: NODE_ENV, timestamp: new Date().toISOString(), uptime: process.uptime(), database: { connected: mongoose.connection.readyState === 1 } }));
  app.get('/api', (_q, r) => r.json({ success: true, message: `${BOT_NAME} API`, version: BOT_VERSION, routes: { auth:'/api/auth', messages:'/api/messages', rules:'/api/rules', commands:'/api/commands', settings:'/api/settings', analytics:'/api/analytics', whatsapp:'/api/whatsapp', backup:'/api/backup' } }));
  app.get('/test', (_q, r) => { const p = path.join(__dirname,'public','test.html'); if (fs.existsSync(p)) return r.sendFile(p); r.status(404).json({ error: 'test.html not found' }); });
  app.get('/logs/visits', adminAuth, (req, res) => { const lim = parseInt(req.query.limit)||100; res.json({ success: true, logs: visitLogs.slice(0, lim), total: visitLogs.length }); });

  app.get('/api/admin/status', adminAuth, async (_q, r) => {
    const { getAllSessionsStatus } = require('./whatsapp/client');
    r.json({ success: true, server: { uptime: process.uptime(), platform: process.platform, memory: process.memoryUsage(), port: PORT, nodeVersion: process.version }, database: { connected: mongoose.connection.readyState === 1 }, whatsapp: await getAllSessionsStatus() });
  });
  app.post('/api/admin/restart', adminAuth, (req, res) => { res.json({ success: true, message: 'Restarting' }); setTimeout(() => process.exit(0), 1000); });
  app.post('/api/admin/stop',    adminAuth, (req, res) => { res.json({ success: true, message: 'Stopping'  }); setTimeout(() => process.exit(0), 500); });
  app.delete('/api/admin/sessions', adminAuth, (req, res) => {
    const sp = process.env.SESSION_PATH || path.join(__dirname, 'sessions');
    if (fs.existsSync(sp)) { fs.rmSync(sp, { recursive: true, force: true }); fs.mkdirSync(sp, { recursive: true }); }
    res.json({ success: true, message: 'Sessions cleared' });
  });
  app.get('/api/sessions', adminAuth, async (_q, r) => { const { getAllSessionsStatus } = require('./whatsapp/client'); r.json({ success: true, sessions: await getAllSessionsStatus() }); });
  app.post('/api/sessions/toggle-autostart', adminAuth, async (req, res) => {
    const { toggleSessionAutoStart } = require('./whatsapp/client');
    const { sessionId, autoStart } = req.body;
    const ok = await toggleSessionAutoStart(normalizeSessionId(sessionId), autoStart);
    res.json({ success: ok });
  });

  app.use('/api/auth',      authRoutes);
  app.use('/api/messages',  messageRoutes);
  app.use('/api/rules',     ruleRoutes);
  app.use('/api/commands',  commandRoutes);
  app.use('/api/settings',  settingRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/whatsapp',  whatsappRoutes);
  app.use('/api/backup',    backupRoutes);

  if (NODE_ENV === 'production') {
    const idx = path.join(__dirname, '../frontend/dist/index.html');
    app.get('*', (req, res) => {
      if (fs.existsSync(idx) && !req.path.startsWith('/api') && !req.path.startsWith('/health')) return res.sendFile(idx);
      res.status(404).json({ success: false, error: 'Route not found' });
    });
  }
  app.use((req, res) => res.status(404).json({ success: false, error: 'Route not found', path: req.path }));
  app.use(errorHandler);

  // ── Socket.IO — delegated to socket.js ─────────────
  const { initSocket }        = require('./socket');
  const { restoreAllSessions } = require('./whatsapp/client');
  initSocket(io);

  // ── Listen ────────────────────────────────────────────
  server.listen(PORT, async () => {
    const line = '═'.repeat(56);
    console.log(`\n\x1b[32m╔${line}╗`);
    console.log(`║   🚀 HDM Bot v${BOT_VERSION} — Server Ready${' '.repeat(56 - 34 - BOT_VERSION.length)}║`);
    console.log(`╠${line}╣`);
    console.log(`║  🌐  ${(API_URL).padEnd(51)}║`);
    console.log(`║  💚  ${(API_URL+'/health').padEnd(51)}║`);
    console.log(`║  📊  ${(API_URL+'/api').padEnd(51)}║`);
    console.log(`╠${line}╣`);
    console.log(`║  📱 WhatsApp: Multi-session + Browserless${' '.repeat(56-44)}║`);
    console.log(`║  🤖 AI: DeepSeek · Gemini · GPT · Claude${' '.repeat(56-43)}║`);
    console.log(`║  🌍 Env: ${NODE_ENV.padEnd(47)}║`);
    console.log(`╚${line}╝\x1b[0m\n`);

    setTimeout(async () => {
      try { await restoreAllSessions(io); }
      catch (e) { logger.error('Session restore error:', e.message); }
    }, 3000);
  });

  // ── Graceful shutdown ─────────────────────────────────
  const shutdown = async (sig) => {
    logger.info(`📴 ${sig} — shutting down`);
    server.close(async () => {
      try { await mongoose.connection.close(false); } catch {}
      const { clients } = require('./whatsapp/client');
      for (const [, c] of clients) { try { await c.destroy(); } catch {} }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
};

startServer().catch((err) => { console.error('❌ Fatal startup error:', err); process.exit(1); });
module.exports = { app, server, io };
