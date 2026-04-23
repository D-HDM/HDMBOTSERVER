'use strict';

const logger = require('../utils/logger');
const Message = require('../models/Message');
const { executeCommand, isCommandMessage, getSessionSetting, sendReply } = require('./commandHandler');
const { processRules } = require('./ruleEngine');

// ============================================
// HANDLE INCOMING MESSAGE
// ============================================
const handleMessage = async (client, msg, sessionId, io) => {
  try {
    const from = msg.from;
    const body = msg.body || '';
    const isGroup = msg.from.endsWith('@g.us');

    // ── Auto-view status ──────────────────────────────────
    if (from === 'status@broadcast') {
      const autoView = await getSessionSetting(sessionId, 'autoViewStatus', false);
      if (autoView) {
        try { await msg.getChat(); } catch {}
      }
      return;
    }

    // ── Bot mode check ───────────────────────────────────
    const mode = await getSessionSetting(sessionId, 'mode', 'public');
    const adminNumbers = (process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean);
    const senderNumber = from.split('@')[0];
    if (mode === 'private' && !adminNumbers.includes(senderNumber)) return;

    // ── Mute check (group) ───────────────────────────────
    if (isGroup) {
      const groupId = from;
      // handled inside commandHandler's event listeners
    }

    // ── Persist to DB ────────────────────────────────────
    const chat = await msg.getChat().catch(() => null);
    const isCommand = body ? await isCommandMessage(body, sessionId) : false;

    try {
      await Message.create({
        messageId: msg.id?.id || null,
        sessionId,
        from,
        body,
        type: msg.type || 'text',
        direction: 'incoming',
        status: 'received',
        isGroup: chat?.isGroup || false,
        groupId: chat?.isGroup ? from : null,
        hasMedia: msg.hasMedia || false,
        isCommand,
        commandName: isCommand ? body.trim().split(/\s+/)[0].substring(1).toLowerCase() : null,
        quotedMessageId: msg.hasQuotedMsg ? msg._data?.quotedMsg?.id?.id || null : null,
        timestamp: new Date(msg.timestamp * 1000),
      });
    } catch (dbErr) {
      logger.warn(`[${sessionId}] Failed to persist message: ${dbErr.message}`);
    }

    // ── Emit to dashboard ────────────────────────────────
    if (io) {
      io.emit('hdm:new_message', {
        sessionId,
        from,
        body,
        isGroup: chat?.isGroup || false,
        groupName: chat?.isGroup ? chat.name : null,
        timestamp: new Date(msg.timestamp * 1000).toISOString(),
        isCommand,
        type: msg.type,
        hasMedia: msg.hasMedia,
      });
    }

    // ── Command execution ────────────────────────────────
    if (isCommand) {
      const handled = await executeCommand(client, from, msg, sessionId);
      if (handled) return;
    }

    // ── Auto-reply rules ─────────────────────────────────
    if (body) {
      await processRules(client, msg, from, body, sessionId);
    }
  } catch (err) {
    logger.error(`[${sessionId}] handleMessage error: ${err.message}`, { stack: err.stack });
  }
};

// ============================================
// HANDLE MESSAGE REVOKE (Anti-delete)
// ============================================
const handleMessageRevoke = async (client, after, before, sessionId, io) => {
  try {
    const antiDelete = await getSessionSetting(sessionId, 'antiDelete', true);
    if (!antiDelete || !before) return;

    const from = after?.from || before?.from;
    if (!from) return;

    // Don't restore bot's own deleted messages
    const botNumber = client?.info?.wid?.user;
    const senderNumber = (before?.author || before?.from || '').split('@')[0];
    if (botNumber && senderNumber === botNumber) return;

    // Update DB record
    await Message.findOneAndUpdate(
      { messageId: before?.id?.id },
      {
        isDeleted: true,
        deletedAt: new Date(),
        originalBody: before?.body || null,
      }
    ).catch(() => {});

    const chat = await client.getChatById(from).catch(() => null);
    const isGroup = from.endsWith('@g.us');
    const senderDisplay = senderNumber;

    let restoredBody = before?.body || null;
    const hasMedia = before?.hasMedia || false;

    // Emit to dashboard
    if (io) {
      io.emit('hdm:message_deleted', {
        sessionId,
        from,
        senderNumber,
        originalBody: restoredBody,
        isGroup,
        groupName: isGroup ? chat?.name : null,
        timestamp: new Date().toISOString(),
      });
    }

    if (!restoredBody && !hasMedia) return;

    const header = isGroup
      ? `🗑️ *Anti-Delete* | Group: ${chat?.name || from}\n👤 Sender: @${senderDisplay}\n\n`
      : `🗑️ *Anti-Delete*\n👤 Sender: @${senderDisplay}\n\n`;

    if (restoredBody) {
      await client.sendMessage(from, `${header}📝 *Deleted message:*\n${restoredBody}`);
    } else if (hasMedia) {
      await client.sendMessage(from, `${header}📎 *Deleted a media message (content unavailable)*`);
    }
  } catch (err) {
    logger.error(`[${sessionId}] handleMessageRevoke error: ${err.message}`);
  }
};

module.exports = { handleMessage, handleMessageRevoke };
