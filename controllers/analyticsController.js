const Message = require('../models/Message');
const Rule = require('../models/Rule');
const Command = require('../models/Command');

exports.getDashboardStats = async (req, res) => {
  try {
    const totalMessages = await Message.countDocuments();
    const activeRules = await Rule.countDocuments({ enabled: true });
    const totalCommands = await Command.countDocuments();
    
    const recentActivity = await Message.find()
      .sort({ timestamp: -1 })
      .limit(10);

    res.json({
      success: true,
      stats: {
        totalMessages,
        activeRules,
        totalCommands,
        recentActivity,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getMessageAnalytics = async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const dailyStats = await Message.aggregate([
      { $match: { timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            direction: '$direction',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ]);

    res.json({ success: true, data: dailyStats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};