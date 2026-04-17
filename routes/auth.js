const express = require('express');
const router = express.Router();
const { login, verify, changePassword } = require('../controllers/authController');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validation');

// Validation for login
const loginValidation = [
  require('express-validator').body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Valid email is required'),
  require('express-validator').body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

router.post('/login', validate(loginValidation), login);
router.get('/verify', auth, verify);
router.post('/change-password', auth, changePassword);

module.exports = router;