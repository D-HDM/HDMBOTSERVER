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
  ENABLE_AI_COMMANDS: process.env.ENABLE_AI_COMMANDS !== 'false',
  ENABLE_BUG_COMMANDS: process.env.ENABLE_BUG_COMMANDS !== 'false',
  DEFAULT_AI_MODEL: process.env.DEFAULT_AI_MODEL || 'deepseek',
  BUG_ALLOWED_USERS: (process.env.BUG_ALLOWED_USERS || '').split(',').filter(Boolean),
  BUG_MAX_MESSAGES: parseInt(process.env.BUG_MAX_MESSAGES) || 1000,
  ADMIN_NUMBERS: (process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean),
  SESSION_SETTINGS_CACHE_TTL: 5000,
  MENU_SESSION_TIMEOUT: 60000,
  COMMANDS_CACHE_TTL: 10000,
};

// Default settings for new sessions
const DEFAULT_SETTINGS = {
  commandPrefix: '.',
  mode: 'public',
  footerText: '🤖 HDM Bot • Powered by WA',
  alwaysOnline: false,
  autoViewStatus: false,
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

// ============================================
// UTILITY FUNCTIONS
// ============================================
const getUserNumber = (jid) => jid.split('@')[0];
const isAdmin = (from) => CONFIG.ADMIN_NUMBERS.includes(getUserNumber(from));
const isUserAllowedForBug = (from) => CONFIG.BUG_ALLOWED_USERS.includes(getUserNumber(from)) || isAdmin(from);
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
    // New group commands
    { name: 'welcome', description: '👋 Set welcome message for new members', category: 'group' },
    { name: 'goodbye', description: '🚪 Set goodbye message for leaving members', category: 'group' },
    { name: 'antistatusmention', description: '📵 Anti-status mention protection', category: 'group', adminOnly: true },
    // Settings
    { name: 'setprefix', description: '🔧 Change command prefix', category: 'settings', adminOnly: true },
    { name: 'setfooter', description: '📝 Change footer text', category: 'settings', adminOnly: true },
    { name: 'mode', description: '🔒 Set public/private mode', category: 'settings', adminOnly: true },
    { name: 'alwaysonline', description: '🟢 Toggle always online', category: 'settings', adminOnly: true },
    { name: 'autoviewstatus', description: '👀 Toggle auto-view status', category: 'settings', adminOnly: true },
    { name: 'reload', description: '🔄 Reload commands/rules', category: 'settings', adminOnly: true },
    { name: 'listadmins', description: '📋 List bot admins', category: 'settings', adminOnly: true },
  ];
  
  if (CONFIG.ENABLE_AI_COMMANDS) {
    builtins.push(
      { name: 'deepseek', description: '🤖 Ask DeepSeek AI', category: 'ai' },
      { name: 'gemini', description: '🧠 Ask Gemini AI', category: 'ai' },
      { name: 'chatgpt', description: '💬 Ask ChatGPT', category: 'ai' },
      { name: 'ai', description: '✨ Default AI assistant', category: 'ai' }
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
      bug: { emoji: '🐛', name: 'Testing Tools', cmds: [] },
    };
    
    const allCmds = Array.from(commandsCache.values())
      .filter(c => !c.isAlias)
      .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i);
    
    allCmds.forEach(cmd => {
      const cat = cmd.category || 'general';
      if (categories[cat]) categories[cat].cmds.push(cmd);
    });
    
    let menuText = `╭━━━━━━━━━━━━━━━━━━━━━━╮\n`;
    menuText += `┃   *🤖 HDM BOT MENU*   ┃\n`;
    menuText += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
    
    const flatList = [];
    let counter = 1;
    
    Object.values(categories).forEach(cat => {
      if (cat.cmds.length === 0) return;
      menuText += `*${cat.emoji} ${cat.name}*\n`;
      menuText += `├${'─'.repeat(20)}\n`;
      cat.cmds.sort((a, b) => a.name.localeCompare(b.name)).forEach(cmd => {
        const lock = cmd.adminOnly ? ' 🔒' : '';
        menuText += `│ ${counter.toString().padStart(2)}. ${prefix}${cmd.name}${lock}\n`;
        menuText += `│    ${cmd.description}\n`;
        flatList.push({ number: counter, command: cmd });
        counter++;
      });
      menuText += `╰${'─'.repeat(20)}\n\n`;
    });
    
    menuText += `╭${'─'.repeat(22)}╮\n`;
    menuText += `│ Prefix: ${prefix.padEnd(13)} │\n`;
    menuText += `│ Mode: ${mode.padEnd(15)} │\n`;
    menuText += `│ Online: ${alwaysOnline ? 'ON' : 'OFF'.padEnd(14)} │\n`;
    menuText += `╰${'─'.repeat(22)}╯\n\n`;
    menuText += `_Reply with number (1-${flatList.length}) • Expires 60s_`;
    
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
  // GROUP COMMANDS
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
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
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
  
  // ------------------------------------------------------------
  // NEW GROUP COMMANDS
  // ------------------------------------------------------------
  async welcome(client, from, args, message, sessionId) {
    let chat;
    try { 
      chat = await message.getChat(); 
    } catch { 
      return sendReply(client, from, '❌ This command only works in groups.', sessionId); 
    }
    
    if (!chat.isGroup) {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    
    const groupId = chat.id._serialized;
    const prefix = await getSessionPrefix(sessionId);
    const subCmd = args[0]?.toLowerCase();
    
    const getGroupDescription = () => {
      if (chat.description && chat.description.trim() !== '') {
        return chat.description;
      }
      return 'Enjoy your stay!';
    };
    
    if (subCmd === 'on') {
      await setGroupSetting(groupId, 'welcomeEnabled', true);
      
      const groupName = chat.name || 'this group';
      const groupDesc = getGroupDescription();
      
      const defaultMsg = `👋 *Welcome to ${groupName}!*\n\n` +
                        `📋 *Group Description:*\n${groupDesc}\n\n` +
                        `✅ Please read the group rules and enjoy your stay!`;
      
      await setGroupSetting(groupId, 'welcomeMessage', defaultMsg);
      
      return sendReply(client, from, 
        `✅ *Welcome messages enabled!*\n\n` +
        `The following message will be sent to new members:\n\n${defaultMsg}`,
        sessionId
      );
    } 
    else if (subCmd === 'off') {
      await setGroupSetting(groupId, 'welcomeEnabled', false);
      return sendReply(client, from, '✅ Welcome messages disabled.', sessionId);
    } 
    else if (args.length > 0) {
      const customMsg = args.join(' ');
      await setGroupSetting(groupId, 'welcomeMessage', customMsg);
      await setGroupSetting(groupId, 'welcomeEnabled', true);
      
      return sendReply(client, from, 
        `✅ *Custom welcome message set!*\n\n${customMsg}\n\n` +
        `💡 Tip: Use @user to mention the new member.`,
        sessionId
      );
    } 
    else {
      const enabled = await getGroupSetting(groupId, 'welcomeEnabled', false);
      const message = await getGroupSetting(groupId, 'welcomeMessage', 'Not set');
      return sendReply(client, from, 
        `👋 *Welcome Settings*\n\n` +
        `Status: ${enabled ? '✅ ON' : '❌ OFF'}\n` +
        `Message: ${message}\n\n` +
        `*Usage:*\n` +
        `${prefix}welcome on - Enable with default (includes group description)\n` +
        `${prefix}welcome off - Disable\n` +
        `${prefix}welcome <text> - Set custom message\n\n` +
        `💡 Tip: Use @user to mention the new member`,
        sessionId
      );
    }
  },
  
  async goodbye(client, from, args, message, sessionId) {
    let chat;
    try { 
      chat = await message.getChat(); 
    } catch { 
      return sendReply(client, from, '❌ This command only works in groups.', sessionId); 
    }
    
    if (!chat.isGroup) {
      return sendReply(client, from, '❌ This command only works in groups.', sessionId);
    }
    
    const groupId = chat.id._serialized;
    const prefix = await getSessionPrefix(sessionId);
    const subCmd = args[0]?.toLowerCase();
    
    if (subCmd === 'on') {
      await setGroupSetting(groupId, 'goodbyeEnabled', true);
      const defaultMsg = `😢 @user has left the group. We'll miss you!`;
      await setGroupSetting(groupId, 'goodbyeMessage', defaultMsg);
      return sendReply(client, from, `✅ Goodbye messages enabled.\n\nMessage: ${defaultMsg}`, sessionId);
    } 
    else if (subCmd === 'off') {
      await setGroupSetting(groupId, 'goodbyeEnabled', false);
      return sendReply(client, from, '✅ Goodbye messages disabled.', sessionId);
    } 
    else if (args.length > 0) {
      const customMsg = args.join(' ');
      await setGroupSetting(groupId, 'goodbyeMessage', customMsg);
      await setGroupSetting(groupId, 'goodbyeEnabled', true);
      return sendReply(client, from, `✅ Goodbye message set to:\n\n${customMsg}`, sessionId);
    } 
    else {
      const enabled = await getGroupSetting(groupId, 'goodbyeEnabled', false);
      const message = await getGroupSetting(groupId, 'goodbyeMessage', 'Not set');
      return sendReply(client, from, 
        `🚪 *Goodbye Settings*\n\n` +
        `Status: ${enabled ? '✅ ON' : '❌ OFF'}\n` +
        `Message: ${message}\n\n` +
        `*Usage:*\n` +
        `${prefix}goodbye on - Enable with default\n` +
        `${prefix}goodbye off - Disable\n` +
        `${prefix}goodbye <text> - Set custom message\n\n` +
        `💡 Tip: Use @user to mention the leaving member`,
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
    const isSenderGroupAdmin = chat.participants.find(p => 
      p.id._serialized === senderId && (p.isAdmin || p.isSuperAdmin)
    );
    
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
        `📵 *Anti-Status Mention Protection*\n\n` +
        `Status: ${current.enabled ? '✅ ON' : '❌ OFF'}\n` +
        `Action: ${current.action}\n\n` +
        `*Usage:*\n` +
        `${prefix}antistatusmention <delete|kick|warn> <on|off>\n\n` +
        `*Actions:*\n` +
        `• delete - Delete the status mention\n` +
        `• kick - Remove the person who mentioned the group\n` +
        `• warn - Send a warning message\n\n` +
        `*Example:* ${prefix}antistatusmention kick on`,
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
      `${actionEmoji} Anti-status mention protection ${state === 'on' ? 'enabled' : 'disabled'}\n` +
      `Action: ${action}`,
      sessionId
    );
  },
  
  // ------------------------------------------------------------
  // SETTINGS COMMANDS
  // ------------------------------------------------------------
  async setprefix(client, from, args, message, sessionId) {
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
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
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
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
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
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
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
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
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
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
    if (!isAdmin(from)) return sendReply(client, from, '❌ Admin only.', sessionId);
    lastCommandsLoad = 0;
    sessionSettingsCache.clear();
    groupSettingsCache.clear();
    await loadCommandsFromDB();
    const prefix = await getSessionPrefix(sessionId);
    await sendReply(client, from, `✅ Reloaded! ${commandsCache.size} commands available.`, sessionId);
    return true;
  },
  
  async listadmins(client, from, args, message, sessionId) {
    const admins = CONFIG.ADMIN_NUMBERS.length
      ? CONFIG.ADMIN_NUMBERS.join('\n')
      : 'No admins configured.';
    await sendReply(client, from, `👑 *Bot Admins:*\n${admins}`, sessionId);
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
  
  async ai(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_AI_COMMANDS) return sendReply(client, from, '❌ AI commands disabled.', sessionId);
    if (!args.length) {
      const prefix = await getSessionPrefix(sessionId);
      return sendReply(client, from, `❌ Usage: ${prefix}ai <question>`, sessionId);
    }
    switch (CONFIG.DEFAULT_AI_MODEL) {
      case 'gemini': return commandHandlers.gemini(client, from, args, message, sessionId);
      case 'chatgpt': return commandHandlers.chatgpt(client, from, args, message, sessionId);
      default: return commandHandlers.deepseek(client, from, args, message, sessionId);
    }
  },
  
  // ------------------------------------------------------------
  // BUG COMMANDS
  // ------------------------------------------------------------
  async bugmenu(client, from, args, message, sessionId) {
    if (!CONFIG.ENABLE_BUG_COMMANDS) return sendReply(client, from, '❌ Bug commands disabled.', sessionId);
    if (!isUserAllowedForBug(from)) return sendReply(client, from, '❌ Not authorized.', sessionId);
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
    if (!isUserAllowedForBug(from)) {
      return sendReply(client, from,
        `❌ Not authorized. Allowed: ${CONFIG.BUG_ALLOWED_USERS.join(', ')}`,
        sessionId
      );
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
    if (!isUserAllowedForBug(from)) return sendReply(client, from, '❌ Not authorized.', sessionId);
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
  
  if (commandData.adminOnly && !isAdmin(from)) {
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