const { 
  startClient, 
  getConnectionStatus, 
  sendMessage, 
  disconnect 
} = require('./whatsapp/client');

const { loadCommands } = require('./whatsapp/commandHandler');
const { loadRules } = require('./whatsapp/ruleEngine');
const Message = require('./models/Message');

const connectedSockets = new Map();

const initSocket = (io) => {
  io.on('connection', (socket) => {
    const socketId = socket.id;
    connectedSockets.set(socketId, { 
      id: socketId, 
      connectedAt: new Date() 
    });
    
    console.log(`🔌 Client connected: ${socketId} (Total: ${connectedSockets.size})`);

    // Send initial connection status
    const initialStatus = getConnectionStatus();
    socket.emit('hdm:status', initialStatus);

    // ============================================
    // WHATSAPP CONNECTION EVENTS
    // ============================================
    
    socket.on('hdm:connect', async () => {
      console.log(`📱 Connect requested by ${socketId}`);
      try {
        await startClient(io);
        const status = getConnectionStatus();
        socket.emit('hdm:status', status);
        io.emit('hdm:status', status);
      } catch (error) {
        console.error('Connect error:', error);
        socket.emit('hdm:error', { 
          action: 'connect', 
          message: error.message 
        });
      }
    });

    socket.on('hdm:disconnect_wa', async () => {
      console.log(`📱 Disconnect requested by ${socketId}`);
      try {
        await disconnect();
        const status = getConnectionStatus();
        io.emit('hdm:status', status);
      } catch (error) {
        console.error('Disconnect error:', error);
        socket.emit('hdm:error', { 
          action: 'disconnect', 
          message: error.message 
        });
      }
    });

    socket.on('hdm:get_status', (callback) => {
      const status = getConnectionStatus();
      console.log(`📊 Status check: ${status.connected ? 'Connected' : 'Disconnected'}`);
      
      if (typeof callback === 'function') {
        callback(status);
      } else {
        socket.emit('hdm:status', status);
      }
    });

    // ============================================
    // MESSAGE EVENTS
    // ============================================

    socket.on('hdm:send_message', async ({ to, message }, callback) => {
      console.log(`📤 Send message request from ${socketId}`);
      
      try {
        const result = await sendMessage(to, message);
        
        // Save to database
        await Message.create({
          messageId: result.id.id,
          to,
          body: message,
          direction: 'outgoing',
          status: 'sent',
        });

        io.emit('hdm:message_sent', {
          to,
          message,
          messageId: result.id.id,
          timestamp: new Date(),
        });

        if (typeof callback === 'function') {
          callback({ success: true, messageId: result.id.id });
        }
      } catch (error) {
        console.error('Send message error:', error);
        if (typeof callback === 'function') {
          callback({ success: false, error: error.message });
        }
        socket.emit('hdm:error', { 
          action: 'send_message', 
          message: error.message 
        });
      }
    });

    socket.on('hdm:get_messages', async ({ chat, limit = 50 }, callback) => {
      try {
        const query = {};
        if (chat) {
          query.$or = [
            { from: chat },
            { to: chat }
          ];
        }

        const messages = await Message.find(query)
          .sort({ timestamp: -1 })
          .limit(limit)
          .lean();

        if (typeof callback === 'function') {
          callback({ success: true, data: messages });
        } else {
          socket.emit('hdm:messages', messages);
        }
      } catch (error) {
        console.error('Get messages error:', error);
        if (typeof callback === 'function') {
          callback({ success: false, error: error.message });
        }
      }
    });

    // ============================================
    // RELOAD EVENTS
    // ============================================

    socket.on('hdm:reload_commands', async (callback) => {
      try {
        await loadCommands();
        io.emit('hdm:commands_reloaded');
        if (typeof callback === 'function') {
          callback({ success: true });
        }
      } catch (error) {
        console.error('Reload commands error:', error);
        if (typeof callback === 'function') {
          callback({ success: false, error: error.message });
        }
      }
    });

    socket.on('hdm:reload_rules', async (callback) => {
      try {
        await loadRules();
        io.emit('hdm:rules_reloaded');
        if (typeof callback === 'function') {
          callback({ success: true });
        }
      } catch (error) {
        console.error('Reload rules error:', error);
        if (typeof callback === 'function') {
          callback({ success: false, error: error.message });
        }
      }
    });

    // ============================================
    // DISCONNECT
    // ============================================

    socket.on('disconnect', () => {
      connectedSockets.delete(socketId);
      console.log(`🔌 Client disconnected: ${socketId} (Remaining: ${connectedSockets.size})`);
    });
  });

  console.log('✅ Socket.io initialized');
};

module.exports = initSocket;