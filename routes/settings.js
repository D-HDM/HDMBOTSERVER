const express = require('express');
const router = express.Router();
const { getSettings, updateSetting, getSetting } = require('../controllers/settingController');
const { auth, adminOnly } = require('../middleware/auth');

router.get('/', auth, getSettings);
router.get('/:key', auth, getSetting);
router.put('/', auth, adminOnly, updateSetting);

module.exports = router;