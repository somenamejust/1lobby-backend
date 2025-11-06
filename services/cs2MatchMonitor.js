const cs2Service = require('./cs2Service');
const Lobby = require('../models/Lobby');
const User = require('../models/User');
const cs2ServerPool = require('./cs2ServerPool');

class CS2MatchMonitor {
  constructor() {
    this.activeMonitors = new Map(); // lobbyId -> { intervalId, teamMapping }
  }

  /**
   * Начать мониторинг матча
   */
  startMonitoring(lobbyId, serverHost, serverPort, rconPassword, teamMapping) {
    if (this.activeMonitors.has(lobbyId)) {
      console.log(`[CS2Monitor] Мониторинг для лобби ${lobbyId} уже запущен`);
      return;
    }

    console.log(`[CS2Monitor] Запуск мониторинга для лобби ${lobbyId}`);
    console.log(`[CS2Monitor] Маппинг команд:`, teamMapping);

    const intervalId = setInterval(async () => {
      try {
        await this.checkMatchStatus(lobbyId, serverHost, serverPort, rconPassword, teamMapping);
      } catch (error) {
        console.error(`[CS2Monitor] Ошибка мониторинга лобби ${lobbyId}:`, error.message);
      }
    }, 10000); // Проверяем каждые 10 секунд

    this.activeMonitors.set(lobbyId, { intervalId, teamMapping });
  }

/**
 * Проверить статус матча
 */
async checkMatchStatus(lobbyId, serverHost, serverPort, rconPassword, teamMapping) {
  try {
    console.log(`[CS2Monitor] Проверка лобби ${lobbyId}...`);

    // 🆕 ПРАВИЛЬНЫЙ СПОСОБ: Используем конвары для счёта
    let team2Score = 0; // CT
    let team3Score = 0; // T

    try {
      // Получаем счёт команды 2 (CT)
      const team2Cmd = await cs2Service.executeCommand(
        serverHost,
        serverPort,
        rconPassword,
        'mp_teamscore_1'
      );
      
      // Получаем счёт команды 3 (T)
      const team3Cmd = await cs2Service.executeCommand(
        serverHost,
        serverPort,
        rconPassword,
        'mp_teamscore_2'
      );

      console.log(`[CS2Monitor] Ответ mp_teamscore_1:`, team2Cmd);
      console.log(`[CS2Monitor] Ответ mp_teamscore_2:`, team3Cmd);

      // Парсим ответы (формат: "mp_teamscore_1" = "5")
      const team2Match = team2Cmd.match(/"mp_teamscore_1"\s*=\s*"(\d+)"/);
      const team3Match = team3Cmd.match(/"mp_teamscore_2"\s*=\s*"(\d+)"/);

      if (team2Match) team2Score = parseInt(team2Match[1]);
      if (team3Match) team3Score = parseInt(team3Match[1]);

      console.log(`[CS2Monitor] Счёт: Team2(CT) ${team2Score} - ${team3Score} Team3(T)`);

    } catch (error) {
      console.error(`[CS2Monitor] Ошибка получения счёта:`, error.message);
      return; // Пропускаем эту итерацию
    }

    // Проверяем условия победы (MR12 = первая до 13)
    const winScore = 13;
    let winner = null;

    if (team2Score >= winScore) {
      winner = 'CT';
    } else if (team3Score >= winScore) {
      winner = 'T';
    }

    if (winner) {
      console.log(`[CS2Monitor] 🏆 Победитель определён: ${winner} (CT ${team2Score}:${team3Score} T)`);
      
      // Определяем какая команда из лобби победила
      let winningTeam;
      
      if (teamMapping.CT === 'A' && winner === 'CT') {
        winningTeam = 'A';
      } else if (teamMapping.T === 'A' && winner === 'T') {
        winningTeam = 'A';
      } else {
        winningTeam = 'B';
      }
      
      console.log(`[CS2Monitor] Победила команда из лобби: ${winningTeam}`);
      
      await this.handleMatchEnd(lobbyId, winningTeam, serverHost, serverPort, rconPassword);
    } else {
      console.log(`[CS2Monitor] Игра продолжается: CT ${team2Score} - ${team3Score} T`);
    }

  } catch (error) {
    console.error(`[CS2Monitor] Ошибка проверки статуса:`, error.message);
  }
}

  /**
   * Обработать завершение матча
   */
  async handleMatchEnd(lobbyId, winningTeam, serverHost, serverPort, rconPassword) {
    try {
      console.log(`[CS2Monitor] 🏁 Завершение матча для лобби ${lobbyId}, победитель: команда ${winningTeam}`);

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

      console.log(`[CS2Monitor] Победители (команда ${winningTeam}):`, winners.map(w => w.username));
      console.log(`[CS2Monitor] Проигравшие:`, losers.map(l => l.username));

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

      // 🆕 КИКАЕМ ВСЕХ ИГРОКОВ С СЕРВЕРА
      console.log(`[CS2Monitor] Кикаем всех игроков с сервера...`);
      await cs2Service.kickAll(serverHost, serverPort, rconPassword);

      // 🆕 СБРАСЫВАЕМ КАРТУ И РЕЖИМ
      console.log(`[CS2Monitor] Сбрасываем сервер на de_dust2...`);
      await cs2Service.setMapAndMode(
        serverHost,
        serverPort,
        rconPassword,
        'de_dust2',
        0, // game_type
        1  // game_mode (competitive)
      );

      // Освобождаем CS2 сервер
      if (lobby.cs2ServerId) {
        cs2ServerPool.releaseServer(lobby.cs2ServerId);
        console.log(`[CS2Monitor] ✅ Сервер ${lobby.cs2ServerId} освобождён и готов к новой игре`);
      }

      // Уведомляем через WebSocket
      try {
        const getIO = require('./getIO'); // Создадим отдельный модуль
        const io = getIO();
        if (io) {
          io.in(String(lobbyId)).emit('lobbyUpdated', lobby.toObject());
        }
      } catch (error) {
        console.error('[CS2Monitor] Ошибка отправки через WebSocket:', error.message);
      }

      console.log(`[CS2Monitor] ✅ Матч ${lobbyId} успешно завершён`);

    } catch (error) {
      console.error(`[CS2Monitor] Ошибка обработки завершения матча:`, error);
    }
  }

  /**
   * Остановить мониторинг
   */
  stopMonitoring(lobbyId) {
    const monitor = this.activeMonitors.get(lobbyId);
    if (monitor) {
      clearInterval(monitor.intervalId);
      this.activeMonitors.delete(lobbyId);
      console.log(`[CS2Monitor] Мониторинг для лобби ${lobbyId} остановлен`);
    }
  }

  /**
   * Остановить все мониторинги
   */
  stopAll() {
    for (const [lobbyId, monitor] of this.activeMonitors) {
      clearInterval(monitor.intervalId);
      console.log(`[CS2Monitor] Остановлен мониторинг лобби ${lobbyId}`);
    }
    this.activeMonitors.clear();
  }
}

module.exports = new CS2MatchMonitor();