const express = require('express');
const router = express.Router();
const { getCommands, createCommand, updateCommand, deleteCommand } = require('../controllers/commandController');
const { auth, adminOnly } = require('../middleware/auth');

router.get('/', auth, getCommands);
router.post('/', auth, adminOnly, createCommand);
router.put('/:id', auth, adminOnly, updateCommand);
router.delete('/:id', auth, adminOnly, deleteCommand);

module.exports = router;