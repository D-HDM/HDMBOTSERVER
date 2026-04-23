const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Rule name is required'],
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      default: '',
      maxlength: 500,
    },
    // Trigger configuration
    triggerType: {
      type: String,
      enum: ['contains', 'startsWith', 'endsWith', 'exact', 'regex'],
      default: 'contains',
    },
    triggerValue: {
      type: String,
      required: [true, 'Trigger value is required'],
    },
    triggerFlags: {
      caseSensitive: { type: Boolean, default: false },
    },
    // Response configuration
    responseType: {
      type: String,
      enum: ['text', 'media', 'reaction', 'forward'],
      default: 'text',
    },
    response: {
      type: String,
      required: [true, 'Response is required'],
    },
    // Scope
    scope: {
      type: String,
      enum: ['all', 'group', 'private'],
      default: 'all',
    },
    // Cooldown (seconds) per chat
    cooldownSeconds: {
      type: Number,
      default: 30,
    },
    // Session scope (null = all sessions)
    sessionId: {
      type: String,
      default: null,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    priority: {
      type: Number,
      default: 0,
    },
    timesTriggered: {
      type: Number,
      default: 0,
    },
    lastTriggeredAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

ruleSchema.index({ enabled: 1, priority: -1 });
ruleSchema.index({ sessionId: 1, enabled: 1 });

module.exports = mongoose.model('Rule', ruleSchema);
