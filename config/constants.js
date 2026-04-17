module.exports = {
  // Message Status
  MESSAGE_STATUS: {
    PENDING: 'pending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    FAILED: 'failed',
  },
  
  // Connection Status
  CONNECTION_STATUS: {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    QR_READY: 'qr_ready',
    AUTH_FAILED: 'auth_failed',
  },
  
  // Rule Types
  RULE_TYPES: {
    EXACT_MATCH: 'exact_match',
    CONTAINS: 'contains',
    STARTS_WITH: 'starts_with',
    ENDS_WITH: 'ends_with',
    REGEX: 'regex',
    COMMAND: 'command',
  },
  
  // Rule Actions
  RULE_ACTIONS: {
    REPLY: 'reply',
    FORWARD: 'forward',
    REACT: 'react',
    COMMAND: 'command',
  },
  
  // User Roles
  USER_ROLES: {
    ADMIN: 'admin',
    USER: 'user',
    VIEWER: 'viewer',
  },
  
  // WhatsApp Numbers
  WHATSAPP_SUFFIX: '@c.us',
  WHATSAPP_GROUP_SUFFIX: '@g.us',
  
  // Socket Events
  SOCKET_EVENTS: {
    // Client -> Server
    CONNECT: 'hdm:connect',
    DISCONNECT: 'hdm:disconnect',
    RESTART: 'hdm:restart',
    GET_STATUS: 'hdm:get_status',
    SEND_MESSAGE: 'hdm:send_message',
    
    // Server -> Client
    STATUS: 'hdm:status',
    QR: 'hdm:qr',
    READY: 'hdm:ready',
    AUTH_FAILURE: 'hdm:auth_failure',
    DISCONNECTED: 'hdm:disconnected',
    NEW_MESSAGE: 'hdm:new_message',
    MESSAGE_STATUS: 'hdm:message_status',
  },
  
  // Limits
  LIMITS: {
    MAX_MESSAGE_LENGTH: 4096,
    MAX_RULES_PER_USER: 50,
    MAX_BULK_RECIPIENTS: 100,
  },
};