'use strict';

/**
 * Format a phone number — strip all non-digits
 */
const formatNumber = (number) => String(number).replace(/[^0-9]/g, '');

/**
 * Extract the phone number from a WhatsApp JID
 */
const getUserNumber = (jid) => (jid || '').split('@')[0];

/**
 * Pause execution for ms milliseconds
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Format milliseconds into a human-readable string
 */
const formatDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

/**
 * Chunk an array into batches
 */
const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

/**
 * Sanitize text for safe WhatsApp delivery (strip non-printable chars)
 */
const sanitizeText = (text) =>
  String(text || '').replace(/[^\x20-\x7E\n\r\t\u00A0-\uFFFF]/g, '');

/**
 * Parse a time string like "10m", "1h", "30s" into milliseconds
 */
const parseTimeString = (timeStr) => {
  if (!timeStr) return null;
  const match = String(timeStr).match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * (multipliers[unit] || 0);
};

/**
 * Generate a simple random alphanumeric ID
 */
const generateId = (length = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

/**
 * Safely JSON parse — returns fallback on error
 */
const safeJsonParse = (str, fallback = null) => {
  try { return JSON.parse(str); } catch { return fallback; }
};

module.exports = {
  formatNumber,
  getUserNumber,
  sleep,
  formatDuration,
  chunkArray,
  sanitizeText,
  parseTimeString,
  generateId,
  safeJsonParse,
};
