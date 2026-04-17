const mongoose = require('mongoose');

const botSettingSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    default: 'default',
    required: true,
    index: true
  },
  key: {
    type: String,
    required: true,
  },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound unique index: each session can have one of each key
botSettingSchema.index({ sessionId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('BotSetting', botSettingSchema);