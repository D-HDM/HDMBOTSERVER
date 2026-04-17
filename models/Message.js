const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
  },
  from: {
    type: String,
    required: function() {
      // from is required for incoming, optional for outgoing
      return this.direction === 'incoming';
    },
  },
  to: {
    type: String,
    required: function() {
      return this.direction === 'outgoing';
    },
  },
  body: {
    type: String,
    required: true,
  },
  direction: {
    type: String,
    enum: ['incoming', 'outgoing'],
    required: true,
  },
  isGroup: {
    type: Boolean,
    default: false,
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
    default: 'pending',
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

messageSchema.index({ from: 1, timestamp: -1 });
messageSchema.index({ to: 1, timestamp: -1 });
messageSchema.index({ direction: 1 });

module.exports = mongoose.model('Message', messageSchema);