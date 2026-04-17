require('dotenv').config();

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '7d',
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  API_URL: process.env.API_URL || 'http://localhost:5000',
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  SESSION_PATH: process.env.SESSION_PATH || './sessions',
  PUPPETEER_HEADLESS: process.env.PUPPETEER_HEADLESS !== 'false',
  AUTO_RECONNECT: process.env.AUTO_RECONNECT !== 'false',
  ADMIN_NUMBERS: (process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean),
  ENABLE_AI_COMMANDS: process.env.ENABLE_AI_COMMANDS !== 'false',
  ENABLE_BUG_COMMANDS: process.env.ENABLE_BUG_COMMANDS !== 'false',
};