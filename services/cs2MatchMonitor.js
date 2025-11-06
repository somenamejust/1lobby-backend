const cs2Service = require('./cs2Service');
const Lobby = require('../models/Lobby');
const User = require('../models/User');
const cs2ServerPool = require('./cs2ServerPool');

class CS2MatchMonitor {
  constructor() {
    this.activeMonitors = new Map(); // lobbyId -> intervalId
  }

  /**
   * Начать мониторинг матча
   */
  startMonitoring(lobbyId, serverHost, serverPort, rconPassword) {
    if (this.activeMonitors.has(lobbyId)) {
      console.log(`[CS2Monitor] Мониторинг для лобби ${lobbyId} уже запущен`);
      return;
    }

    console.log(`[CS2Monitor] Запуск мониторинга для лобби ${lobbyId}`);

    const intervalId = setInterval(async () => {
      try {
        await this.checkMatchStatus(lobbyId, serverHost, serverPort, rconPassword);
      } catch (error) {
        console.error(`[CS2Monitor] Ошибка мониторинга лобби ${lobbyId}:`, error);
      }
    }, 10000); // Проверяем каждые 10 секунд

    this.activeMonitors.set(lobbyId, intervalId);
  }

  /**
   * Проверить статус матча
   */
  async checkMatchStatus(lobbyId, serverHost, serverPort, rconPassword) {
    try {
      // Получаем статус сервера
      const status = await cs2Service.executeCommand(
        serverHost, 
        serverPort, 
        rconPassword, 
        'status'
      );

      console.log(`[CS2Monitor] Проверка лобби ${lobbyId}...`);

      // Получаем счёт команд
      const scoreInfo = await cs2Service.executeCommand(
        serverHost, 
        serverPort, 
        rconPassword, 
        'mp_teamname_1; mp_teamname_2'
      );

      // Парсим результат (примерная логика, нужно адаптировать)
      const ctScore = this.extractScore(status, 'CT');
      const tScore = this.extractScore(status, 'TERRORIST');

      console.log(`[CS2Monitor] Счёт: CT ${ctScore} - ${tScore} T`);

      // Проверяем условия победы (например, в режиме MR12 - первая команда до 13 раундов)
      const winScore = 13; // Можно настраивать в зависимости от режима

      let winner = null;
      if (ctScore >= winScore) {
        winner = 'CT';
      } else if (tScore >= winScore) {
        winner = 'T';
      }

      if (winner) {
        console.log(`[CS2Monitor] Победитель определён: ${winner}`);
        await this.handleMatchEnd(lobbyId, winner, serverHost, serverPort, rconPassword);
      }

    } catch (error) {
      console.error(`[CS2Monitor] Ошибка проверки статуса:`, error.message);
    }
  }

  /**
   * Извлечь счёт команды из статуса
   */
  extractScore(statusOutput, teamName) {
    // Примерная логика парсинга - нужно адаптировать под реальный вывод
    const regex = new RegExp(`${teamName}.*?(\\d+)`, 'i');
    const match = statusOutput.match(regex);
    return match ? parseInt(match[1]) : 0;
  }

  /**
   * Обработать завершение матча
   */
  async handleMatchEnd(lobbyId, winningTeam, serverHost, serverPort, rconPassword) {
    try {
      console.log(`[CS2Monitor] Завершение матча для лобби ${lobbyId}, победитель: ${winningTeam}`);

      // Останавливаем мониторинг
      this.stopMonitoring(lobbyId);

      // Получаем лобби
      const lobby = await Lobby.findOne({ id: lobbyId });
      if (!lobby || lobby.status === 'finished') {
        console.log(`[CS2Monitor] Лобби ${lobbyId} уже завершено или не найдено`);
        return;
      }

      // Определяем победителей и проигравших
      const winners = lobby.slots.filter(s => s.user && s.team === winningTeam).map(s => s.user);
      const losers = lobby.slots.filter(s => s.user && s.team !== winningTeam).map(s => s.user);

      const entryFee = lobby.entryFee;

      // Списываем с проигравших
      for (const loser of losers) {
        await User.updateOne({ id: loser.id }, { $inc: { balance: -entryFee } });
        console.log(`[CS2Monitor] С игрока ${loser.username} списано ${entryFee}$`);
      }

      // Начисляем победителям
      const amountToWin = entryFee * (losers.length / winners.length);
      for (const winner of winners) {
        await User.updateOne({ id: winner.id }, { $inc: { balance: amountToWin } });
        console.log(`[CS2Monitor] Игроку ${winner.username} начислено ${amountToWin}$`);
      }

      // Обновляем статус лобби
      lobby.status = 'finished';
      lobby.finishedAt = new Date();
      await lobby.save();

      // Освобождаем CS2 сервер
      if (lobby.cs2ServerId) {
        cs2ServerPool.releaseServer(lobby.cs2ServerId);
        console.log(`[CS2Monitor] Сервер ${lobby.cs2ServerId} освобождён`);
      }

      // Кикаем всех игроков
      await cs2Service.kickAll(serverHost, serverPort, rconPassword);

      // Уведомляем через Socket.IO
      let io = null;

      // Получаем io при первом вызове
      function getIO() {
        if (!io) {
            io = require('../server').io;
        }
        return io;
      }
      try {
        const io = getIO();
        if (io) {
            io.in(String(lobbyId)).emit('lobbyUpdated', lobby.toObject());
        }
      } catch (error) {
        console.error('[CS2Monitor] Ошибка отправки через WebSocket:', error);
      }

      console.log(`[CS2Monitor] Матч ${lobbyId} успешно завершён`);

    } catch (error) {
      console.error(`[CS2Monitor] Ошибка обработки завершения матча:`, error);
    }
  }

  /**
   * Остановить мониторинг
   */
  stopMonitoring(lobbyId) {
    const intervalId = this.activeMonitors.get(lobbyId);
    if (intervalId) {
      clearInterval(intervalId);
      this.activeMonitors.delete(lobbyId);
      console.log(`[CS2Monitor] Мониторинг для лобби ${lobbyId} остановлен`);
    }
  }

  /**
   * Остановить все мониторинги
   */
  stopAll() {
    for (const [lobbyId, intervalId] of this.activeMonitors) {
      clearInterval(intervalId);
      console.log(`[CS2Monitor] Остановлен мониторинг лобби ${lobbyId}`);
    }
    this.activeMonitors.clear();
  }
}

module.exports = new CS2MatchMonitor();