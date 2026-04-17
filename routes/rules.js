const express = require('express');
const router = express.Router();
const { getRules, createRule, updateRule, deleteRule, toggleRule } = require('../controllers/ruleController');
const { auth } = require('../middleware/auth');
const { validate, ruleValidation } = require('../middleware/validation');

router.get('/', auth, getRules);
// Temporarily remove validation
router.post('/', auth, createRule);  // Removed: validate(ruleValidation)
router.put('/:id', auth, updateRule);  // Removed: validate(ruleValidation)
router.delete('/:id', auth, deleteRule);
router.patch('/:id/toggle', auth, toggleRule);

module.exports = router;