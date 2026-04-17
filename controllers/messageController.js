const Message = require('../models/Message');
const { sendMessage: sendWhatsAppMessage, getConnectionStatus } = require('../whatsapp/client');
const { executeCommand, loadCommandsFromDB } = require('../whatsapp/commandHandler');

// Helper: ensure text is a string
const ensureString = (text) => {
  if (typeof text === 'object' && text !== null && text.text) {
    return String(text.text);
  }
  return String(text || '');
};

// Send message - WITH COMMAND PROCESSING (Fixed)
exports.sendMessage = async (req, res) => {
  try {
    const { to, message } = req.body;
    const userId = req.user?._id || req.user?.id;
    const status = getConnectionStatus();
    const fromNumber = status.phone || 'unknown';

    // Ensure message is a string
    const msgString = ensureString(message);

    // Check if this is a command (starts with .)
    if (msgString.startsWith('.')) {
      console.log(`🔧 API Command detected: ${msgString}`);
      
      await loadCommandsFromDB();
      
      // Create a mock client for command execution
      const mockClient = {
        info: { wid: { user: fromNumber } },
        sendMessage: async (chatId, text) => {
          const safeText = ensureString(text);
          return await sendWhatsAppMessage(to, safeText);
        }
      };
      
      try {
        const executed = await executeCommand(mockClient, `${to}@c.us`, msgString, 'api');
        
        if (executed) {
          return res.json({ 
            success: true, 
            message: 'Command executed',
            command: msgString.split(' ')[0]
          });
        }
        // If command not recognized, fall through to send as regular message
      } catch (err) {
        console.error('Command execution error:', err);
        // Fall through to send as regular message
      }
    }

    // Regular message (not a command, or command not found)
    const result = await sendWhatsAppMessage(to, msgString);

    await Message.create({
      messageId: result.id.id,
      to,
      body: msgString,
      direction: 'outgoing',
      status: 'sent',
      userId
    });

    res.json({ 
      success: true, 
      message: 'Message sent', 
      messageId: result.id.id 
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get messages with pagination
exports.getMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50, chat } = req.query;
    
    const query = {};
    if (chat) {
      query.$or = [
        { from: chat },
        { to: chat }
      ];
    }

    const messages = await Message.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await Message.countDocuments(query);

    res.json({
      success: true,
      data: messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get message statistics
exports.getMessageStats = async (req, res) => {
  try {
    const totalMessages = await Message.countDocuments();
    const incoming = await Message.countDocuments({ direction: 'incoming' });
    const outgoing = await Message.countDocuments({ direction: 'outgoing' });
    
    const last24h = await Message.countDocuments({
      timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    res.json({
      success: true,
      stats: {
        total: totalMessages,
        incoming,
        outgoing,
        last24h
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Import messages from backup (admin only)
exports.importMessages = async (req, res) => {
  try {
    const messages = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ success: false, error: 'Expected array of messages' });
    }

    const cleanedMessages = messages.map(msg => ({
      messageId: msg.messageId || `imported_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      direction: msg.direction,
      isGroup: msg.isGroup || false,
      status: msg.status || 'delivered',
      timestamp: msg.timestamp || new Date(),
    }));

    const result = await Message.insertMany(cleanedMessages, { ordered: false });
    res.json({ success: true, imported: result.length });
  } catch (err) {
    if (err.code === 11000) {
      res.json({ success: true, imported: err.insertedDocs?.length || 0, duplicates: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
};