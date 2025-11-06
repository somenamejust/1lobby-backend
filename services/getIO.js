let io = null;

module.exports = function getIO() {
  if (!io) {
    try {
      io = require('../server').io;
    } catch (error) {
      console.error('[getIO] Ошибка получения io:', error.message);
      return null;
    }
  }
  return io;
};