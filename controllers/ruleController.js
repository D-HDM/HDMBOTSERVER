const Rule = require('../models/Rule');

exports.getRules = async (req, res) => {
  try {
    const rules = await Rule.find({ createdBy: req.user._id });
    res.json({ success: true, data: rules });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.createRule = async (req, res) => {
  try {
    const rule = await Rule.create({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateRule = async (req, res) => {
  try {
    const rule = await Rule.findOneAndUpdate(
      { _id: req.params.id, createdBy: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );

    if (!rule) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }

    res.json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteRule = async (req, res) => {
  try {
    const rule = await Rule.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (!rule) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }

    res.json({ success: true, message: 'Rule deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.toggleRule = async (req, res) => {
  try {
    const rule = await Rule.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (!rule) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }

    rule.enabled = !rule.enabled;
    await rule.save();

    res.json({ success: true, data: rule });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};