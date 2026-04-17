const express = require('express');
const router = express.Router();
const { 
  sendMessage, 
  getMessages, 
  getMessageStats,
  importMessages 
} = require('../controllers/messageController');
const { auth, adminOnly } = require('../middleware/auth');
const { validate, messageValidation } = require('../middleware/validation');
const { messageLimiter } = require('../middleware/rateLimiter');

// All routes require authentication
router.use(auth);

// Send a message
router.post('/send', messageLimiter, validate(messageValidation), sendMessage);

// Get messages with pagination
router.get('/', getMessages);

// Get message statistics
router.get('/stats', getMessageStats);

// Import messages from backup (admin only)
router.post('/import', adminOnly, importMessages);

module.exports = router;