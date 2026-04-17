const Command = require('../models/Command');

exports.getCommands = async (req, res) => {
  try {
    const commands = await Command.find();
    res.json({ success: true, data: commands });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.createCommand = async (req, res) => {
  try {
    const command = await Command.create(req.body);
    res.status(201).json({ success: true, data: command });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateCommand = async (req, res) => {
  try {
    const command = await Command.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!command) {
      return res.status(404).json({ success: false, error: 'Command not found' });
    }

    res.json({ success: true, data: command });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteCommand = async (req, res) => {
  try {
    const command = await Command.findByIdAndDelete(req.params.id);

    if (!command) {
      return res.status(404).json({ success: false, error: 'Command not found' });
    }

    res.json({ success: true, message: 'Command deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};