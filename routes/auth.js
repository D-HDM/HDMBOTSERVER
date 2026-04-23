'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    const { email, password } = req.body;
    try {
      const user = await User.findOne({ email }).select('+password');
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }
      if (!user.isActive) {
        return res.status(403).json({ success: false, error: 'Account disabled' });
      }

      user.lastLogin = new Date();
      user.loginCount += 1;
      await user.save({ validateBeforeSave: false });

      const token = signToken(user._id);
      logger.info(`User login: ${email} | role: ${user.role}`);

      res.json({
        success: true,
        token,
        user: user.toPublicJSON(),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /api/auth/register (admin only after first user)
router.post(
  '/register',
  [
    body('name').trim().notEmpty().isLength({ max: 100 }),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('role').optional().isIn(['admin', 'mod', 'user']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const count = await User.countDocuments();
      // If users exist, only admins may register new users
      if (count > 0) {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer '))
          return res.status(401).json({ success: false, error: 'Admin token required' });

        const decoded = jwt.verify(authHeader.substring(7), process.env.JWT_SECRET);
        const requester = await User.findById(decoded.id);
        if (!requester || requester.role !== 'admin')
          return res.status(403).json({ success: false, error: 'Only admins can create users' });
      }

      const { name, email, password, role, phoneNumber } = req.body;
      const user = await User.create({
        name,
        email,
        password,
        role: count === 0 ? 'admin' : (role || 'user'),
        phoneNumber: phoneNumber || null,
      });

      const token = signToken(user._id);
      logger.info(`New user registered: ${email} | role: ${user.role}`);
      res.status(201).json({ success: true, token, user: user.toPublicJSON() });
    } catch (err) {
      if (err.code === 11000)
        return res.status(409).json({ success: false, error: 'Email already in use' });
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

// PUT /api/auth/me
router.put(
  '/me',
  protect,
  [
    body('name').optional().trim().notEmpty(),
    body('phoneNumber').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const allowed = ['name', 'phoneNumber', 'avatar', 'notes'];
      const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
      );
      const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
      res.json({ success: true, user: user.toPublicJSON() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// PUT /api/auth/change-password
router.put(
  '/change-password',
  protect,
  [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    try {
      const user = await User.findById(req.user._id).select('+password');
      if (!(await user.comparePassword(req.body.currentPassword)))
        return res.status(401).json({ success: false, error: 'Current password incorrect' });

      user.password = req.body.newPassword;
      await user.save();
      res.json({ success: true, message: 'Password updated' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /api/auth/users (admin only)
router.get('/users', protect, authorize('admin'), async (req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.json({ success: true, data: users.map((u) => u.toPublicJSON()) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/users/:id (admin only)
router.put('/users/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const allowed = ['name', 'role', 'isActive', 'phoneNumber', 'permissions'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/auth/users/:id (admin only)
router.delete('/users/:id', protect, authorize('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ success: false, error: 'Cannot delete yourself' });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
