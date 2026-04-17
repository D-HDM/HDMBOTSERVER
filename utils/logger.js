const winston = require('winston');
const path = require('path');

const logDir = process.env.LOG_DIR || './logs';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: (parseInt(process.env.LOG_MAX_SIZE_MB) || 20) * 1024 * 1024,
      maxFiles: process.env.LOG_MAX_FILES || 7,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: (parseInt(process.env.LOG_MAX_SIZE_MB) || 20) * 1024 * 1024,
      maxFiles: process.env.LOG_MAX_FILES || 7,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }));
}

module.exports = logger;