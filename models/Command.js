// Add this field to Command.js if you want to track which session used commands
const mongoose = require('mongoose');

const commandSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  description: String,
  response: {
    type: String,
    required: true,
  },
  aliases: [String],
  category: {
    type: String,
    enum: ['general', 'ai', 'bug', 'settings', 'custom'],
    default: 'general',
  },
  enabled: {
    type: Boolean,
    default: true,
  },
  adminOnly: {
    type: Boolean,
    default: false,
  },
  timesUsed: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  // Optional: track per session usage
  usageBySession: {
    type: Map,
    of: Number,
    default: {}
  }
});

module.exports = mongoose.model('Command', commandSchema);