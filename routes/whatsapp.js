const express = require('express');
const router = express.Router();
const { getConnectionStatus } = require('../whatsapp/client');
const { auth } = require('../middleware/auth');

router.get('/status', auth, (req, res) => {
  res.json({ success: true, data: getConnectionStatus() });
});

module.exports = router;