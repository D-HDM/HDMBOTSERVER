const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false,
    },
    role: {
      type: String,
      enum: ['admin', 'mod', 'user'],
      default: 'user',
    },
    phoneNumber: {
      type: String,
      trim: true,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    loginCount: {
      type: Number,
      default: 0,
    },
    permissions: {
      canSendMessages: { type: Boolean, default: true },
      canManageCommands: { type: Boolean, default: false },
      canManageRules: { type: Boolean, default: false },
      canViewAnalytics: { type: Boolean, default: false },
      canManageUsers: { type: Boolean, default: false },
    },
    avatar: {
      type: String,
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Auto-set permissions based on role
userSchema.pre('save', function (next) {
  if (this.isModified('role')) {
    if (this.role === 'admin') {
      this.permissions = {
        canSendMessages: true,
        canManageCommands: true,
        canManageRules: true,
        canViewAnalytics: true,
        canManageUsers: true,
      };
    } else if (this.role === 'mod') {
      this.permissions = {
        canSendMessages: true,
        canManageCommands: true,
        canManageRules: true,
        canViewAnalytics: true,
        canManageUsers: false,
      };
    } else {
      this.permissions = {
        canSendMessages: true,
        canManageCommands: false,
        canManageRules: false,
        canViewAnalytics: false,
        canManageUsers: false,
      };
    }
  }
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Public JSON output (omit sensitive fields)
userSchema.methods.toPublicJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
