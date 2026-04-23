const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in environment');

  const options = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
  };

  try {
    await mongoose.connect(uri, options);
    logger.info('✅ MongoDB connected successfully');

    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected. Attempting reconnect...');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('✅ MongoDB reconnected');
    });

    mongoose.connection.on('error', (err) => {
      logger.error('❌ MongoDB error:', err.message);
    });
  } catch (err) {
    logger.error('❌ MongoDB connection failed:', err.message);
    throw err;
  }
};

module.exports = connectDB;
