const mongoose = require('mongoose');

const botSettingSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: one key per session
botSettingSchema.index({ sessionId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('BotSetting', botSettingSchema);
