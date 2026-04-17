const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  enabled: {
    type: Boolean,
    default: true,
  },
  trigger: {
    type: {
      type: String,
      enum: ['keyword', 'regex', 'always'],
      required: true,
    },
    value: String,
    caseSensitive: {
      type: Boolean,
      default: false,
    },
  },
  response: {
    type: String,
    required: true,
  },
  conditions: {
    onlyFrom: [String],
    groupOnly: Boolean,
    privateOnly: Boolean,
  },
  priority: {
    type: Number,
    default: 50,
  },
  timesTriggered: {
    type: Number,
    default: 0,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Rule', ruleSchema);