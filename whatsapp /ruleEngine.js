const Rule = require('../models/Rule');

let rulesCache = [];
let lastLoad = 0;
const CACHE_TTL = 30000; // 30 seconds

const loadRules = async () => {
  const now = Date.now();
  if (now - lastLoad > CACHE_TTL) {
    try {
      rulesCache = await Rule.find({ enabled: true }).sort({ priority: -1 });
      lastLoad = now;
      console.log(`📋 Loaded ${rulesCache.length} auto-reply rules`);
    } catch (err) {
      console.error('❌ Failed to load rules:', err.message);
    }
  }
  return rulesCache;
};

const checkRuleConditions = (rule, from, isGroup) => {
  if (!rule.enabled) return false;
  if (rule.conditions?.groupOnly && !isGroup) return false;
  if (rule.conditions?.privateOnly && isGroup) return false;
  
  if (rule.conditions?.onlyFrom?.length) {
    const senderNumber = from.replace(/@[cg]\.us$/, '');
    if (!rule.conditions.onlyFrom.includes(senderNumber)) return false;
  }
  return true;
};

const matchRuleTrigger = (rule, body) => {
  const trigger = rule.trigger || {};
  if (trigger.type === 'always') return true;
  
  if (trigger.type === 'keyword') {
    const content = trigger.caseSensitive ? body : body.toLowerCase();
    const keyword = trigger.caseSensitive ? trigger.value : trigger.value.toLowerCase();
    return content.includes(keyword);
  }
  
  if (trigger.type === 'regex') {
    try {
      const flags = trigger.caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(trigger.value, flags);
      return regex.test(body);
    } catch {
      return false;
    }
  }
  return false;
};

const processRules = async (message, from, isGroup) => {
  const rules = await loadRules();
  const body = message.body;
  
  for (const rule of rules) {
    if (!checkRuleConditions(rule, from, isGroup)) continue;
    if (matchRuleTrigger(rule, body)) {
      console.log(`✅ Rule matched: ${rule.name}`);
      try {
        rule.timesTriggered = (rule.timesTriggered || 0) + 1;
        await rule.save();
      } catch (err) {
        console.error('❌ Update rule stats error:', err.message);
      }
      return rule.response;
    }
  }
  return null;
};

module.exports = { loadRules, processRules };