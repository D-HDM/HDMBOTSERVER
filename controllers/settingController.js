const BotSetting = require('../models/BotSetting');

exports.getSettings = async (req, res) => {
  try {
    const settings = await BotSetting.find();
    const settingsObj = {};
    settings.forEach(s => settingsObj[s.key] = s.value);
    
    res.json({ success: true, data: settingsObj });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateSetting = async (req, res) => {
  try {
    const { key, value } = req.body;

    const setting = await BotSetting.findOneAndUpdate(
      { key },
      { key, value, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getSetting = async (req, res) => {
  try {
    const setting = await BotSetting.findOne({ key: req.params.key });
    
    if (!setting) {
      return res.status(404).json({ success: false, error: 'Setting not found' });
    }

    res.json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};