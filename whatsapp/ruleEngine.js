'use strict';

const Rule = require('../models/Rule');
const logger = require('../utils/logger');

// ── In-memory cache ───────────────────────────────────────
let rulesCache = [];
let lastLoad = 0;
const CACHE_TTL = 15_000; // 15 seconds

// cooldownMap: `${ruleId}:${chatId}` → timestamp of last trigger
const cooldownMap = new Map();

// ============================================
// LOAD RULES
// ============================================
const loadRules = async () => {
  try {
    const rules = await Rule.find({ enabled: true })
      .sort({ priority: -1, createdAt: 1 })
      .lean();
    rulesCache = rules;
    lastLoad = Date.now();
    logger.info(`📜 Loaded ${rulesCache.length} auto-reply rules`);
  } catch (err) {
    logger.error(`Failed to load rules: ${err.message}`);
  }
  return rulesCache;
};

const getRules = async () => {
  if (Date.now() - lastLoad > CACHE_TTL) await loadRules();
  return rulesCache;
};

// ============================================
// MATCH LOGIC
// ============================================
const matchesRule = (rule, body) => {
  const text = rule.triggerFlags?.caseSensitive ? body : body.toLowerCase();
  const pattern = rule.triggerFlags?.caseSensitive
    ? rule.triggerValue
    : rule.triggerValue.toLowerCase();

  switch (rule.triggerType) {
    case 'exact':      return text === pattern;
    case 'startsWith': return text.startsWith(pattern);
    case 'endsWith':   return text.endsWith(pattern);
    case 'contains':   return text.includes(pattern);
    case 'regex': {
      try {
        const flags = rule.triggerFlags?.caseSensitive ? '' : 'i';
        return new RegExp(rule.triggerValue, flags).test(body);
      } catch { return false; }
    }
    default: return false;
  }
};

// ============================================
// PROCESS RULES FOR AN INCOMING MESSAGE
// ============================================
const processRules = async (client, msg, from, body, sessionId) => {
  const rules = await getRules();
  const isGroup = from.endsWith('@g.us');

  for (const rule of rules) {
    // Scope filter
    if (rule.scope === 'group' && !isGroup) continue;
    if (rule.scope === 'private' && isGroup) continue;

    // Session filter
    if (rule.sessionId && rule.sessionId !== sessionId) continue;

    if (!matchesRule(rule, body)) continue;

    // Cooldown check
    const cooldownKey = `${rule._id}:${from}`;
    const lastTriggered = cooldownMap.get(cooldownKey) || 0;
    const cooldownMs = (rule.cooldownSeconds || 0) * 1000;
    if (cooldownMs > 0 && Date.now() - lastTriggered < cooldownMs) continue;

    // Trigger rule
    cooldownMap.set(cooldownKey, Date.now());

    try {
      await client.sendMessage(from, rule.response);

      // Update trigger stats
      await Rule.findByIdAndUpdate(rule._id, {
        $inc: { timesTriggered: 1 },
        lastTriggeredAt: new Date(),
      }).catch(() => {});

      // Only first matching rule fires (stop = true is implied)
      break;
    } catch (err) {
      logger.error(`Rule "${rule.name}" send error: ${err.message}`);
    }
  }
};

module.exports = { loadRules, getRules, processRules };
