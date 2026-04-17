const express = require('express');
const router = express.Router();
const { auth, adminOnly } = require('../middleware/auth');
const Rule = require('../models/Rule');
const Command = require('../models/Command');
const Message = require('../models/Message');
const BotSetting = require('../models/BotSetting');

router.get('/full', auth, adminOnly, async (req, res) => {
  try {
    const [rules, commands, messages, settings] = await Promise.all([
      Rule.find().lean(),
      Command.find().lean(),
      Message.find().sort({ timestamp: -1 }).limit(5000).lean(),
      BotSetting.find().lean()
    ]);

    const settingsObj = {};
    settings.forEach(s => settingsObj[s.key] = s.value);

    res.json({
      success: true,
      data: {
        version: '2.0',
        exportDate: new Date().toISOString(),
        counts: {
          rules: rules.length,
          commands: commands.length,
          messages: messages.length
        },
        rules,
        commands,
        messages,
        settings: settingsObj
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;