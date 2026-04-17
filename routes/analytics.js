const express = require('express');
const router = express.Router();
const { getDashboardStats, getMessageAnalytics } = require('../controllers/analyticsController');
const { auth } = require('../middleware/auth');

router.get('/dashboard', auth, getDashboardStats);
router.get('/messages', auth, getMessageAnalytics);

module.exports = router;