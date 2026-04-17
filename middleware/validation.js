const { body, validationResult } = require('express-validator');

const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(v => v.run(req)));
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    res.status(400).json({
      success: false,
      errors: errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  };
};

const messageValidation = [
  body('to').notEmpty().withMessage('Recipient required'),
  body('message').notEmpty().withMessage('Message required').isLength({ max: 4096 }),
];

const ruleValidation = [
  body('name').notEmpty().isLength({ min: 3, max: 50 }),
  body('trigger.type').isIn(['keyword', 'regex', 'always']),
  body('trigger.value').notEmpty(),
  body('response').notEmpty(),
  body('priority').optional().isInt({ min: 1, max: 100 }),
];

const loginValidation = [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
];

const commandValidation = [
  body('name').matches(/^[a-z0-9_]+$/).withMessage('Invalid command name'),
  body('response').notEmpty(),
];

module.exports = {
  validate,
  messageValidation,
  ruleValidation,
  loginValidation,
  commandValidation,
};