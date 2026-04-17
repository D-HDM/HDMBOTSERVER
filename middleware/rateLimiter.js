const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV === 'development';

// General API rate limiter
const limiter = rateLimit({
  windowMs: isDev ? 60 * 1000 : (parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000), // 1 min in dev, 15 min in prod
  max: isDev ? 1000 : (parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100),
  message: {
    success: false,
    error: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
  // Skip rate limiting for health checks and test page
  skip: (req) => {
    return req.path === '/health' || req.path === '/test' || req.path.startsWith('/public');
  },
});

// Stricter limiter for message sending
const messageLimiter = rateLimit({
  windowMs: isDev ? 10 * 1000 : 60 * 1000, // 10 seconds in dev, 1 minute in prod
  max: isDev ? 100 : (parseInt(process.env.MESSAGE_RATE_LIMIT_PER_MINUTE) || 30),
  message: {
    success: false,
    error: 'Message rate limit exceeded. Please slow down.',
  },
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
});

// Stricter limiter for login attempts
const authLimiter = rateLimit({
  windowMs: isDev ? 60 * 1000 : (15 * 60 * 1000), // 1 minute in dev, 15 minutes in prod
  max: isDev ? 100 : 5, // 100 attempts in dev, 5 in prod
  message: {
    success: false,
    error: 'Too many login attempts, please try again later.',
  },
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    return req.ip;
  },
});

module.exports = { 
  limiter, 
  messageLimiter, 
  authLimiter 
};