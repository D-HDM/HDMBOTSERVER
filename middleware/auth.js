const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Verify JWT and attach user to req.user
 */
const protect = async (req, res, next) => {
  let token;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account disabled' });
    }
    req.user = user;
    next();
  } catch (err) {
    logger.warn(`Auth failure: ${err.message} | IP: ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

/**
 * Role-based access control
 * Usage: authorize('admin', 'superadmin')
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: `Access denied. Required role: ${roles.join(' or ')}`,
    });
  }
  next();
};

/**
 * Allow admin via API key header (for server-to-server or dashboard calls)
 */
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.key;
  const validKeys = [process.env.ADMIN_HASH, process.env.ADMIN_PASSWORD].filter(Boolean);
  if (validKeys.includes(apiKey)) {
    req.user = { role: 'admin', isApiKey: true };
    return next();
  }
  return res.status(401).json({ success: false, error: 'Invalid API key' });
};

/**
 * Combined: accept either JWT or API key
 */
const flexAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.key;
  const validKeys = [process.env.ADMIN_HASH, process.env.ADMIN_PASSWORD].filter(Boolean);

  if (apiKey && validKeys.includes(apiKey)) {
    req.user = { role: 'admin', isApiKey: true };
    return next();
  }

  return protect(req, res, next);
};

module.exports = { protect, authorize, apiKeyAuth, flexAuth };
