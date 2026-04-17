const Rule = require('../models/Rule');
const Message = require('../models/Message');
const {
  executeCommand,
  loadCommandsFromDB,
  getSessionSetting,
  isCommandMessage,
  sendReply
} = require('./commandHandler');

let rulesCache = [];
let lastRulesLoad = 0;
const CACHE_TTL = 30000;

// ============================================
// LOAD RULES FROM DATABASE
// ============================================
const loadRules = async () => {
  const now = Date.now();
  if (now - lastRulesLoad < CACHE_TTL && rulesCache.length > 0) return rulesCache;
  try {
    rulesCache = await Rule.find({ enabled: true }).sort({ priority: -1 });
    lastRulesLoad = now;
    console.log(`📋 Loaded ${rulesCache.length} auto-reply rules`);
    return rulesCache;
  } catch (err) {
    console.error('❌ Failed to load rules:', err.message);
    return [];
  }
};

// ============================================
// SAVE INCOMING MESSAGE
// ============================================
const saveIncomingMessage = async (message, sessionId, isSelf = false) => {
  try {
    await Message.create({
      messageId: message.id?.id || `${Date.now()}`,
      from: message.from,
      body: message.body,
      direction: isSelf ? 'self' : 'incoming',
      isGroup: message.from.includes('@g.us'),
      status: 'delivered',
      timestamp: new Date(),
      sessionId: sessionId
    });
  } catch (err) {
    if (err.code !== 11000) console.error('❌ Save incoming message error:', err.message);
  }
};

// ============================================
// SAVE OUTGOING MESSAGE
// ============================================
const saveOutgoingMessage = async (to, body, sessionId, messageId = null) => {
  try {
    await Message.create({
      messageId: messageId || `${Date.now()}_out`,
      from: to,
      body: body,
      direction: 'outgoing',
      isGroup: to.includes('@g.us'),
      status: 'sent',
      timestamp: new Date(),
      sessionId: sessionId
    });
  } catch (err) {
    if (err.code !== 11000) console.error('❌ Save outgoing message error:', err.message);
  }
};

// ============================================
// CHECK RULE CONDITIONS
// ============================================
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

// ============================================
// MATCH RULE TRIGGER
// ============================================
const matchRuleTrigger = (rule, messageBody) => {
  const trigger = rule.trigger || {};
  if (trigger.type === 'always') return true;
  if (trigger.type === 'keyword') {
    const content = trigger.caseSensitive ? messageBody : messageBody.toLowerCase();
    const keyword = trigger.caseSensitive ? trigger.value : trigger.value.toLowerCase();
    if (keyword.includes(',')) {
      const keywords = keyword.split(',').map(k => k.trim());
      return keywords.some(k => content.includes(k));
    }
    return content.includes(keyword);
  }
  if (trigger.type === 'regex') {
    try {
      const flags = trigger.caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(trigger.value, flags);
      return regex.test(messageBody);
    } catch (err) {
      console.error(`❌ Invalid regex in rule ${rule.name}:`, err.message);
      return false;
    }
  }
  return false;
};

// ============================================
// PROCESS RULES
// ============================================
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

// ============================================
// ANTI-LINK HANDLING
// ============================================
const antiLinkSettings = new Map();
const handleAntiLink = async (message, client, sessionId) => {
  const from = message.from;
  const body = message.body || '';
  const linkPattern = /chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]+)/i;
  const match = body.match(linkPattern);
  if (!match) return false;
  const settings = antiLinkSettings.get(from);
  if (!settings?.enabled) return false;
  try {
    const chat = await message.getChat();
    const botId = client.info.wid._serialized;
    const participant = chat.participants.find(p => p.id._serialized === botId);
    if (!participant?.isAdmin && !participant?.isSuperAdmin) return false;
    const sender = await message.getContact();
    switch (settings.action) {
      case 'delete':
        await message.delete(true);
        await client.sendMessage(from, `⚠️ @${sender.number} Link removed.`, { mentions: [sender.id._serialized] });
        break;
      case 'kick':
        await chat.removeParticipants([sender.id._serialized]);
        await client.sendMessage(from, `🚫 @${sender.number} kicked for sending links.`, { mentions: [sender.id._serialized] });
        break;
      case 'warn':
        await message.reply(`⚠️ @${sender.number} Please don't send group links!`, from, { mentions: [sender.id._serialized] });
        break;
    }
    return true;
  } catch (err) {
    console.error(`❌ Anti-link error:`, err.message);
    return false;
  }
};

// ============================================
// MAIN MESSAGE HANDLER
// ============================================
const handleIncomingMessage = async (message, client, io, sessionId = 'default') => {
  const from = message.from;
  const body = message.body || '';
  const isGroup = from.includes('@g.us');
  const isStatus = from.includes('status@broadcast');
  const botNumber = client?.info?.wid?.user;
  const senderNumber = from.split('@')[0];
  const isSelfMessage = botNumber && senderNumber === botNumber;
  if (isStatus) return;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📨 [${sessionId}] Processing message:`);
  console.log(`   From: ${from} ${isGroup ? '(Group)' : isSelfMessage ? '(Self)' : '(Private)'}`);
  console.log(`   Body: ${body.substring(0, 100)}${body.length > 100 ? '...' : ''}`);
  console.log(`${'='.repeat(50)}`);

  await saveIncomingMessage(message, sessionId, isSelfMessage);
  const mode = await getSessionSetting(sessionId, 'mode');
  const prefix = await getSessionSetting(sessionId, 'commandPrefix');

  if (io) {
    io.emit('hdm:new_message', {
      sessionId, from: isGroup ? from : senderNumber, body, isGroup, isSelf: isSelfMessage,
      timestamp: new Date(), messageId: message.id?.id,
    });
  }

  let response = null;
  let commandExecuted = false;

  const isCommand = await isCommandMessage(body, sessionId, isSelfMessage);
  if (isCommand) {
    console.log(`🔧 [${sessionId}] Command detected: ${body}`);
    try {
      commandExecuted = await executeCommand(client, from, message, sessionId);
      if (commandExecuted) {
        console.log(`✅ [${sessionId}] Command executed successfully`);
      } else {
        console.log(`❌ [${sessionId}] Unknown command or execution failed`);
        if (isSelfMessage) {
          await sendReply(client, from, `❌ Unknown command. Use ${prefix}menu to see available commands.`, sessionId);
        }
      }
    } catch (err) {
      console.error(`❌ [${sessionId}] Command error:`, err.message);
      if (isSelfMessage) await sendReply(client, from, `❌ Command error: ${err.message}`, sessionId);
    }
  }

  if (!commandExecuted && !isSelfMessage && !isCommand) {
    if (mode === 'public') {
      response = await processRules(message, from, isGroup);
    } else {
      console.log(`🔒 [${sessionId}] Private mode - skipping auto-reply rules`);
    }
  }

  if (isGroup && !isSelfMessage && !commandExecuted) {
    await handleAntiLink(message, client, sessionId);
  }

  if (response) {
    try {
      const sentMessage = await message.reply(response);
      if (sentMessage) await saveOutgoingMessage(from, response, sessionId, sentMessage.id?.id);
      console.log(`📤 [${sessionId}] Auto-reply sent`);
      if (io) {
        io.emit('hdm:message_sent', { sessionId, to: from, message: response, timestamp: new Date() });
      }
    } catch (err) {
      console.error(`❌ [${sessionId}] Failed to send reply:`, err.message);
    }
  } else if (!isCommand && !isSelfMessage && mode === 'public') {
    console.log(`ℹ️ [${sessionId}] No auto-reply triggered`);
  }
};

// ============================================
// MESSAGE ACKNOWLEDGMENTS
// ============================================
const handleMessageAck = async (message, sessionId, io) => {
  try {
    const ackMap = { 0: 'pending', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' };
    const status = ackMap[message.ack] || 'unknown';
    if (message.id?.id) {
      await Message.findOneAndUpdate(
        { messageId: message.id.id },
        { status, updatedAt: new Date() },
        { upsert: true }
      );
    }
    if (io) {
      io.emit('hdm:message_ack', { sessionId, messageId: message.id?.id, status, timestamp: new Date() });
    }
  } catch (err) {
    console.error(`❌ [${sessionId}] Message ack error:`, err.message);
  }
};

// ============================================
// EXPORTS
// ============================================
module.exports = {
  handleIncomingMessage,
  handleMessageAck,
  loadRules,
  processRules,
  saveIncomingMessage,
  saveOutgoingMessage,
};