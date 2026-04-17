const formatPhone = (number) => {
  const cleaned = number.replace(/\D/g, '');
  return cleaned.startsWith('254') ? cleaned : `254${cleaned.slice(-9)}`;
};

const formatChatId = (number) => {
  return number.includes('@') ? number : `${formatPhone(number)}@c.us`;
};

const isGroup = (chatId) => chatId.includes('@g.us');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseCommand = (message, prefix = '.') => {
  if (!message.startsWith(prefix)) return null;
  const args = message.slice(prefix.length).trim().split(' ');
  const command = args.shift().toLowerCase();
  return { command, args };
};

const truncate = (text, length = 100) => {
  return text.length > length ? text.substring(0, length) + '...' : text;
};

module.exports = {
  formatPhone,
  formatChatId,
  isGroup,
  delay,
  parseCommand,
  truncate,
};