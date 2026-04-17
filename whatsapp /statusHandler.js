let autoViewStatus = false;

const setAutoViewStatus = (value) => {
  autoViewStatus = value;
  console.log(`👁️ Auto-view status: ${value ? 'ON' : 'OFF'}`);
};

const getAutoViewStatus = () => autoViewStatus;

// Handle status updates (called from client event)
const handleStatusUpdate = async (status, client) => {
  if (!autoViewStatus) return;
  try {
    // Mark status as seen
    await client.sendSeen(status.id);
    console.log(`👁️ Auto-viewed status from ${status.participant}`);
  } catch (err) {
    console.error('Status view error:', err.message);
  }
};

module.exports = {
  setAutoViewStatus,
  getAutoViewStatus,
  handleStatusUpdate,
};