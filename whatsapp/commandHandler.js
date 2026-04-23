const Command = require('../models/Command');
const BotSetting = require('../models/BotSetting');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Optional sharp for sticker support
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.log('⚠️ Sharp not installed. Sticker command disabled.'); }

// ============================================
// ENVIRONMENT CONFIGURATION
// ============================================
const CONFIG = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ENABLE_AI_COMMANDS: process.env.ENABLE_AI_COMMANDS !== 'false',
  ENABLE_BUG_COMMANDS: process.env.ENABLE_BUG_COMMANDS !== 'false',
  DEFAULT_AI_MODEL: process.env.DEFAULT_AI_MODEL || 'deepseek',
  BUG_ALLOWED_USERS: (process.env.BUG_ALLOWED_USERS || '').split(',').filter(Boolean),
  BUG_MAX_MESSAGES: parseInt(process.env.BUG_MAX_MESSAGES) || 1000,
  ADMIN_NUMBERS: (process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean),
  OWNER_NUMBER: process.env.OWNER_NUMBER || '',
  SESSION_SETTINGS_CACHE_TTL: 5000,
  MENU_SESSION_TIMEOUT: 60000,
  COMMANDS_CACHE_TTL: 10000,
  WARNING_DEFAULT_LIMIT: 3,
  MEMBERS_CACHE_TTL: 60000,
};

const DEFAULT_SETTINGS = {
  commandPrefix: '.',
  mode: 'public',
  footerText: '🤖 HDM Bot • Powered by WA',
  alwaysOnline: false,
  autoViewStatus: false,
  antiDelete: true, // Default ON for all sessions
};

// ============================================
// GROUP SETTINGS CACHE (per group)
// ============================================
const groupSettingsCache = new Map();
const GROUP_SETTINGS_CACHE_TTL = 10000;

const getGroupSetting = async (groupId, key, defaultValue = null) => {
  const cacheKey = `${groupId}:${key}`;
  const cached = groupSettingsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < GROUP_SETTINGS_CACHE_TTL) {
    return cached.value;
  }
  try {
    const setting = await BotSetting.findOne({ sessionId: groupId, key });
    const value = setting ? setting.value : defaultValue;
    groupSettingsCache.set(cacheKey, { value, timestamp: Date.now() });
    return value;
  } catch (err) {
    return defaultValue;
  }
};

const setGroupSetting = async (groupId, key, value) => {
  try {
    await BotSetting.findOneAndUpdate(
      { sessionId: groupId, key },
      { sessionId: groupId, key, value, updatedAt: new Date() },
      { upsert: true }
    );
    groupSettingsCache.set(`${groupId}:${key}`, { value, timestamp: Date.now() });
    return true;
  } catch (err) {
    return false;
  }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const activeAttacks = new Map();
const menuSessions = new Map();
const sessionSettingsCache = new Map();
let commandsCache = new Map();
let lastCommandsLoad = 0;

// Anti-settings caches
const antiLinkSettings = new Map();
const antiStatusMentionSettings = new Map();
const onlyAdminSettings = new Map();
const mutedUsers = new Map(); // groupId -> Map of userId -> {until, by}
const warningUsers = new Map(); // groupId -> Map of userId -> {count, reasons}
const badWordsCache = new Map(); // groupId -> Set of words
const memberStatsCache = new Map(); // groupId -> {stats, timestamp}

// Bug logs memory cache (also persisted to DB optionally)
const bugLogsCache = new Map(); // sessionId -> array of logs

// Pairing codes cache (temporary)
const pairingCodes = new Map(); // code -> {phone, timestamp}

// ============================================
// UTILITY FUNCTIONS
// ============================================
const getUserNumber = (jid) => jid.split('@')[0];
const isOwner = (from) => {
  const num = getUserNumber(from);
  return num === CONFIG.OWNER_NUMBER || CONFIG.ADMIN_NUMBERS.includes(num);
};
const isAdmin = async (from, sessionId) => {
  const num = getUserNumber(from);
  if (isOwner(from)) return true;
  const superAdmins = await getSessionSetting(sessionId, 'superAdmins', []);
  if (superAdmins.includes(num)) return true;
  const botAdmins = await getSessionSetting(sessionId, 'botAdmins', []);
  return botAdmins.includes(num);
};
const isSuperAdmin = async (from, sessionId) => {
  const num = getUserNumber(from);
  if (isOwner(from)) return true;
  const superAdmins = await getSessionSetting(sessionId, 'superAdmins', []);
  return superAdmins.includes(num);
};
const isUserAllowedForBug = async (from, sessionId) => {
  const num = getUserNumber(from);
  if (CONFIG.BUG_ALLOWED_USERS.includes(num)) return true;
  if (await isAdmin(from, sessionId)) return true;
  const bugUsers = await getSessionSetting(sessionId, 'bugUsers', []);
  return bugUsers.includes(num);
};
const formatNumber = (number) => String(number).replace(/[^0-9]/g, '');

const clearMenuSession = (userId) => {
  const session = menuSessions.get(userId);
  if (session?.timeout) clearTimeout(session.timeout);
  menuSessions.delete(userId);
};

// ============================================
// SESSION SETTINGS MANAGEMENT
// ============================================
const getSessionSetting = async (sessionId, key) => {
  const cacheKey = `${sessionId}:${key}`;
  const cached = sessionSettingsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONFIG.SESSION_SETTINGS_CACHE_TTL) {
    return cached.value;
  }
  try {
    const setting = await BotSetting.findOne({ sessionId, key });
    const value = setting ? setting.value : DEFAULT_SETTINGS[key];
    sessionSettingsCache.set(cacheKey, { value, timestamp: Date.now() });
    return value;
  } catch (err) {
    return DEFAULT_SETTINGS[key];
  }
};

const setSessionSetting = async (sessionId, key, value) => {
  try {
    await BotSetting.findOneAndUpdate(
      { sessionId, key },
      { sessionId, key, value, updatedAt: new Date() },
      { upsert: true }
    );
    sessionSettingsCache.set(`${sessionId}:${key}`, { value, timestamp: Date.now() });
    return true;
  } catch (err) {
    return false;
  }
};

const getSessionPrefix = async (sessionId) => getSessionSetting(sessionId, 'commandPrefix');

const isCommandMessage = async (body, sessionId, isSelf = false) => {
  if (!body) return false;
  const prefix = await getSessionPrefix(sessionId);
  if (isSelf) {
    return body.startsWith(prefix) || body.startsWith(prefix + prefix);
  }
  return body.startsWith(prefix);
};

// ============================================
// MESSAGE REPLY UTILITIES
// ============================================
const sendReply = async (client, to, text, sessionId) => {
  let safeText = typeof text === 'string' ? text : String(text || '');
  safeText = safeText.replace(/[^\x20-\x7E\n\r\t\u00A0-\uFFFF]/g, '');
  const footer = await getSessionSetting(sessionId, 'footerText');
  if (footer && !safeText.includes(footer)) {
    safeText += `\n\n_${footer}_`;
  }
  await client.sendMessage(to, safeText);
};

// ============================================
// COMMAND CACHE MANAGEMENT
// ============================================
const loadCommandsFromDB = async () => {
  const now = Date.now();
  if (now - lastCommandsLoad < CONFIG.COMMANDS_CACHE_TTL) return commandsCache;
  try {
    const dbCommands = await Command.find({ enabled: true });
    commandsCache.clear();
    dbCommands.forEach(cmd => {
      const data = {
        name: cmd.name,
        description: cmd.description || 'No description',
        response: cmd.response,
        category: cmd.category || 'general',
        adminOnly: cmd.adminOnly || false,
        aliases: cmd.aliases || [],
        isDynamic: true,
        timesUsed: cmd.timesUsed || 0,
        _id: cmd._id,
      };
      commandsCache.set(cmd.name, data);
      cmd.aliases?.forEach(alias => {
        commandsCache.set(alias, { ...data, isAlias: true, parent: cmd.name });
      });
    });
    addBuiltInCommands();
    lastCommandsLoad = now;
    console.log(`📦 Loaded ${commandsCache.size} commands`);
  } catch (err) {
    console.error('❌ Failed to load commands:', err.message);
    addBuiltInCommands();
  }
  return commandsCache;
};

const addBuiltInCommands = () => {
  const builtins = [
    // General
    { name: 'menu', description: '📱 Interactive command menu', category: 'general' },
    { name: 'help', description: '❓ Show help information', category: 'general' },
    { name: 'ping', description: '🏓 Check bot latency', category: 'utility' },
    { name: 'info', description: 'ℹ️ Bot information & uptime', category: 'utility' },
    { name: 'status', description: '📊 WhatsApp connection status', category: 'utility' },
    { name: 'getid', description: '🆔 Get your WhatsApp ID', category: 'utility' },
    { name: 'rules', description: '📜 List active auto-reply rules', category: 'utility' },
    // Fun
    { name: 'joke', description: '😄 Random joke', category: 'fun' },
    { name: 'quote', description: '💬 Inspirational quote', category: 'fun' },
    // Group
    { name: 'kick', description: '👢 Kick member from group', category: 'group' },
    { name: 'promote', description: '⬆️ Promote to admin', category: 'group' },
    { name: 'demote', description: '⬇️ Demote from admin', category: 'group' },
    { name: 'link', description: '🔗 Get group invite link', category: 'group' },
    { name: 'antilink', description: '🛡️ Anti-link protection', category: 'group', adminOnly: true },
    { name: 'delete', description: '🗑️ Delete quoted message', category: 'group' },
    { name: 'del', description: '🗑️ Alias for delete', category: 'group', isAlias: true, parent: 'delete' },
    { name: 'tagall', description: '📢 Mention all members', category: 'group' },
    { name: 'groupinfo', description: '👥 Group information', category: 'group' },
    { name: 'admins', description: '👑 List group admins', category: 'group' },
    { name: 'welcome', description: '👋 Set welcome message', category: 'group' },
    { name: 'goodbye', description: '🚪 Set goodbye message', category: 'group' },
    { name: 'antistatusmention', description: '📵 Anti-status mention', category: 'group', adminOnly: true },
    // Settings
    { name: 'setprefix', description: '🔧 Change command prefix', category: 'settings', adminOnly: true },
    { name: 'setfooter', description: '📝 Change footer text', category: 'settings', adminOnly: true },
    { name: 'mode', description: '🔒 Set public/private mode', category: 'settings', adminOnly: true },
    { name: 'alwaysonline', description: '🟢 Toggle always online', category: 'settings', adminOnly: true },
    { name: 'autoviewstatus', description: '👀 Toggle auto-view status', category: 'settings', adminOnly: true },
    { name: 'reload', description: '🔄 Reload commands/rules', category: 'settings', adminOnly: true },
    { name: 'listadmins', description: '📋 List bot admins', category: 'settings', adminOnly: true },
    // New Admin Management
    { name: 'addbotadmin', description: '➕ Add bot admin', category: 'admin', adminOnly: true },
    { name: 'listbotadmins', description: '📋 List bot admins', category: 'admin', adminOnly: true },
    { name: 'removebotadmin', description: '➖ Remove bot admin', category: 'admin', adminOnly: true },
    { name: 'addsudo', description: '👑 Add super admin', category: 'admin', adminOnly: true },
    { name: 'setsudo', description: '👤 Set primary owner', category: 'admin', adminOnly: true },
    { name: 'ownerinfo', description: 'ℹ️ Owner information', category: 'admin' },
    // New Bug System
    { name: 'addbuguser', description: '🐛 Add bug user', category: 'bug', adminOnly: true },
    { name: 'listbugusers', description: '📋 List bug users', category: 'bug', adminOnly: true },
    { name: 'removebuguser', description: '➖ Remove bug user', category: 'bug', adminOnly: true },
    { name: 'antibug', description: '🛡️ Toggle bug protection', category: 'bug', adminOnly: true },
    { name: 'buglogs', description: '📜 View bug logs', category: 'bug', adminOnly: true },
    { name: 'clearbuglogs', description:'🗑️ Clear bug logs', category: 'bug', adminOnly: true },
    // New Group Moderation
    { name: 'onlyadmin', description: '🔒 Admin-only messaging', category: 'group' },
    { name: 'kickall', description: '👢 Kick all non-admins', category: 'group' },
    { name: 'groupdesc', description: '📝 View/set group description', category: 'group' },
    { name: 'members', description: '👥 Member statistics + countries', category: 'group' },
    { name: 'mute', description: '🔇 Mute a member', category: 'group' },
    { name: 'unmute', description: '🔊 Unmute a member', category: 'group' },
    { name: 'mutelist', description: '📋 List muted members', category: 'group' },
    { name: 'setwarn', description: '⚠️ Set warning limit', category: 'group' },
    // New Bad Word Filter
    { name: 'antibadword', description: '🚫 Toggle bad word filter', category: 'group' },
    { name: 'addbadword', description: '➕ Add bad word', category: 'group' },
    { name: 'removebadword', description: '➖ Remove bad word', category: 'group' },
    { name: 'listbadword', description: '📋 List bad words', category: 'group' },
    // Privacy & Broadcast
    { name: 'antidelete', description: '🗑️ Anti-delete protection', category: 'privacy', adminOnly: true },
    { name: 'poll', description: '📊 Create a poll', category: 'utility' },
    { name: 'broadcast', description: '📢 Broadcast to all groups', category: 'utility', adminOnly: true },
    // Pairing
    { name: 'pair', description: '🔗 Pair with code', category: 'utility' },
  ];
  
  if (CONFIG.ENABLE_AI_COMMANDS) {
    builtins.push(
      { name: 'deepseek', description: '🤖 Ask DeepSeek AI', category: 'ai' },
      { name: 'gemini', description: '🧠 Ask Gemini AI', category: 'ai' },
      { name: 'chatgpt', description: '💬 Ask ChatGPT', category: 'ai' },
      { name: 'claude', description: '🧠 Ask Claude (Anthropic)', category: 'ai' },
      { name: 'ai', description: '✨ Default AI assistant', category: 'ai' },
      { name: 'claude', description: '🧠 Ask Claude AI', category: 'ai' }
    );
  }
  
  if (CONFIG.ENABLE_BUG_COMMANDS) {
    builtins.push(
      { name: 'bugmenu', description: '🐛 Bug testing menu', category: 'bug' },
      { name: 'bug', description: '💣 Start message attack', category: 'bug' },
      { name: 'stopbug', description: '🛑 Stop all attacks', category: 'bug' }
    );
  }
  
  if (sharp) {
    builtins.push(
      { name: 'sticker', description: '🎨 Create sticker from image', category: 'media' },
      { name: 'take', description: '🏷️ Set sticker metadata', category: 'media' }
    );
  }
  
  builtins.forEach(cmd => {
    if (!commandsCache.has(cmd.name)) {
      commandsCache.set(cmd.name, { ...cmd, isBuiltIn: true });
    }
  });
};

// ============================================
// EXTERNAL APIs
// ============================================
const searchDeepSeek = async (query) => {
  if (!CONFIG.DEEPSEEK_API_KEY) return '❌ DeepSeek API key not configured.';
  try {
    const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: query }
      ],
      temperature: 0.7,
      max_tokens: 1000
    }, {
      headers: { Authorization: `Bearer ${CONFIG.DEEPSEEK_API_KEY}` },
      timeout: 30000
    });
    return res.data.choices[0].message.content;
  } catch (e) {
    return `❌ DeepSeek error: ${e.message}`;
  }
};

const searchGemini = async (query) => {
  if (!CONFIG.GEMINI_API_KEY) return '❌ Gemini API key not configured.';
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: query }] }] },
      { timeout: 30000 }
    );
    return res.data.candidates[0].content.parts[0].text;
  } catch (e) {
    return `❌ Gemini error: ${e.message}`;
  }
};

const searchChatGPT = async (query) => {
  if (!CONFIG.OPENAI_API_KEY) return '❌ ChatGPT API key not configured.';
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: query }
      ],
      temperature: 0.7,
      max_tokens: 1000
    }, {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` },
      timeout: 30000
    });
    return res.data.choices[0].message.content;
  } catch (e) {
    return `❌ ChatGPT error: ${e.message}`;
  }
};

const searchClaude = async (query) => {
  if (!CONFIG.ANTHROPIC_API_KEY) return '❌ Claude API key not configured.';
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: query }],
    }, {
      headers: {
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    return res.data.content?.[0]?.text || '❌ No response from Claude.';
  } catch (e) {
    return `❌ Claude error: ${e.response?.data?.error?.message || e.message}`;
  }
};



const getJoke = async () => {
  try {
    const res = await axios.get('https://v2.jokeapi.dev/joke/Any?safe-mode', { timeout: 5000 });
    return res.data.type === 'single' ? res.data.joke : `${res.data.setup}\n\n${res.data.delivery}`;
  } catch {
    return 'Why did the developer go broke? Because he used up all his cache.';
  }
};

const getQuote = async () => {
  try {
    const res = await axios.get('https://api.quotable.io/random', { timeout: 5000 });
    return `"${res.data.content}"\n— ${res.data.author}`;
  } catch {
    return '"The only way to do great work is to love what you do." — Steve Jobs';
  }
};

// ============================================
// BUG ATTACK SYSTEM
// ============================================
const startEndlessMessages = async (client, targetJid, msgText, count, intervalMs, from, sessionId) => {
  const attackId = `${Date.now()}_${targetJid}`;
  let sentCount = 0;
  let statusMessage = null;
  
  activeAttacks.set(attackId, {
    stopped: false,
    interval: null,
    target: targetJid,
    from,
    sessionId
  });

  const createProgressBar = (percent, length = 10) => {
    const filled = Math.round((percent / 100) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
  };

  const prefix = await getSessionPrefix(sessionId);
  statusMessage = await client.sendMessage(from,
    `🐛 *BUG ATTACK STARTED*\n\n` +
    `📱 Target: ${targetJid.split('@')[0]}\n` +
    `📨 Progress: 0/${count} (0%)\n` +
    `[${createProgressBar(0)}]\n` +
    `⏱️ Interval: ${(intervalMs / 1000).toFixed(2)}s\n` +
    `🔄 Status: Running...\n\n` +
    `Use ${prefix}stopbug to stop.`
  );

  const loop = async () => {
    const attack = activeAttacks.get(attackId);
    if (!attack || attack.stopped || sentCount >= count) {
      if (attack?.interval) clearInterval(attack.interval);
      activeAttacks.delete(attackId);
      try {
        await statusMessage.edit(
          `✅ *BUG ATTACK COMPLETED*\n\n` +
          `📱 Target: ${targetJid.split('@')[0]}\n` +
          `📨 Progress: ${sentCount}/${count} (100%)\n` +
          `[${createProgressBar(100)}]\n` +
          `⏱️ Duration: ~${((sentCount * intervalMs) / 1000).toFixed(1)}s`
        );
      } catch {
        await client.sendMessage(from, `✅ Bug attack completed.`);
      }
      return;
    }

    try {
      await client.sendMessage(targetJid, msgText);
      sentCount++;

      const percent = Math.round((sentCount / count) * 100);
      try {
        await statusMessage.edit(
          `🐛 *BUG ATTACK RUNNING*\n\n` +
          `📱 Target: ${targetJid.split('@')[0]}\n` +
          `📨 Progress: ${sentCount}/${count} (${percent}%)\n` +
          `[${createProgressBar(percent)}]\n` +
          `⏱️ Interval: ${(intervalMs / 1000).toFixed(2)}s\n` +
          `🔄 Status: Active\n\n` +
          `Use ${prefix}stopbug to stop.`
        );
      } catch {}
    } catch (err) {
      if (attack?.interval) clearInterval(attack.interval);
      activeAttacks.delete(attackId);
      await client.sendMessage(from, `❌ Bug attack failed: ${err.message}`);
    }
  };

  await loop();
  const intervalId = setInterval(loop, intervalMs);
  const attack = activeAttacks.get(attackId);
  if (attack) attack.interval = intervalId;
  
  return attackId;
};

const stopAllBugAttacks = async (client, from) => {
  let stopped = 0;
  for (const [id, attack] of activeAttacks) {
    if (attack.from !== from) continue;
    attack.stopped = true;
    if (attack.interval) clearInterval(attack.interval);
    activeAttacks.delete(id);
    stopped++;
  }
  await client.sendMessage(from, stopped ? `✅ Stopped ${stopped} attack(s).` : '❌ No active attacks.');
};
// ============================================
// STICKER CREATION
// ============================================
const createSticker = async (client, msg, from, sessionId, pack = 'HDM', author = 'Bot') => {
  if (!sharp) {
    await sendReply(client, from, '❌ Sticker support requires sharp module.', sessionId);
    return;
  }
  try {
    const quoted = await msg.getQuotedMessage();
    const target = quoted || msg;
    if (!target.hasMedia) {
      await sendReply(client, from, '❌ Reply to an image or send with caption.', sessionId);
      return;
    }
    await sendReply(client, from, '🎨 Creating sticker...', sessionId);
    const media = await target.downloadMedia();
    const buffer = Buffer.from(media.data, 'base64');
    const tmpDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, `${Date.now()}_in.jpg`);
    const outputPath = path.join(tmpDir, `${Date.now()}_sticker.webp`);
    fs.writeFileSync(inputPath, buffer);
    await sharp(inputPath)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90 })
      .toFile(outputPath);
    await client.sendMessage(from, {
      sticker: fs.readFileSync(outputPath),
      sendMediaAsSticker: true,
      stickerName: pack,
      stickerAuthor: author
    });
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
  } catch (err) {
    await sendReply(client, from, `❌ Sticker creation failed: ${err.message}`, sessionId);
  }
};

// ============================================
// GROUP HELPERS
// ============================================
const getGroupAdmins = async (chat) => {
  return chat.participants
    .filter(p => p.isAdmin || p.isSuperAdmin)
    .map(p => p.id._serialized);
};

const isBotGroupAdmin = async (chat, client) => {
  const botId = client.info.wid._serialized;
  const participant = chat.participants.find(p => p.id._serialized === botId);
  return participant?.isAdmin || participant?.isSuperAdmin || false;
};

const isGroupAdmin = async (chat, userId) => {
  const participant = chat.participants.find(p => p.id._serialized === userId);
  return participant?.isAdmin || participant?.isSuperAdmin || false;
};

// ============================================
// COUNTRY MAPPING
// ============================================
const countryMap = {
  '1': { name: 'USA/Canada', flag: '🇺🇸' },
  '7': { name: 'Russia', flag: '🇷🇺' },
  '20': { name: 'Egypt', flag: '🇪🇬' },
  '27': { name: 'South Africa', flag: '🇿🇦' },
  '30': { name: 'Greece', flag: '🇬🇷' },
  '31': { name: 'Netherlands', flag: '🇳🇱' },
  '32': { name: 'Belgium', flag: '🇧🇪' },
  '33': { name: 'France', flag: '🇫🇷' },
  '34': { name: 'Spain', flag: '🇪🇸' },
  '39': { name: 'Italy', flag: '🇮🇹' },
  '40': { name: 'Romania', flag: '🇷🇴' },
  '41': { name: 'Switzerland', flag: '🇨🇭' },
  '44': { name: 'UK', flag: '🇬🇧' },
  '45': { name: 'Denmark', flag: '🇩🇰' },
  '46': { name: 'Sweden', flag: '🇸🇪' },
  '47': { name: 'Norway', flag: '🇳🇴' },
  '48': { name: 'Poland', flag: '🇵🇱' },
  '49': { name: 'Germany', flag: '🇩🇪' },
  '51': { name: 'Peru', flag: '🇵🇪' },
  '52': { name: 'Mexico', flag: '🇲🇽' },
  '54': { name: 'Argentina', flag: '🇦🇷' },
  '55': { name: 'Brazil', flag: '🇧🇷' },
  '56': { name: 'Chile', flag: '🇨🇱' },
  '57': { name: 'Colombia', flag: '🇨🇴' },
  '58': { name: 'Venezuela', flag: '🇻🇪' },
  '60': { name: 'Malaysia', flag: '🇲🇾' },
  '61': { name: 'Australia', flag: '🇦🇺' },
  '62': { name: 'Indonesia', flag: '🇮🇩' },
  '63': { name: 'Philippines', flag: '🇵🇭' },
  '64': { name: 'New Zealand', flag: '🇳🇿' },
  '65': { name: 'Singapore', flag: '🇸🇬' },
  '66': { name: 'Thailand', flag: '🇹🇭' },
  '81': { name: 'Japan', flag: '🇯🇵' },
  '82': { name: 'South Korea', flag: '🇰🇷' },
  '84': { name: 'Vietnam', flag: '🇻🇳' },
  '86': { name: 'China', flag: '🇨🇳' },
  '90': { name: 'Turkey', flag: '🇹🇷' },
  '91': { name: 'India', flag: '🇮🇳' },
  '92': { name: 'Pakistan', flag: '🇵🇰' },
  '93': { name: 'Afghanistan', flag: '🇦🇫' },
  '94': { name: 'Sri Lanka', flag: '🇱🇰' },
  '95': { name: 'Myanmar', flag: '🇲🇲' },
  '98': { name: 'Iran', flag: '🇮🇷' },
  '212': { name: 'Morocco', flag: '🇲🇦' },
  '213': { name: 'Algeria', flag: '🇩🇿' },
  '216': { name: 'Tunisia', flag: '🇹🇳' },
  '218': { name: 'Libya', flag: '🇱🇾' },
  '220': { name: 'Gambia', flag: '🇬🇲' },
  '221': { name: 'Senegal', flag: '🇸🇳' },
  '222': { name: 'Mauritania', flag: '🇲🇷' },
  '223': { name: 'Mali', flag: '🇲🇱' },
  '224': { name: 'Guinea', flag: '🇬🇳' },
  '225': { name: 'Ivory Coast', flag: '🇨🇮' },
  '226': { name: 'Burkina Faso', flag: '🇧🇫' },
  '227': { name: 'Niger', flag: '🇳🇪' },
  '228': { name: 'Togo', flag: '🇹🇬' },
  '229': { name: 'Benin', flag: '🇧🇯' },
  '230': { name: 'Mauritius', flag: '🇲🇺' },
  '231': { name: 'Liberia', flag: '🇱🇷' },
  '232': { name: 'Sierra Leone', flag: '🇸🇱' },
  '233': { name: 'Ghana', flag: '🇬🇭' },
  '234': { name: 'Nigeria', flag: '🇳🇬' },
  '235': { name: 'Chad', flag: '🇹🇩' },
  '236': { name: 'CAR', flag: '🇨🇫' },
  '237': { name: 'Cameroon', flag: '🇨🇲' },
  '238': { name: 'Cape Verde', flag: '🇨🇻' },
  '239': { name: 'Sao Tome', flag: '🇸🇹' },
  '240': { name: 'Eq. Guinea', flag: '🇬🇶' },
  '241': { name: 'Gabon', flag: '🇬🇦' },
  '242': { name: 'Congo', flag: '🇨🇬' },
  '243': { name: 'DR Congo', flag: '🇨🇩' },
  '244': { name: 'Angola', flag: '🇦🇴' },
  '245': { name: 'Guinea-Bissau', flag: '🇬🇼' },
  '246': { name: 'Diego Garcia', flag: '🇩🇬' },
  '247': { name: 'Ascension', flag: '🇦🇨' },
  '248': { name: 'Seychelles', flag: '🇸🇨' },
  '249': { name: 'Sudan', flag: '🇸🇩' },
  '250': { name: 'Rwanda', flag: '🇷🇼' },
  '251': { name: 'Ethiopia', flag: '🇪🇹' },
  '252': { name: 'Somalia', flag: '🇸🇴' },
  '253': { name: 'Djibouti', flag: '🇩🇯' },
  '254': { name: 'Kenya', flag: '🇰🇪' },
  '255': { name: 'Tanzania', flag: '🇹🇿' },
  '256': { name: 'Uganda', flag: '🇺🇬' },
  '257': { name: 'Burundi', flag: '🇧🇮' },
  '258': { name: 'Mozambique', flag: '🇲🇿' },
  '260': { name: 'Zambia', flag: '🇿🇲' },
  '261': { name: 'Madagascar', flag: '🇲🇬' },
  '262': { name: 'Reunion', flag: '🇷🇪' },
  '263': { name: 'Zimbabwe', flag: '🇿🇼' },
  '264': { name: 'Namibia', flag: '🇳🇦' },
  '265': { name: 'Malawi', flag: '🇲🇼' },
  '266': { name: 'Lesotho', flag: '🇱🇸' },
  '267': { name: 'Botswana', flag: '🇧🇼' },
  '268': { name: 'Eswatini', flag: '🇸🇿' },
  '269': { name: 'Comoros', flag: '🇰🇲' },
  '290': { name: 'St. Helena', flag: '🇸🇭' },
  '291': { name: 'Eritrea', flag: '🇪🇷' },
  '297': { name: 'Aruba', flag: '🇦🇼' },
  '298': { name: 'Faroe Islands', flag: '🇫🇴' },
  '299': { name: 'Greenland', flag: '🇬🇱' },
  '350': { name: 'Gibraltar', flag: '🇬🇮' },
  '351': { name: 'Portugal', flag: '🇵🇹' },
  '352': { name: 'Luxembourg', flag: '🇱🇺' },
  '353': { name: 'Ireland', flag: '🇮🇪' },
  '354': { name: 'Iceland', flag: '🇮🇸' },
  '355': { name: 'Albania', flag: '🇦🇱' },
  '356': { name: 'Malta', flag: '🇲🇹' },
  '357': { name: 'Cyprus', flag: '🇨🇾' },
  '358': { name: 'Finland', flag: '🇫🇮' },
  '359': { name: 'Bulgaria', flag: '🇧🇬' },
  '370': { name: 'Lithuania', flag: '🇱🇹' },
  '371': { name: 'Latvia', flag: '🇱🇻' },
  '372': { name: 'Estonia', flag: '🇪🇪' },
  '373': { name: 'Moldova', flag: '🇲🇩' },
  '374': { name: 'Armenia', flag: '🇦🇲' },
  '375': { name: 'Belarus', flag: '🇧🇾' },
  '376': { name: 'Andorra', flag: '🇦🇩' },
  '377': { name: 'Monaco', flag: '🇲🇨' },
  '378': { name: 'San Marino', flag: '🇸🇲' },
  '380': { name: 'Ukraine', flag: '🇺🇦' },
  '381': { name: 'Serbia', flag: '🇷🇸' },
  '382': { name: 'Montenegro', flag: '🇲🇪' },
  '383': { name: 'Kosovo', flag: '🇽🇰' },
  '385': { name: 'Croatia', flag: '🇭🇷' },
  '386': { name: 'Slovenia', flag: '🇸🇮' },
  '387': { name: 'Bosnia', flag: '🇧🇦' },
  '389': { name: 'North Macedonia', flag: '🇲🇰' },
  '420': { name: 'Czech Republic', flag: '🇨🇿' },
  '421': { name: 'Slovakia', flag: '🇸🇰' },
  '423': { name: 'Liechtenstein', flag: '🇱🇮' },
  '500': { name: 'Falkland Islands', flag: '🇫🇰' },
  '501': { name: 'Belize', flag: '🇧🇿' },
  '502': { name: 'Guatemala', flag: '🇬🇹' },
  '503': { name: 'El Salvador', flag: '🇸🇻' },
  '504': { name: 'Honduras', flag: '🇭🇳' },
  '505': { name: 'Nicaragua', flag: '🇳🇮' },
  '506': { name: 'Costa Rica', flag: '🇨🇷' },
  '507': { name: 'Panama', flag: '🇵🇦' },
  '508': { name: 'St. Pierre', flag: '🇵🇲' },
  '509': { name: 'Haiti', flag: '🇭🇹' },
  '591': { name: 'Bolivia', flag: '🇧🇴' },
  '592': { name: 'Guyana', flag: '🇬🇾' },
  '593': { name: 'Ecuador', flag: '🇪🇨' },
  '594': { name: 'French Guiana', flag: '🇬🇫' },
  '595': { name: 'Paraguay', flag: '🇵🇾' },
  '596': { name: 'Martinique', flag: '🇲🇶' },
  '597': { name: 'Suriname', flag: '🇸🇷' },
  '598': { name: 'Uruguay', flag: '🇺🇾' },
  '599': { name: 'Netherlands Antilles', flag: '🇧🇶' },
  '670': { name: 'East Timor', flag: '🇹🇱' },
  '672': { name: 'Antarctica', flag: '🇦🇶' },
  '673': { name: 'Brunei', flag: '🇧🇳' },
  '674': { name: 'Nauru', flag: '🇳🇷' },
  '675': { name: 'Papua New Guinea', flag: '🇵🇬' },
  '676': { name: 'Tonga', flag: '🇹🇴' },
  '677': { name: 'Solomon Islands', flag: '🇸🇧' },
  '678': { name: 'Vanuatu', flag: '🇻🇺' },
  '679': { name: 'Fiji', flag: '🇫🇯' },
  '680': { name: 'Palau', flag: '🇵🇼' },
  '681': { name: 'Wallis and Futuna', flag: '🇼🇫' },
  '682': { name: 'Cook Islands', flag: '🇨🇰' },
  '683': { name: 'Niue', flag: '🇳🇺' },
  '685': { name: 'Samoa', flag: '🇼🇸' },
  '686': { name: 'Kiribati', flag: '🇰🇮' },
  '687': { name: 'New Caledonia', flag: '🇳🇨' },
  '688': { name: 'Tuvalu', flag: '🇹🇻' },
  '689': { name: 'French Polynesia', flag: '🇵🇫' },
  '690': { name: 'Tokelau', flag: '🇹🇰' },
  '691': { name: 'Micronesia', flag: '🇫🇲' },
  '692': { name: 'Marshall Islands', flag: '🇲🇭' },
  '850': { name: 'North Korea', flag: '🇰🇵' },
  '852': { name: 'Hong Kong', flag: '🇭🇰' },
  '853': { name: 'Macau', flag: '🇲🇴' },
  '855': { name: 'Cambodia', flag: '🇰🇭' },
  '856': { name: 'Laos', flag: '🇱🇦' },
  '880': { name: 'Bangladesh', flag: '🇧🇩' },
  '886': { name: 'Taiwan', flag: '🇹🇼' },
  '960': { name: 'Maldives', flag: '🇲🇻' },
  '961': { name: 'Lebanon', flag: '🇱🇧' },
  '962': { name: 'Jordan', flag: '🇯🇴' },
  '963': { name: 'Syria', flag: '🇸🇾' },
  '964': { name: 'Iraq', flag: '🇮🇶' },
  '965': { name: 'Kuwait', flag: '🇰🇼' },
  '966': { name: 'Saudi Arabia', flag: '🇸🇦' },
  '967': { name: 'Yemen', flag: '🇾🇪' },
  '968': { name: 'Oman', flag: '🇴🇲' },
  '970': { name: 'Palestine', flag: '🇵🇸' },
  '971': { name: 'UAE', flag: '🇦🇪' },
  '972': { name: 'Israel', flag: '🇮🇱' },
  '973': { name: 'Bahrain', flag: '🇧🇭' },
  '974': { name: 'Qatar', flag: '🇶🇦' },
  '975': { name: 'Bhutan', flag: '🇧🇹' },
  '976': { name: 'Mongolia', flag: '🇲🇳' },
  '977': { name: 'Nepal', flag: '🇳🇵' },
  '992': { name: 'Tajikistan', flag: '🇹🇯' },
  '993': { name: 'Turkmenistan', flag: '🇹🇲' },
  '994': { name: 'Azerbaijan', flag: '🇦🇿' },
  '995': { name: 'Georgia', flag: '🇬🇪' },
  '996': { name: 'Kyrgyzstan', flag: '🇰🇬' },
  '998': { name: 'Uzbekistan', flag: '🇺🇿' },
};
const getCountryFromNumber = (number) => {
  for (const code of Object.keys(countryMap).sort((a, b) => b.length - a.length)) {
    if (number.startsWith(code)) {
      return countryMap[code];
    }
  }
  return { name: 'Other', flag: '🌍' };
};

// ============================================
// COMMAND HANDLERS
// ============================================
const commandHandlers = {
  // ------------------------------------------------------------
  // GENERAL COMMANDS
  // ------------------------------------------------------------
  async menu(client, from, args, message, sessionId) {
    await loadCommandsFromDB();
    const prefix = await getSessionPrefix(sessionId);
    const mode = await getSessionSetting(sessionId, 'mode');
    const alwaysOnline = await getSessionSetting(sessionId, 'alwaysOnline');
    const userNumber = getUserNumber(from);
    clearMenuSession(userNumber);
    
    const categories = {
      general: { emoji: '📋', name: 'General', cmds: [] },
      utility: { emoji: '🔧', name: 'Utility', cmds: [] },
      group: { emoji: '👥', name: 'Group Management', cmds: [] },
      ai: { emoji: '🤖', name: 'AI Assistant', cmds: [] },
      fun: { emoji: '🎉', name: 'Fun & Games', cmds: [] },
      media: { emoji: '🖼️', name: 'Media Tools', cmds: [] },
      settings: { emoji: '⚙️', name: 'Bot Settings', cmds: [] },
      admin: { emoji: '👑', name: 'Admin', cmds: [] },
      bug: { emoji: '🐛', name: 'Testing Tools', cmds: [] },
      privacy: { emoji: '🔒', name: 'Privacy', cmds: [] },
    };
    
    const allCmds = Array.from(commandsCache.values())
      .filter(c => !c.isAlias)
      .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i);
    
    allCmds.forEach(cmd => {
      const cat = cmd.category || 'general';
      if (categories[cat]) categories[cat].cmds.push(cmd);
    });
    
    let menuText = `╭━━━━━━━━━━━━━━━━━━━━━━╮\n┃   *🤖 HDM BOT MENU*   ┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
    const flatList = [];
    let counter = 1;
    
    Object.values(categories).forEach(cat => {
      if (cat.cmds.length === 0) return;
      menuText += `*${cat.emoji} ${cat.name}*\n├${'─'.repeat(20)}\n`;
      cat.cmds.sort((a, b) => a.name.localeCompare(b.name)).forEach(cmd => {
        const lock = cmd.adminOnly ? ' 🔒' : '';
        menuText += `│ ${counter.toString().padStart(2)}. ${prefix}${cmd.name}${lock}\n│    ${cmd.description}\n`;
        flatList.push({ number: counter, command: cmd });
        counter++;
      });
      menuText += `╰${'─'.repeat(20)}\n\n`;
    });
    
    menuText += `╭${'─'.repeat(22)}╮\n│ Prefix: ${prefix.padEnd(13)} │\n│ Mode: ${mode.padEnd(15)} │\n│ Online: ${alwaysOnline ? 'ON' : 'OFF'.padEnd(14)} │\n╰${'─'.repeat(22)}╯\n\n_Reply with number (1-${flatList.length}) • Expires 60s_`;
    
    const sent = await client.sendMessage(from, menuText);
    const timeout = setTimeout(() => {
      clearMenuSession(userNumber);
      client.sendMessage(from, '⌛ Menu session expired.').catch(() => {});
    }, CONFIG.MENU_SESSION_TIMEOUT);
    
    menuSessions.set(userNumber, {
      flatCommandList: flatList,
      messageId: sent.id.id,
      expires: Date.now() + CONFIG.MENU_SESSION_TIMEOUT,
      timeout,
      sessionId
    });
    return true;
  },
  
  async help(client, from, args, message, sessionId) {
    const prefix = await getSessionPrefix(sessionId);
    await sendReply(client, from,
      `*📚 HELP*\n\n` +
      `Prefix: ${prefix}\n` +
      `Self-commands: ${prefix}${prefix}command\n\n` +
      `${prefix}menu - Interactive menu\n` +
      `${prefix}ping - Check response time\n` +
      `${prefix}ai <query> - Ask AI\n` +
      `${prefix}welcome on/off - Welcome messages\n` +
      `${prefix}goodbye on/off - Goodbye messages\n\n` +
      `Use ${prefix}menu for all commands.`,
      sessionId
    );
    return true;
  },
  
  async ping(client, from, args, message, sessionId) {
    const start = Date.now();
    await sendReply(client, from, '📡 Pinging...', sessionId);
    const latency = Date.now() - start;
    await sendReply(client, from, `🏓 Pong! Latency: ${latency}ms`, sessionId);
    return true;
  },
  
  async info(client, from, args, message, sessionId) {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    await sendReply(client, from,
      `*🤖 HDM Bot v2.0*\n` +
      `Prefix: ${await getSessionPrefix(sessionId)}\n` +
      `Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
      `Session: ${sessionId}`,
      sessionId
    );
    return true;
  },
  
  async status(client, from, args, message, sessionId) {
    const connected = !!client?.info?.wid;
    const phone = client?.info?.wid?.user || 'N/A';
    await sendReply(client, from,
      `📊 *Status*\n` +
      `WhatsApp: ${connected ? '✅ Connected' : '❌ Disconnected'}\n` +
      `Phone: ${phone}`,
      sessionId
    );
    return true;
  },
  
  async getid(client, from, args, message, sessionId) {
    await sendReply(client, from, `🆔 Your ID: ${getUserNumber(from)}`, sessionId);
    return true;
  },
  
  async rules(client, from, args, message, sessionId) {
    try {
      const Rule = require('../models/Rule');
      const rules = await Rule.find({ enabled: true }).limit(10);
      const text = rules.length
        ? `📜 *Active Rules:*\n${rules.map((r, i) => `${i+1}. ${r.name}`).join('\n')}`
        : 'No active rules.';
      await sendReply(client, from, text, sessionId);
    } catch {
      await sendReply(client, from, 'Error loading rules.', sessionId);
    }
    return true;
  },
  
  // ------------------------------------------------------------
  // FUN COMMANDS
  // ------------------------------------------------------------
  async joke(client, from, args, message, sessionId) {
    await sendReply(client, from, await getJoke(), sessionId);
    return true;
  },
  
  async quote(client, from, args, message, sessionId) {
    await sendReply(client, from, await getQuote(), sessionId);
    return true;
  },
  
  // ------------------------------------------------------------
  // GROUP COMMANDS (existing)
  // ------------------------------------------------------------
  async kick(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to kick members.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = quoted.author || quoted.from;
    } else if (args[0]) {
      target = `${formatNumber(args[0])}@c.us`;
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from,
        `❌ Usage: ${prefix}kick @user / reply / ${prefix}kick <number>`,
        sessionId
      );
    }
    
    try {
      await chat.removeParticipants([target]);
      await sendReply(client, from, `✅ Kicked ${target.split('@')[0]}`, sessionId);
    } catch (err) {
      await sendReply(client, from, `❌ Failed: ${err.message}`, sessionId);
    }
    return true;
  },
  
  async promote(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = quoted.author || quoted.from;
    } else if (args[0]) {
      target = `${formatNumber(args[0])}@c.us`;
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}promote @user / reply / <number>`, sessionId);
    }
    
    try {
      await chat.promoteParticipants([target]);
      await sendReply(client, from, `✅ Promoted ${target.split('@')[0]}`, sessionId);
    } catch (err) {
      await sendReply(client, from, `❌ Failed: ${err.message}`, sessionId);
    }
    return true;
  },
  
  async demote(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = quoted.author || quoted.from;
    } else if (args[0]) {
      target = `${formatNumber(args[0])}@c.us`;
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}demote @user / reply / <number>`, sessionId);
    }
    
    try {
      await chat.demoteParticipants([target]);
      await sendReply(client, from, `✅ Demoted ${target.split('@')[0]}`, sessionId);
    } catch (err) {
      await sendReply(client, from, `❌ Failed: ${err.message}`, sessionId);
    }
    return true;
  },
async link(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges.', sessionId);
    }
    
    try {
      const code = await chat.getInviteCode();
      await sendReply(client, from, `🔗 https://chat.whatsapp.com/${code}`, sessionId);
    } catch (err) {
      await sendReply(client, from, `❌ Failed: ${err.message}`, sessionId);
    }
    return true;
  },
  
  async antilink(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    
    const groupId = chat.id._serialized;
    const action = args[0]?.toLowerCase();
    const state = args[1]?.toLowerCase();
    const prefix = await getSessionPrefix(sessionId);
    
    if (!action || !state) {
      const current = antiLinkSettings.get(groupId) || { enabled: false, action: 'delete' };
      return sendReply(client, from,
        `🛡️ Anti-Link: ${current.enabled ? 'ON' : 'OFF'} | Action: ${current.action}\n` +
        `Usage: ${prefix}antilink <delete|kick|warn> <on|off>`,
        sessionId
      );
    }
    
    if (!['delete', 'kick', 'warn'].includes(action)) {
      return sendReply(client, from, 'Action must be: delete, kick, warn', sessionId);
    }
    if (!['on', 'off'].includes(state)) {
      return sendReply(client, from, 'State must be: on, off', sessionId);
    }
    
    antiLinkSettings.set(groupId, { enabled: state === 'on', action });
    await sendReply(client, from, `✅ Anti-link ${state === 'on' ? 'enabled' : 'disabled'} (${action})`, sessionId);
    return true;
  },
  
  async delete(client, from, args, message, sessionId) {
    if (!message.hasQuotedMsg) {
      return sendReply(client, from, '❌ Reply to a message to delete it.', sessionId);
    }
    
    const quoted = await message.getQuotedMessage();
    let chat;
    try { chat = await message.getChat(); } catch {}
    
    if (chat?.isGroup && !(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to delete messages.', sessionId);
    }
    
    try {
      await quoted.delete(true);
      await sendReply(client, from, '✅ Message deleted.', sessionId);
    } catch (err) {
      await sendReply(client, from, `❌ Failed: ${err.message}`, sessionId);
    }
    return true;
  },
  
  async tagall(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    
    let text = `📢 *Attention everyone!*\n`;
    if (args.length) text += args.join(' ') + '\n';
    
    const mentions = chat.participants.map(p => p.id._serialized);
    await client.sendMessage(from, text, { mentions });
    return true;
  },
  
  async groupinfo(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    
    await sendReply(client, from,
      `*${chat.name}*\n` +
      `ID: ${chat.id._serialized}\n` +
      `Members: ${chat.participants.length}\n` +
      `Description: ${chat.description || 'None'}`,
      sessionId
    );
    return true;
  },
  
  async admins(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ Groups only.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ Groups only.', sessionId);
    
    const adminIds = await getGroupAdmins(chat);
    let text = `👑 *Group Admins (${adminIds.length})*\n`;
    
    for (const id of adminIds) {
      try {
        const contact = await client.getContactById(id);
        text += `- ${contact.pushname || contact.number}\n`;
      } catch {
        text += `- ${id.split('@')[0]}\n`;
      }
    }
    
    await sendReply(client, from, text, sessionId);
    return true;
  },
  
  async welcome(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch { 
      return sendReply(client, from, '❌ This command only works in groups.', sessionId); 
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    const groupId = chat.id._serialized;
    const prefix = await getSessionPrefix(sessionId);
    const subCmd = args[0]?.toLowerCase();
    
    const getGroupDescription = () => {
      if (chat.description && chat.description.trim() !== '') return chat.description;
      return 'Enjoy your stay!';
    };
    
    if (subCmd === 'on') {
      await setGroupSetting(groupId, 'welcomeEnabled', true);
      const groupName = chat.name || 'this group';
      const groupDesc = getGroupDescription();
      const defaultMsg = `👋 *Welcome to ${groupName}!*\n\n📋 *Group Description:*\n${groupDesc}\n\n✅ Please read the group rules and enjoy your stay!`;
      await setGroupSetting(groupId, 'welcomeMessage', defaultMsg);
      return sendReply(client, from, `✅ *Welcome messages enabled!*\n\nThe following message will be sent to new members:\n\n${defaultMsg}`, sessionId);
    } else if (subCmd === 'off') {
      await setGroupSetting(groupId, 'welcomeEnabled', false);
      return sendReply(client, from, '✅ Welcome messages disabled.', sessionId);
    } else if (args.length > 0) {
      const customMsg = args.join(' ');
      await setGroupSetting(groupId, 'welcomeMessage', customMsg);
      await setGroupSetting(groupId, 'welcomeEnabled', true);
      return sendReply(client, from, `✅ *Custom welcome message set!*\n\n${customMsg}\n\n💡 Tip: Use @user to mention the new member.`, sessionId);
    } else {
      const enabled = await getGroupSetting(groupId, 'welcomeEnabled', false);
      const message = await getGroupSetting(groupId, 'welcomeMessage', 'Not set');
      return sendReply(client, from, 
        `👋 *Welcome Settings*\n\nStatus: ${enabled ? '✅ ON' : '❌ OFF'}\nMessage: ${message}\n\n*Usage:*\n${prefix}welcome on - Enable with default\n${prefix}welcome off - Disable\n${prefix}welcome <text> - Set custom message\n\n💡 Tip: Use @user to mention the new member`,
        sessionId
      );
    }
  },
  
  async goodbye(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch { 
      return sendReply(client, from, '❌ This command only works in groups.', sessionId); 
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    const groupId = chat.id._serialized;
    const prefix = await getSessionPrefix(sessionId);
    const subCmd = args[0]?.toLowerCase();
    
    if (subCmd === 'on') {
      await setGroupSetting(groupId, 'goodbyeEnabled', true);
      const defaultMsg = `😢 @user has left the group. We'll miss you!`;
      await setGroupSetting(groupId, 'goodbyeMessage', defaultMsg);
      return sendReply(client, from, `✅ Goodbye messages enabled.\n\nMessage: ${defaultMsg}`, sessionId);
    } else if (subCmd === 'off') {
      await setGroupSetting(groupId, 'goodbyeEnabled', false);
      return sendReply(client, from, '✅ Goodbye messages disabled.', sessionId);
    } else if (args.length > 0) {
      const customMsg = args.join(' ');
      await setGroupSetting(groupId, 'goodbyeMessage', customMsg);
      await setGroupSetting(groupId, 'goodbyeEnabled', true);
      return sendReply(client, from, `✅ Goodbye message set to:\n\n${customMsg}`, sessionId);
    } else {
      const enabled = await getGroupSetting(groupId, 'goodbyeEnabled', false);
      const message = await getGroupSetting(groupId, 'goodbyeMessage', 'Not set');
      return sendReply(client, from, 
        `🚪 *Goodbye Settings*\n\nStatus: ${enabled ? '✅ ON' : '❌ OFF'}\nMessage: ${message}\n\n*Usage:*\n${prefix}goodbye on - Enable with default\n${prefix}goodbye off - Disable\n${prefix}goodbye <text> - Set custom message\n\n💡 Tip: Use @user to mention the leaving member`,
        sessionId
      );
    }
  },
  
  async antistatusmention(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    const senderId = from;
    const isSenderGroupAdmin = await isGroupAdmin(chat, senderId);
    if (!isSenderGroupAdmin) {
      return sendReply(client, from, '❌ Only group admins can use this command.', sessionId);
    }
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need to be a group admin to enforce this.', sessionId);
    }
    
    const groupId = chat.id._serialized;
    const prefix = await getSessionPrefix(sessionId);
    const action = args[0]?.toLowerCase();
    const state = args[1]?.toLowerCase();
    
    if (!action || !state) {
      const current = antiStatusMentionSettings.get(groupId) || { enabled: false, action: 'warn' };
      return sendReply(client, from,
        `📵 *Anti-Status Mention Protection*\n\nStatus: ${current.enabled ? '✅ ON' : '❌ OFF'}\nAction: ${current.action}\n\n*Usage:*\n${prefix}antistatusmention <delete|kick|warn> <on|off>\n\n*Actions:*\n• delete - Delete the status mention\n• kick - Remove the person who mentioned the group\n• warn - Send a warning message\n\n*Example:* ${prefix}antistatusmention kick on`,
        sessionId
      );
    }
    
    if (!['delete', 'kick', 'warn'].includes(action)) {
      return sendReply(client, from, '❌ Action must be: delete, kick, or warn', sessionId);
    }
    if (!['on', 'off'].includes(state)) {
      return sendReply(client, from, '❌ State must be: on or off', sessionId);
    }
    
    antiStatusMentionSettings.set(groupId, { enabled: state === 'on', action });
    await setGroupSetting(groupId, 'antiStatusMention', { enabled: state === 'on', action });
    
    const actionEmoji = action === 'delete' ? '🗑️' : action === 'kick' ? '👢' : '⚠️';
    return sendReply(client, from, 
      `${actionEmoji} Anti-status mention protection ${state === 'on' ? 'enabled' : 'disabled'}\nAction: ${action}`,
      sessionId
    );
  },
  
  // ------------------------------------------------------------
  // SETTINGS COMMANDS
  // ------------------------------------------------------------
  async setprefix(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    const newPrefix = args[0];
    const currentPrefix = await getSessionPrefix(sessionId);
    if (!newPrefix || newPrefix.length > 3) {
      return sendReply(client, from, `❌ Usage: ${currentPrefix}setprefix <symbol>`, sessionId);
    }
    await setSessionSetting(sessionId, 'commandPrefix', newPrefix);
    await sendReply(client, from, `✅ Command prefix changed to "${newPrefix}"`, sessionId);
    return true;
  },
  
  async setfooter(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    const newFooter = args.join(' ');
    const currentPrefix = await getSessionPrefix(sessionId);
    if (!newFooter) {
      return sendReply(client, from, `❌ Usage: ${currentPrefix}setfooter <text>`, sessionId);
    }
    await setSessionSetting(sessionId, 'footerText', newFooter);
    await sendReply(client, from, `✅ Footer updated to:\n"${newFooter}"`, sessionId);
    return true;
  },
  
  async mode(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    const mode = args[0]?.toLowerCase();
    const currentPrefix = await getSessionPrefix(sessionId);
    if (!['private', 'public'].includes(mode)) {
      return sendReply(client, from, `❌ Usage: ${currentPrefix}mode private|public`, sessionId);
    }
    await setSessionSetting(sessionId, 'mode', mode);
    await sendReply(client, from, `✅ Bot mode set to: ${mode}`, sessionId);
    return true;
  },
async alwaysonline(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    const state = args[0]?.toLowerCase();
    const currentPrefix = await getSessionPrefix(sessionId);
    if (!['on', 'off'].includes(state)) {
      return sendReply(client, from, `❌ Usage: ${currentPrefix}alwaysonline on|off`, sessionId);
    }
    await setSessionSetting(sessionId, 'alwaysOnline', state === 'on');
    await sendReply(client, from, `✅ Always Online: ${state.toUpperCase()}`, sessionId);
    return true;
  },
  
  async autoviewstatus(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    const state = args[0]?.toLowerCase();
    const currentPrefix = await getSessionPrefix(sessionId);
    if (!['on', 'off'].includes(state)) {
      return sendReply(client, from, `❌ Usage: ${currentPrefix}autoviewstatus on|off`, sessionId);
    }
    await setSessionSetting(sessionId, 'autoViewStatus', state === 'on');
    await sendReply(client, from, `✅ Auto-View Status: ${state.toUpperCase()}`, sessionId);
    return true;
  },
  
  async reload(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    lastCommandsLoad = 0;
    sessionSettingsCache.clear();
    groupSettingsCache.clear();
    await loadCommandsFromDB();
    const prefix = await getSessionPrefix(sessionId);
    await sendReply(client, from, `✅ Reloaded! ${commandsCache.size} commands available.`, sessionId);
    return true;
  },
  
  async listadmins(client, from, args, message, sessionId) {
    const admins = CONFIG.ADMIN_NUMBERS.length ? CONFIG.ADMIN_NUMBERS.join('\n') : 'No admins configured.';
    await sendReply(client, from, `👑 *Bot Admins:*\n${admins}`, sessionId);
    return true;
  },
  
  // ------------------------------------------------------------
  // NEW ADMIN MANAGEMENT COMMANDS
  // ------------------------------------------------------------
  async addbotadmin(client, from, args, message, sessionId) {
    if (!await isSuperAdmin(from, sessionId) && !isOwner(from)) {
      return sendReply(client, from, '❌ Only super admins or owner can use this command.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = getUserNumber(quoted.author || quoted.from);
    } else if (args[0]) {
      target = formatNumber(args[0]);
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}addbotadmin <number> or reply to user`, sessionId);
    }
    
    const botAdmins = await getSessionSetting(sessionId, 'botAdmins', []);
    if (botAdmins.includes(target)) {
      return sendReply(client, from, `❌ @${target} is already a bot admin.`, sessionId);
    }
    
    botAdmins.push(target);
    await setSessionSetting(sessionId, 'botAdmins', botAdmins);
    await sendReply(client, from, `✅ @${target} added as bot admin.`, sessionId);
    return true;
  },
  
  async listbotadmins(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    const botAdmins = await getSessionSetting(sessionId, 'botAdmins', []);
    if (botAdmins.length === 0) {
      return sendReply(client, from, '📋 No bot admins configured for this session.', sessionId);
    }
    
    let text = `👑 *Bot Admins (${botAdmins.length})*\n`;
    botAdmins.forEach((num, i) => { text += `${i+1}. ${num}\n`; });
    await sendReply(client, from, text, sessionId);
    return true;
  },
  
  async removebotadmin(client, from, args, message, sessionId) {
    if (!await isSuperAdmin(from, sessionId) && !isOwner(from)) {
      return sendReply(client, from, '❌ Only super admins or owner can use this command.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = getUserNumber(quoted.author || quoted.from);
    } else if (args[0]) {
      target = formatNumber(args[0]);
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}removebotadmin <number> or reply to user`, sessionId);
    }
    
    const botAdmins = await getSessionSetting(sessionId, 'botAdmins', []);
    const index = botAdmins.indexOf(target);
    if (index === -1) {
      return sendReply(client, from, `❌ @${target} is not a bot admin.`, sessionId);
    }
    
    botAdmins.splice(index, 1);
    await setSessionSetting(sessionId, 'botAdmins', botAdmins);
    await sendReply(client, from, `✅ @${target} removed from bot admins.`, sessionId);
    return true;
  },
  
  async addsudo(client, from, args, message, sessionId) {
    if (!isOwner(from)) return sendReply(client, from, '❌ Only the owner can use this command.', sessionId);
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = getUserNumber(quoted.author || quoted.from);
    } else if (args[0]) {
      target = formatNumber(args[0]);
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}addsudo <number> or reply to user`, sessionId);
    }
    
    const superAdmins = await getSessionSetting(sessionId, 'superAdmins', []);
    if (superAdmins.includes(target)) {
      return sendReply(client, from, `❌ @${target} is already a super admin.`, sessionId);
    }
    
    superAdmins.push(target);
    await setSessionSetting(sessionId, 'superAdmins', superAdmins);
    await sendReply(client, from, `✅ @${target} added as super admin.`, sessionId);
    return true;
  },
  
  async setsudo(client, from, args, message, sessionId) {
    if (!isOwner(from)) return sendReply(client, from, '❌ Only the owner can use this command.', sessionId);
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = getUserNumber(quoted.author || quoted.from);
    } else if (args[0]) {
      target = formatNumber(args[0]);
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}setsudo <number> or reply to user`, sessionId);
    }
    
    // Set as primary owner for this session
    await setSessionSetting(sessionId, 'primaryOwner', target);
    await sendReply(client, from, `✅ @${target} set as primary owner for this session.`, sessionId);
    return true;
  },
  
  async ownerinfo(client, from, args, message, sessionId) {
    const primaryOwner = await getSessionSetting(sessionId, 'primaryOwner', CONFIG.OWNER_NUMBER);
    const ownerInfo = await getSessionSetting(sessionId, 'ownerInfo', {
      name: 'HDM Bot Owner',
      number: primaryOwner,
      email: 'owner@hdm-bot.com',
      website: 'https://hdm-bot.com'
    });
    
    const text = `👑 *BOT OWNER INFO*\n👤 Name: ${ownerInfo.name}\n📱 Contact: +${ownerInfo.number}\n📧 Email: ${ownerInfo.email}\n🌐 Website: ${ownerInfo.website}`;
    await sendReply(client, from, text, sessionId);
    return true;
  },
  // ------------------------------------------------------------
  // NEW BUG SYSTEM COMMANDS
  // ------------------------------------------------------------
  async addbuguser(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = getUserNumber(quoted.author || quoted.from);
    } else if (args[0]) {
      target = formatNumber(args[0]);
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}addbuguser <number> or reply to user`, sessionId);
    }
    
    const bugUsers = await getSessionSetting(sessionId, 'bugUsers', []);
    if (bugUsers.includes(target)) {
      return sendReply(client, from, `❌ @${target} is already a bug user.`, sessionId);
    }
    
    bugUsers.push(target);
    await setSessionSetting(sessionId, 'bugUsers', bugUsers);
    await sendReply(client, from, `✅ @${target} added to bug users.`, sessionId);
    return true;
  },
  
  async listbugusers(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    const bugUsers = await getSessionSetting(sessionId, 'bugUsers', []);
    const envUsers = CONFIG.BUG_ALLOWED_USERS;
    const allUsers = [...new Set([...bugUsers, ...envUsers])];
    
    if (allUsers.length === 0) {
      return sendReply(client, from, '📋 No bug users configured for this session.', sessionId);
    }
    
    let text = `🐛 *Bug Users (${allUsers.length})*\n`;
    allUsers.forEach((num, i) => { 
      const source = envUsers.includes(num) ? '[ENV]' : '';
      text += `${i+1}. ${num} ${source}\n`; 
    });
    await sendReply(client, from, text, sessionId);
    return true;
  },
  
  async removebuguser(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = getUserNumber(quoted.author || quoted.from);
    } else if (args[0]) {
      target = formatNumber(args[0]);
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}removebuguser <number> or reply to user`, sessionId);
    }
    
    const bugUsers = await getSessionSetting(sessionId, 'bugUsers', []);
    const index = bugUsers.indexOf(target);
    if (index === -1) {
      return sendReply(client, from, `❌ @${target} is not a bug user.`, sessionId);
    }
    
    bugUsers.splice(index, 1);
    await setSessionSetting(sessionId, 'bugUsers', bugUsers);
    await sendReply(client, from, `✅ @${target} removed from bug users.`, sessionId);
    return true;
  },
  
  async antibug(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    const state = args[0]?.toLowerCase();
    const prefix = await getSessionPrefix(sessionId);
    
    if (!state || !['on', 'off'].includes(state)) {
      const current = await getSessionSetting(sessionId, 'antiBug', false);
      return sendReply(client, from, 
        `🛡️ *Anti-Bug Protection*\nStatus: ${current ? '✅ ON' : '❌ OFF'}\n\nUsage: ${prefix}antibug on/off`,
        sessionId
      );
    }
    
    await setSessionSetting(sessionId, 'antiBug', state === 'on');
    await sendReply(client, from, `✅ Anti-bug protection ${state === 'on' ? 'enabled' : 'disabled'}.`, sessionId);
    return true;
  },
  
  async buglogs(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    const logs = bugLogsCache.get(sessionId) || [];
    if (logs.length === 0) {
      return sendReply(client, from, '📜 No bug logs for this session.', sessionId);
    }
    
    const recentLogs = logs.slice(-10).reverse();
    let text = `🐛 *Recent Bug Logs*\n\n`;
    recentLogs.forEach((log, i) => {
      text += `${i+1}. ${log.attacker} - ${log.command}\n   ${new Date(log.timestamp).toLocaleString()}\n\n`;
    });
    await sendReply(client, from, text, sessionId);
    return true;
  },
  
  async clearbuglogs(client, from, args, message, sessionId) {
    if (!await isSuperAdmin(from, sessionId) && !isOwner(from)) {
      return sendReply(client, from, '❌ Only super admins or owner can clear bug logs.', sessionId);
    }
    
    bugLogsCache.delete(sessionId);
    await sendReply(client, from, '✅ Bug logs cleared for this session.', sessionId);
    return true;
  },
  
  // ------------------------------------------------------------
  // NEW GROUP MODERATION COMMANDS
  // ------------------------------------------------------------
  async onlyadmin(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can use this command.', sessionId);
    }
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to enforce this.', sessionId);
    }
    
    const groupId = chat.id._serialized;
    const state = args[0]?.toLowerCase();
    const prefix = await getSessionPrefix(sessionId);
    
    if (!state || !['on', 'off'].includes(state)) {
      const current = onlyAdminSettings.get(groupId) || false;
      return sendReply(client, from, 
        `🔒 *Admin-Only Messaging*\nStatus: ${current ? '✅ ON' : '❌ OFF'}\n\nUsage: ${prefix}onlyadmin on/off`,
        sessionId
      );
    }
    
    onlyAdminSettings.set(groupId, state === 'on');
    await setGroupSetting(groupId, 'onlyAdmin', state === 'on');
    await sendReply(client, from, `✅ Admin-only messaging ${state === 'on' ? 'enabled' : 'disabled'}.`, sessionId);
    return true;
  },
  
  async kickall(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can use this command.', sessionId);
    }
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to kick members.', sessionId);
    }
    
    const adminIds = await getGroupAdmins(chat);
    const nonAdmins = chat.participants.filter(p => !adminIds.includes(p.id._serialized));
    
    if (nonAdmins.length === 0) {
      return sendReply(client, from, '❌ No non-admin members to kick.', sessionId);
    }
    
    // Simple confirmation (could be enhanced with a proper confirmation system)
    if (args[0] !== 'CONFIRM') {
      return sendReply(client, from, 
        `⚠️ *Kick All Confirmation*\n\nThis will kick ${nonAdmins.length} non-admin members.\n\nType: ${await getSessionPrefix(sessionId)}kickall CONFIRM to proceed.`,
        sessionId
      );
    }
    
    await sendReply(client, from, `🔄 Kicking ${nonAdmins.length} members...`, sessionId);
       // Process in batches of 20
    let kicked = 0;
    for (let i = 0; i < nonAdmins.length; i += 20) {
      const batch = nonAdmins.slice(i, i + 20).map(p => p.id._serialized);
      await chat.removeParticipants(batch);
      kicked += batch.length;
      await new Promise(r => setTimeout(r, 2000));
    }
    
    await sendReply(client, from, `✅ Successfully kicked ${kicked} members.`, sessionId);
    return true;
  },
  
  async groupdesc(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    if (args.length === 0) {
      // View mode
      const desc = chat.description || 'No description set';
      return sendReply(client, from, `📋 *Group Description:*\n${desc}`, sessionId);
    }
    
    // Set mode - check if sender is group admin
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can change the description.', sessionId);
    }
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to change description.', sessionId);
    }
    
    const newDesc = args.join(' ');
    try {
      await chat.setDescription(newDesc);
      await sendReply(client, from, '✅ Group description updated!', sessionId);
    } catch (err) {
      await sendReply(client, from, `❌ Failed: ${err.message}`, sessionId);
    }
    return true;
  },
  
  async members(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    const groupId = chat.id._serialized;
    
    // Check cache
    const cached = memberStatsCache.get(groupId);
    if (cached && Date.now() - cached.timestamp < CONFIG.MEMBERS_CACHE_TTL) {
      return sendReply(client, from, cached.stats, sessionId);
    }
    
    const participants = chat.participants;
    const adminIds = await getGroupAdmins(chat);
    const adminCount = adminIds.length;
    const totalCount = participants.length;
    
    // Country breakdown
    const countryStats = new Map();
    participants.forEach(p => {
      const number = getUserNumber(p.id._serialized);
      const country = getCountryFromNumber(number);
      const key = `${country.flag} ${country.name} (${number.substring(0, country.code?.length || 3)})`;
      countryStats.set(key, (countryStats.get(key) || 0) + 1);
    });
    
    // Sort by count descending
    const sortedCountries = Array.from(countryStats.entries())
      .sort((a, b) => b[1] - a[1]);
    
    let text = `👥 *Group Members Stats*\n\n`;
    text += `📊 Total Members: ${totalCount}\n`;
    text += `👑 Total Admins: ${adminCount}\n\n`;
    text += `🌍 *Members by Country:*\n`;
    
    let otherCount = 0;
    sortedCountries.slice(0, 15).forEach(([country, count]) => {
      text += `${country}: ${count} members\n`;
    });
    
    if (sortedCountries.length > 15) {
      otherCount = sortedCountries.slice(15).reduce((sum, [, c]) => sum + c, 0);
      text += `Other: ${otherCount} members\n`;
    }
    
    // Cache the result
    memberStatsCache.set(groupId, { stats: text, timestamp: Date.now() });
    
    await sendReply(client, from, text, sessionId);
    return true;
  },
  
  async mute(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can mute members.', sessionId);
    }
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to enforce mute.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = quoted.author || quoted.from;
    } else if (args[0] && args[0].startsWith('@')) {
      // Handle mention
      target = args[0].replace('@', '') + '@c.us';
    } else if (args[0]) {
      target = `${formatNumber(args[0])}@c.us`;
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}mute @user <time> or ${prefix}mute <number> <time>\nTime formats: 10m, 1h, 1d`, sessionId);
    }
    
    const timeStr = args[1] || args[0];
    if (!timeStr) {
      return sendReply(client, from, '❌ Please specify a time (e.g., 10m, 1h, 1d)', sessionId);
    }
    
    // Parse time
    const timeMatch = timeStr.match(/^(\d+)([smhd])$/i);
    if (!timeMatch) {
      return sendReply(client, from, '❌ Invalid time format. Use: 10s, 10m, 1h, 1d', sessionId);
    }
    
    const value = parseInt(timeMatch[1]);
    const unit = timeMatch[2].toLowerCase();
    let durationMs;
    switch (unit) {
      case 's': durationMs = value * 1000; break;
      case 'm': durationMs = value * 60 * 1000; break;
      case 'h': durationMs = value * 60 * 60 * 1000; break;
      case 'd': durationMs = value * 24 * 60 * 60 * 1000; break;
      default: durationMs = 0;
    }
    
    const groupId = chat.id._serialized;
    if (!mutedUsers.has(groupId)) mutedUsers.set(groupId, new Map());
    const groupMutes = mutedUsers.get(groupId);
    
    const until = Date.now() + durationMs;
    groupMutes.set(target, { until, by: from });
    
    await sendReply(client, from, `🔇 @${target.split('@')[0]} muted for ${timeStr}.`, sessionId);
    return true;
  },
  
  async unmute(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can unmute members.', sessionId);
    }
    
    let target;
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      target = quoted.author || quoted.from;
    } else if (args[0] && args[0].startsWith('@')) {
      target = args[0].replace('@', '') + '@c.us';
    } else if (args[0]) {
      target = `${formatNumber(args[0])}@c.us`;
    }
    
    if (!target) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}unmute @user or ${prefix}unmute <number>`, sessionId);
    }
    
    const groupId = chat.id._serialized;
    const groupMutes = mutedUsers.get(groupId);
    if (groupMutes) {
      groupMutes.delete(target);
    }
    
    await sendReply(client, from, `🔊 @${target.split('@')[0]} unmuted.`, sessionId);
    return true;
  },
  
  async mutelist(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    const groupId = chat.id._serialized;
    const groupMutes = mutedUsers.get(groupId);
    
    if (!groupMutes || groupMutes.size === 0) {
      return sendReply(client, from, '📋 No muted members in this group.', sessionId);
    }
    
    const now = Date.now();
    const activeMutes = Array.from(groupMutes.entries())
      .filter(([, data]) => data.until > now);
    
    if (activeMutes.length === 0) {
      return sendReply(client, from, '📋 No currently muted members.', sessionId);
    }
let text = `🔇 *Muted Members*\n\n`;
    for (const [userId, data] of activeMutes) {
      const remaining = Math.max(0, data.until - now);
      const minutes = Math.floor(remaining / 60000);
      text += `• @${userId.split('@')[0]} - ${minutes} min remaining\n`;
    }
    
    await sendReply(client, from, text, sessionId);
    return true;
  },
  
  async setwarn(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can set warning limit.', sessionId);
    }
    
    const limit = parseInt(args[0]);
    if (isNaN(limit) || limit < 1 || limit > 10) {
      return sendReply(client, from, '❌ Please provide a limit between 1 and 10.', sessionId);
    }
    
    const groupId = chat.id._serialized;
    await setGroupSetting(groupId, 'warnLimit', limit);
    await sendReply(client, from, `✅ Warning limit set to ${limit}.`, sessionId);
    return true;
  },
  
  // ------------------------------------------------------------
  // NEW BAD WORD FILTER COMMANDS
  // ------------------------------------------------------------
  async antibadword(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can use this command.', sessionId);
    }
    if (!(await isBotGroupAdmin(chat, client))) {
      return sendReply(client, from, '❌ I need admin privileges to enforce this.', sessionId);
    }
    
    const groupId = chat.id._serialized;
    const action = args[0]?.toLowerCase();
    const state = args[1]?.toLowerCase();
    const prefix = await getSessionPrefix(sessionId);
    
    if (!action || !state) {
      const enabled = await getGroupSetting(groupId, 'antiBadWord', false);
      const currentAction = await getGroupSetting(groupId, 'badWordAction', 'delete');
      return sendReply(client, from,
        `🚫 *Bad Word Filter*\nStatus: ${enabled ? '✅ ON' : '❌ OFF'}\nAction: ${currentAction}\n\nUsage: ${prefix}antibadword <delete|warn|kick|mute> <on|off>`,
        sessionId
      );
    }
    
    if (!['delete', 'warn', 'kick', 'mute'].includes(action)) {
      return sendReply(client, from, '❌ Action must be: delete, warn, kick, mute', sessionId);
    }
    if (!['on', 'off'].includes(state)) {
      return sendReply(client, from, '❌ State must be: on, off', sessionId);
    }
    
    await setGroupSetting(groupId, 'antiBadWord', state === 'on');
    await setGroupSetting(groupId, 'badWordAction', action);
    await sendReply(client, from, `✅ Bad word filter ${state === 'on' ? 'enabled' : 'disabled'} (${action}).`, sessionId);
    return true;
  },
  
  async addbadword(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can add bad words.', sessionId);
    }
    
    const word = args[0]?.toLowerCase();
    if (!word) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}addbadword <word>`, sessionId);
    }
    
    const groupId = chat.id._serialized;
    if (!badWordsCache.has(groupId)) {
      const saved = await getGroupSetting(groupId, 'badWords', []);
      badWordsCache.set(groupId, new Set(saved));
    }
    const words = badWordsCache.get(groupId);
    words.add(word);
    
    await setGroupSetting(groupId, 'badWords', Array.from(words));
    await sendReply(client, from, `✅ "${word}" added to bad word list.`, sessionId);
    return true;
  },
  
  async removebadword(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    if (!await isGroupAdmin(chat, from)) {
      return sendReply(client, from, '❌ Only group admins can remove bad words.', sessionId);
    }
    
    const word = args[0]?.toLowerCase();
    if (!word) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}removebadword <word>`, sessionId);
    }
    
    const groupId = chat.id._serialized;
    if (!badWordsCache.has(groupId)) {
      const saved = await getGroupSetting(groupId, 'badWords', []);
      badWordsCache.set(groupId, new Set(saved));
    }
    const words = badWordsCache.get(groupId);
    const removed = words.delete(word);
    
    await setGroupSetting(groupId, 'badWords', Array.from(words));
    await sendReply(client, from, removed ? `✅ "${word}" removed from bad word list.` : `❌ "${word}" not in bad word list.`, sessionId);
    return true;
  },
  
  async listbadword(client, from, args, message, sessionId) {
    let chat;
    try { chat = await message.getChat(); } catch {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    if (!chat.isGroup) return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    
    const groupId = chat.id._serialized;
    if (!badWordsCache.has(groupId)) {
      const saved = await getGroupSetting(groupId, 'badWords', []);
      badWordsCache.set(groupId, new Set(saved));
    }
    const words = badWordsCache.get(groupId);
    
    if (words.size === 0) {
      return sendReply(client, from, '📋 No bad words configured for this group.', sessionId);
    }
    
    const wordList = Array.from(words).join(', ');
    await sendReply(client, from, `🚫 *Bad Words (${words.size})*\n${wordList}`, sessionId);
    return true;
  },
  
  // ------------------------------------------------------------
  // PRIVACY & BROADCAST COMMANDS
  // ------------------------------------------------------------
  async antidelete(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    const state = args[0]?.toLowerCase();
    const prefix = await getSessionPrefix(sessionId);
    
    if (!state || !['on', 'off'].includes(state)) {
      const current = await getSessionSetting(sessionId, 'antiDelete', true);
      return sendReply(client, from, 
        `🗑️ *Anti-Delete Protection*\nStatus: ${current ? '✅ ON' : '❌ OFF'}\n\nUsage: ${prefix}antidelete on/off`,
        sessionId
      );
    }
    
    await setSessionSetting(sessionId, 'antiDelete', state === 'on');
    await sendReply(client, from, `✅ Anti-delete protection ${state === 'on' ? 'enabled' : 'disabled'}.`, sessionId);
    return true;
  },
  
  async poll(client, from, args, message, sessionId) {
    const fullText = args.join(' ');
    const match = fullText.match(/"([^"]+)"\s*"([^"]+)"(?:\s*"([^"]+)")?(?:\s*"([^"]+)")?(?:\s*"([^"]+)")?(?:\s*(\d+[smh]))?/);
    
    if (!match || !match[1] || !match[2]) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, 
        `❌ Usage: ${prefix}poll "Question?" "Option1" "Option2" "Option3" [duration]\nExample: ${prefix}poll "Favorite color?" "Red" "Blue" "Green" 5m`,
        sessionId
      );
    }
    
    const question = match[1];
    const options = [match[2], match[3], match[4], match[5]].filter(Boolean);
    
    let pollText = `📊 *POLL*\n\n${question}\n\n`;
    options.forEach((opt, i) => {
      pollText += `${i+1}️⃣ ${opt}\n`;
    });
    pollText += `\n_Reply with the number to vote!_`;
    
    await client.sendMessage(from, pollText);
    return true;
  },
  
  async broadcast(client, from, args, message, sessionId) {
    if (!await isAdmin(from, sessionId)) return sendReply(client, from, '❌ Admin only.', sessionId);
    
    const broadcastMsg = args.join(' ');
    if (!broadcastMsg) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}broadcast <message>`, sessionId);
    }
    
    // Get all groups where bot is admin
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    
    let sent = 0;
    let failed = 0;
    
    await sendReply(client, from, `📢 Broadcasting to ${groups.length} groups...`, sessionId);
    
    for (const group of groups) {
      try {
        const isAdmin = await isBotGroupAdmin(group, client);
        if (isAdmin) {
          await client.sendMessage(group.id._serialized, `📢 *BROADCAST*\n\n${broadcastMsg}`);
          sent++;
        }
      } catch (err) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    
    await sendReply(client, from, `✅ Broadcast complete!\n📨 Sent: ${sent}\n❌ Failed: ${failed}`, sessionId);
    return true;
  },
  
  // ------------------------------------------------------------
  // PAIR COMMAND
  // ------------------------------------------------------------
  async pair(client, from, args, message, sessionId) {
    const phoneNumber = args[0];
    if (!phoneNumber) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}pair <phone_number>`, sessionId);
    }
    
    const formattedNumber = formatNumber(phoneNumber);
    
    try {
      // Generate a pairing code (WhatsApp's pair code feature)
      const code = await client.pairingCode(formattedNumber);
      
      // Store in cache for verification
      pairingCodes.set(code, { phone: formattedNumber, timestamp: Date.now() });
      
      // Auto-clean after 5 minutes
      setTimeout(() => pairingCodes.delete(code), 5 * 60 * 1000);
      
      await sendReply(client, from, 
        `🔗 *Pairing Code Generated*\n\n📱 Phone: +${formattedNumber}\n🔑 Code: ${code}\n\n_This code expires in 5 minutes. Enter it on the target device to link._`,
        sessionId
      );
    } catch (err) {
      await sendReply(client, from, `❌ Failed to generate pairing code: ${err.message}`, sessionId);
    }
    return true;
  },
// ------------------------------------------------------------
  // AI COMMANDS
  // ------------------------------------------------------------
  async deepseek(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_AI_COMMANDS) return sendReply(client, from, '❌ AI commands disabled.', sessionId);
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}deepseek <question>`, sessionId);
    }
    await sendReply(client, from, '🤖 Thinking...', sessionId);
    const response = await searchDeepSeek(args.join(' '));
    await sendReply(client, from, response, sessionId);
    return true;
  },
  
  async gemini(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_AI_COMMANDS) return sendReply(client, from, '❌ AI commands disabled.', sessionId);
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}gemini <question>`, sessionId);
    }
    await sendReply(client, from, '🧠 Thinking...', sessionId);
    const response = await searchGemini(args.join(' '));
    await sendReply(client, from, response, sessionId);
    return true;
  },
  
  async chatgpt(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_AI_COMMANDS) return sendReply(client, from, '❌ AI commands disabled.', sessionId);
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}chatgpt <question>`, sessionId);
    }
    await sendReply(client, from, '💬 Thinking...', sessionId);
    const response = await searchChatGPT(args.join(' '));
    await sendReply(client, from, response, sessionId);
    return true;
  },

  async claude(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_AI_COMMANDS) return sendReply(client, from, '❌ AI commands disabled.', sessionId);
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}claude <question>`, sessionId);
    }
    await sendReply(client, from, '🧠 Asking Claude...', sessionId);
    const response = await searchClaude(args.join(' '));
    await sendReply(client, from, response, sessionId);
    return true;
  },
  
,

  async ai(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_AI_COMMANDS) return sendReply(client, from, '❌ AI commands disabled.', sessionId);
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}ai <question>`, sessionId);
    }
    switch (CONFIG.DEFAULT_AI_MODEL) {
      case 'gemini': return commandHandlers.gemini(client, from, args, message, sessionId);
      case 'chatgpt': return commandHandlers.chatgpt(client, from, args, message, sessionId);
      case 'claude': return commandHandlers.claude(client, from, args, message, sessionId);
      default: return commandHandlers.deepseek(client, from, args, message, sessionId);
    }
  },
  
  // ------------------------------------------------------------
  // BUG COMMANDS
  // ------------------------------------------------------------
  async bugmenu(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_BUG_COMMANDS) return sendReply(client, from, '❌ Bug commands disabled.', sessionId);
    
    // Check anti-bug protection
    const antiBugEnabled = await getSessionSetting(sessionId, 'antiBug', false);
    if (antiBugEnabled && !await isUserAllowedForBug(from, sessionId)) {
      // Log attempt
      const logs = bugLogsCache.get(sessionId) || [];
      logs.push({ attacker: getUserNumber(from), command: 'bugmenu', timestamp: new Date().toISOString() });
      bugLogsCache.set(sessionId, logs);
      return sendReply(client, from, '🛡️ Anti-bug protection is enabled. You are not authorized.', sessionId);
    }
    
    if (!await isUserAllowedForBug(from, sessionId)) {
      return sendReply(client, from, '❌ Not authorized.', sessionId);
    }
    
    const prefix = await getSessionPrefix(sessionId);
    await sendReply(client, from,
      `🐛 *BUG MENU*\n\n` +
      `${prefix}bug <number> <message> <count> <interval>\n` +
      `${prefix}stopbug\n\n` +
      `Example: ${prefix}bug 254712345678 "Hello" 50 2`,
      sessionId
    );
    return true;
  },
  
  async bug(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_BUG_COMMANDS) return sendReply(client, from, '❌ Bug commands disabled.', sessionId);
    
    const antiBugEnabled = await getSessionSetting(sessionId, 'antiBug', false);
    if (antiBugEnabled && !await isUserAllowedForBug(from, sessionId)) {
      const logs = bugLogsCache.get(sessionId) || [];
      logs.push({ attacker: getUserNumber(from), command: `bug ${args.join(' ')}`, timestamp: new Date().toISOString() });
      bugLogsCache.set(sessionId, logs);
      return sendReply(client, from, '🛡️ Anti-bug protection is enabled. You are not authorized.', sessionId);
    }
    
    if (!await isUserAllowedForBug(from, sessionId)) {
      return sendReply(client, from, `❌ Not authorized.`, sessionId);
    }
    
    const prefix = await getSessionPrefix(sessionId);
    if (args.length < 4) {
      return sendReply(client, from,
        `❌ Usage: ${prefix}bug <number> <message> <count> <interval>\n` +
        `Example: ${prefix}bug 254712345678 "Hello" 50 2`,
        sessionId
      );
    }
    
    const targetNumber = formatNumber(args[0]);
    const count = parseInt(args[args.length - 2]);
    const interval = parseFloat(args[args.length - 1]);
    const msgText = args.slice(1, -2).join(' ');
    
    if (!targetNumber || targetNumber.length < 10) {
      return sendReply(client, from, '❌ Invalid phone number. Use format: 254712345678', sessionId);
    }
    if (!msgText) return sendReply(client, from, '❌ Please provide a message.', sessionId);
    if (isNaN(count) || count < 1 || count > CONFIG.BUG_MAX_MESSAGES) {
      return sendReply(client, from, `❌ Count must be 1-${CONFIG.BUG_MAX_MESSAGES}.`, sessionId);
    }
    if (isNaN(interval) || interval < 0.01 || interval > 60) {
      return sendReply(client, from, '❌ Interval must be between 0.01 and 60 seconds.', sessionId);
    }
    
    const targetJid = `${targetNumber}@c.us`;
    const intervalMs = Math.floor(interval * 1000);
    
    await startEndlessMessages(client, targetJid, msgText, count, intervalMs, from, sessionId);
    return true;
  },
  
  async stopbug(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_BUG_COMMANDS) return sendReply(client, from, '❌ Bug commands disabled.', sessionId);
    if (!await isUserAllowedForBug(from, sessionId)) {
      return sendReply(client, from, '❌ Not authorized.', sessionId);
    }
    
    await stopAllBugAttacks(client, from);
    return true;
  },
  
  // ------------------------------------------------------------
  // MEDIA COMMANDS
  // ------------------------------------------------------------
  async sticker(client, from, args, message, sessionId) {
    await createSticker(client, message, from, sessionId, args[0] || 'HDM', args[1] || 'Bot');
    return true;
  },
  
  async take(client, from, args, message, sessionId) {
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}take <pack>|<author>`, sessionId);
    }
    await sendReply(client, from, `✅ Sticker metadata set.`, sessionId);
    return true;
  },
};

// ============================================
// DYNAMIC COMMAND & MENU REPLY HANDLING
// ============================================
const processDynamicCommand = async (client, from, commandName, commandData, sessionId) => {
  try {
    if (commandData._id) {
      await Command.findByIdAndUpdate(commandData._id, { $inc: { timesUsed: 1 } });
    }
    await sendReply(client, from, commandData.response, sessionId);
    return true;
  } catch {
    return false;
  }
};

const handleMenuReply = async (client, from, body, message, sessionId) => {
  const userNumber = getUserNumber(from);
  const session = menuSessions.get(userNumber);
  if (!session) return false;
  
  if (Date.now() > session.expires) {
    clearMenuSession(userNumber);
    await sendReply(client, from, '⌛ Menu session expired. Use .menu again.', sessionId);
    return true;
  }
  
  const match = body.trim().match(/^(\d+)$/);
  if (!match) return false;
  
  const num = parseInt(match[1]);
  const item = session.flatCommandList.find(i => i.number === num);
  
  if (!item) {
    await sendReply(client, from,
      `❌ Invalid number. Choose 1-${session.flatCommandList.length}`,
      sessionId
    );
    return true;
  }
  
  clearMenuSession(userNumber);
  const cmd = item.command;
  
  try {
    if (cmd.isDynamic) {
      await processDynamicCommand(client, from, cmd.name, cmd, sessionId);
    } else if (commandHandlers[cmd.name]) {
      await commandHandlers[cmd.name](client, from, [], message, sessionId);
    }
  } catch (err) {
    await sendReply(client, from, `❌ Command failed: ${err.message}`, sessionId);
  }
  
  return true;
};

// ============================================
// MAIN COMMAND EXECUTOR
// ============================================
async function executeCommand(client, from, message, sessionId = 'default') {
  const body = typeof message === 'string' ? message : message.body;
  if (!body) return false;
  
  if (await handleMenuReply(client, from, body, message, sessionId)) {
    return true;
  }
  
  await loadCommandsFromDB();
  const prefix = await getSessionPrefix(sessionId);
  
  const botNumber = client?.info?.wid?.user;
  const senderNumber = getUserNumber(from);
  const isSelf = botNumber && senderNumber === botNumber;
  
  let effectivePrefix = prefix;
  let commandBody = body;
  
  if (isSelf) {
    if (body.startsWith(prefix + prefix)) {
      effectivePrefix = prefix + prefix;
      commandBody = body.substring(effectivePrefix.length);
    } else if (body.startsWith(prefix)) {
      effectivePrefix = prefix;
      commandBody = body.substring(effectivePrefix.length);
    } else {
      return false;
    }
    console.log(`🔧 [${sessionId}] Self-command: "${effectivePrefix}${commandBody}"`);
  } else {
    if (!body.startsWith(prefix)) return false;
    commandBody = body.substring(prefix.length);
  }
  
  const parts = commandBody.trim().split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  const commandData = commandsCache.get(commandName);
  if (!commandData) {
    if (isSelf) {
      await sendReply(client, from,
        `❌ Unknown command: ${commandName}\nUse ${prefix}menu for available commands.`,
        sessionId
      );
    }
    return false;
  }
// Check adminOnly flag from built-in commands
  if (commandData.adminOnly && !await isAdmin(from, sessionId)) {
    await sendReply(client, from, '❌ This command is for admins only.', sessionId);
    return true;
  }
  
  if (commandData.isAlias && commandData.parent) {
    const parentCmd = commandsCache.get(commandData.parent);
    if (parentCmd) {
      commandData.isDynamic = parentCmd.isDynamic;
      commandData._id = parentCmd._id;
    }
  }
  
  try {
    if (commandData.isDynamic) {
      return await processDynamicCommand(client, from, commandName, commandData, sessionId);
    }
    if (commandHandlers[commandName]) {
      return await commandHandlers[commandName](client, from, args, message, sessionId);
    }
    return false;
  } catch (err) {
    console.error(`❌ Command execution error (${commandName}):`, err);
    await sendReply(client, from, `❌ Command error: ${err.message}`, sessionId);
    return true;
  }
}

// ============================================
// GROUP EVENT HANDLERS
// ============================================
const handleGroupJoin = async (client, notification, sessionId) => {
  try {
    const chat = await client.getChatById(notification.chatId);
    const groupId = chat.id._serialized;
    const welcomeEnabled = await getGroupSetting(groupId, 'welcomeEnabled', false);
    if (!welcomeEnabled) return;
    
    const welcomeMsg = await getGroupSetting(groupId, 'welcomeMessage', 
      `👋 Welcome to *${chat.name}*!\n\n${chat.description || 'Enjoy your stay!'}`
    );
    
    for (const userId of notification.recipientIds) {
      const contact = await client.getContactById(userId);
      const msg = welcomeMsg.replace(/@user/g, `@${contact.number}`);
      await client.sendMessage(notification.chatId, msg, { mentions: [userId] });
    }
  } catch (err) {
    console.error('❌ Welcome handler error:', err.message);
  }
};

const handleGroupLeave = async (client, notification, sessionId) => {
  try {
    const chat = await client.getChatById(notification.chatId);
    const groupId = chat.id._serialized;
    const goodbyeEnabled = await getGroupSetting(groupId, 'goodbyeEnabled', false);
    if (!goodbyeEnabled) return;
    
    const goodbyeMsg = await getGroupSetting(groupId, 'goodbyeMessage', 
      `😢 @user has left the group. We'll miss you!`
    );
    
    const leaver = notification.recipientIds[0];
    const contact = await client.getContactById(leaver);
    const msg = goodbyeMsg.replace(/@user/g, `@${contact.number}`);
    await client.sendMessage(notification.chatId, msg, { mentions: [leaver] });
  } catch (err) {
    console.error('❌ Goodbye handler error:', err.message);
  }
};

// ============================================
// EXPORTS
// ============================================
module.exports = {
  executeCommand,
  loadCommandsFromDB,
  getSessionPrefix,
  getSessionSetting,
  setSessionSetting,
  isCommandMessage,
  sendReply,
  handleGroupJoin,
  handleGroupLeave,
  updatePrefix: async (sessionId) => getSessionPrefix(sessionId),
  updateFooter: async (sessionId) => getSessionSetting(sessionId, 'footerText'),
  getCurrentPrefix: (sessionId) => getSessionPrefix(sessionId),
};