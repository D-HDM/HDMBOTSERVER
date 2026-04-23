const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      index: true,
      default: null,
    },
    sessionId: {
      type: String,
      default: 'default',
      index: true,
    },
    from: {
      type: String,
      default: null,
    },
    to: {
      type: String,
      default: null,
    },
    body: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'other'],
      default: 'text',
    },
    direction: {
      type: String,
      enum: ['incoming', 'outgoing'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
      default: 'pending',
    },
    isGroup: {
      type: Boolean,
      default: false,
    },
    groupId: {
      type: String,
      default: null,
    },
    hasMedia: {
      type: Boolean,
      default: false,
    },
    mediaUrl: {
      type: String,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    originalBody: {
      type: String,
      default: null,
    },
    isCommand: {
      type: Boolean,
      default: false,
    },
    commandName: {
      type: String,
      default: null,
    },
    quotedMessageId: {
      type: String,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
messageSchema.index({ sessionId: 1, timestamp: -1 });
messageSchema.index({ from: 1, sessionId: 1 });
messageSchema.index({ groupId: 1, timestamp: -1 });
messageSchema.index({ isCommand: 1, sessionId: 1 });

module.exports = mongoose.model('Message', messageSchema);
