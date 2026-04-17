const { startClient, sendMessage, getConnectionStatus, disconnect } = require('./client');
const { handleIncomingMessage } = require('./messageHandler');
const { processCommand, loadCommands } = require('./commandHandler');
const { processRules, loadRules } = require('./ruleEngine');
const helpers = require('./utils/helpers');

module.exports = {
  // Core functions
  startClient,
  sendMessage,
  getConnectionStatus,
  disconnect,
  
  // Handlers
  handleIncomingMessage,
  processCommand,
  processRules,
  
  // Loaders
  loadCommands,
  loadRules,
  
  // Utilities
  helpers,
};