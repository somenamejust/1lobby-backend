const express = require('express');
const router = express.Router();
const Lobby = require('../models/Lobby');
const User = require('../models/User');
const botService = require('../services/botService');

// Маршрут для получения ВСЕХ лобби
// GET /api/lobbies
router.get('/', async (req, res) => {
  try {
    const lobbies = await Lobby.find({ status: { $ne: 'finished' } });
    res.status(200).json(lobbies);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Маршрут для получения ОДНОГО лобби по ID
// GET /api/lobbies/:id
router.get('/:id', async (req, res) => {
  try {
    const lobby = await Lobby.findOne({ id: req.params.id });
    if (!lobby) {
      return res.status(404).json({ message: 'Лобби не найдено' });
    }
    res.status(200).json(lobby);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Маршрут для создания НОВОГО лобби
// POST /api/lobbies
router.post('/', async (req, res) => {
  try {
    const newLobby = new Lobby(req.body); 
    await newLobby.save();
    
    res.status(201).json(newLobby);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера при создании лобби' });
  }
});

router.put('/:id/join', async (req, res) => {
  try {
    const lobbyId = req.params.id;
    const { user: userFromRequest, isSpectator } = req.body;
    const io = req.app.get('socketio');

    console.log('[Бэкенд] Получен следующий объект userFromRequest:', userFromRequest);
    
    if (!userFromRequest?.id) {
      return res.status(400).json({ message: 'User data is incorrect' });
    }

    const lobby = await Lobby.findOne({ id: lobbyId });
    if (!lobby) {
      return res.status(404).json({ message: 'Lobby not found' });
    }

    if (lobby.bannedUsers?.includes(String(userFromRequest.id))) {
      return res.status(403).json({ message: "Вы были исключены из этого лобби." });
    }

    const fullUser = await User.findById(userFromRequest._id);
    if (!fullUser) return res.status(404).json({ message: 'User not found in DB' });

    if (isSpectator) {
      if (!lobby.spectators.some(spec => String(spec._id) === String(fullUser._id))) {
        lobby.spectators.push(fullUser);
        lobby.markModified('spectators');
      }
    } else {
      if (lobby.bannedUsers?.includes(String(userFromRequest.id))) {
        return res.status(403).json({ message: "You have been banned from this lobby." });
      }
      if (lobby.slots.some(slot => slot.user?.id === userFromRequest.id)) {
        return res.status(200).json(lobby.toObject());
      }

      const freeSlotIndex = lobby.slots.findIndex(slot => !slot.user);
      if (freeSlotIndex === -1) {
        return res.status(400).json({ message: 'Lobby is full' });
      }

      const userForCheck = await User.findOne({ id: userFromRequest.id });
      if (!userForCheck || userForCheck.balance < lobby.entryFee) {
          return res.status(403).json({ message: "You do not have enough funds to join." });
      }

      lobby.slots[freeSlotIndex].user = { 
        id: userFromRequest.id, _id: userFromRequest._id, email: userFromRequest.email,
        username: userFromRequest.username, avatarUrl: userFromRequest.avatarUrl, isReady: false 
      };
      lobby.players = lobby.slots.filter(s => s.user).length;
      lobby.markModified('slots');
    }
    
    const updatedLobby = await lobby.save();
    
    io.in(String(lobbyId)).emit('lobbyUpdated', updatedLobby.toObject());
    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Error joining lobby:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id/leave', async (req, res) => {
  try {
    const { userId } = req.body;
    const lobby = await Lobby.findOne({ id: req.params.id });
    const io = req.app.get('socketio');
    const roomName = String(req.params.id);

    if (!lobby) return res.status(200).json({ message: "Lobby already deleted." });

    // 🆕 НЕ ПОЗВОЛЯЕМ ВЫХОДИТЬ ИЗ ЗАВЕРШЕННЫХ ЛОББИ
    if (lobby.status === 'finished' || lobby.status === 'cancelled') {
      console.log(`[Leave] Игрок ${userId} пытается выйти из завершенного лобби ${lobby.id}`);
      // Просто возвращаем успех, но не меняем лобби
      return res.status(200).json({ 
        message: "Cannot leave finished lobby", 
        lobby: lobby.toObject() 
      });
    }

    const isHostLeaving = String(lobby.host.id) === String(userId);

    if (isHostLeaving) {
      // Освобождаем бота если он был назначен
      if (lobby.botAccountId && lobby.botServerId) {
        try {
          const server = botService.getAvailableBotServer();
          await botService.releaseLobby(lobby.botAccountId, server.url);
          console.log(`[Bot] ✅ Хост покинул лобби ${lobby.id}, бот освобожден (Dota Lobby ID: ${lobby.botAccountId})`);
        } catch (error) {
          console.error('[Bot] ⚠️ Ошибка освобождения бота при выходе хоста:', error.message);
        }
      }

      io.in(roomName).emit('lobbyDeleted', { message: 'The host has left the lobby.' });
      await Lobby.deleteOne({ id: req.params.id });
      return res.status(200).json({ message: "Lobby deleted." });
    }

    const initialCount = lobby.slots.filter(s => s.user).length + lobby.spectators.length;

    lobby.slots = lobby.slots.map(slot => {
      if (slot.user?.id === userId) return { ...slot, user: null };
      return slot;
    });

    lobby.spectators = lobby.spectators.filter(spec => spec.id !== userId);
    
    const finalPlayerCount = lobby.slots.filter(s => s.user).length;
    const finalSpectatorCount = lobby.spectators.length;
    const finalTotalCount = finalPlayerCount + finalSpectatorCount;

    if (finalTotalCount === initialCount) {
      return res.status(404).json({ message: "User was not found in the lobby." });
    }
    
    if (finalTotalCount === 0) {
      // Освобождаем бота если он был назначен
      if (lobby.botAccountId && lobby.botServerId) {
        try {
          const server = botService.getAvailableBotServer();
          await botService.releaseLobby(lobby.botAccountId, server.url);
          console.log(`[Bot] ✅ Лобби ${lobby.id} опустело, бот освобожден (Dota Lobby ID: ${lobby.botAccountId})`);
        } catch (error) {
          console.error('[Bot] ⚠️ Ошибка освобождения бота:', error.message);
        }
      }

      io.in(roomName).emit('lobbyDeleted', { message: 'The lobby is now empty.' });
      await Lobby.deleteOne({ id: req.params.id });
      return res.status(200).json({ message: "Lobby deleted." });
    }

    lobby.players = finalPlayerCount;
    lobby.markModified('slots');
    lobby.markModified('spectators');
    const updatedLobby = await lobby.save();

    io.in(roomName).emit('lobbyUpdated', updatedLobby.toObject());
    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Error leaving lobby:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.put('/:id/occupy', async (req, res) => {
  try {
    const { userId, slot: targetSlotInfo } = req.body;
    const lobby = await Lobby.findOne({ id: req.params.id });

    if (!lobby) return res.status(404).json({ message: "Лобби не найдено" });

    const userForCheck = await User.findOne({ id: userId });
    if (userForCheck.balance < lobby.entryFee) {
        return res.status(403).json({ message: "Недостаточно средств, чтобы занять слот." });
    }

    const targetSlot = lobby.slots.find(s => s.team === targetSlotInfo.team && s.position === targetSlotInfo.position);
    if (!targetSlot) return res.status(404).json({ message: "Целевой слот не найден" });
    if (targetSlot.user) return res.status(400).json({ message: "Целевой слот уже занят" });

    const currentSlotIndex = lobby.slots.findIndex(s => s.user?.id === userId);
    const userAsSpectator = lobby.spectators.find(spec => spec.id === userId);
    
    if (currentSlotIndex !== -1) {
      console.log("Игрок перемещается из одного слота в другой.");
      const userToMove = lobby.slots[currentSlotIndex].user;
      lobby.slots[currentSlotIndex].user = null;
      targetSlot.user = userToMove;
    } else if (userAsSpectator) {
      console.log("Наблюдатель переходит в игровой слот.");
      lobby.spectators = lobby.spectators.filter(spec => spec.id !== userId);
      const fullUser = await User.findOne({ id: userId });
      targetSlot.user = {
        id: fullUser.id, _id: fullUser._id, email: fullUser.email,
        username: fullUser.username, avatarUrl: fullUser.avatarUrl, isReady: false
      };
      lobby.markModified('spectators');
    } else {
      return res.status(404).json({ message: "Игрок не найден ни в слотах, ни среди наблюдателей." });
    }

    lobby.players = lobby.slots.filter(s => s.user).length;
    lobby.markModified('slots');
    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());
    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Error occupying slot:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id/vacate', async (req, res) => {
  try {
    const { userId } = req.body;
    const lobby = await Lobby.findOne({ id: req.params.id });

    if (!lobby) return res.status(404).json({ message: "Лобби не найдено" });

    const slotIndex = lobby.slots.findIndex(s => s.user?.id === userId);
    if (slotIndex === -1) return res.status(404).json({ message: "Игрок не найден в слоте" });

    const userToMove = lobby.slots[slotIndex].user;

    lobby.slots[slotIndex].user = null;
    if (!lobby.spectators.some(spec => spec.id === userId)) {
        lobby.spectators.push(userToMove);
    }
    lobby.players = lobby.slots.filter(s => s.user).length;

    lobby.markModified('slots');
    lobby.markModified('spectators');

    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Ошибка при освобождении слота:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id/ready', async (req, res) => {
  try {
    const lobbyId = req.params.id;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: 'Не указан ID пользователя' });
    }

    const lobby = await Lobby.findOne({ id: lobbyId });
    if (!lobby) {
      return res.status(404).json({ message: "Лобби не найдено" });
    }

    const slot = lobby.slots.find(s => s.user?.id === userId);
    if (!slot || !slot.user) {
      return res.status(404).json({ message: "Игрок не найден в этом лобби" });
    }

    slot.user.isReady = !slot.user.isReady;

    const playersInSlots = lobby.slots.filter(s => s.user);
    const areAllPlayersReady = playersInSlots.length === lobby.maxPlayers && playersInSlots.every(p => p.user.isReady);

    if (areAllPlayersReady) {
      lobby.status = 'countdown';
      lobby.countdownStartTime = Date.now();
      console.log(`[Лобби ${lobby.id}] Все готовы! Запуск отсчета.`);
    } else {
      lobby.status = 'waiting';
      lobby.countdownStartTime = null;
      console.log(`[Лобби ${lobby.id}] Отмена готовности. Отсчет остановлен.`);
    }

    lobby.markModified('slots');

    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Ошибка при смене статуса готовности:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id/kick', async (req, res) => {
  try {
    const { hostId, userIdToKick } = req.body;
    const lobby = await Lobby.findOne({ id: req.params.id });
    const io = req.app.get('socketio');
    const roomName = String(req.params.id);

    if (!lobby) return res.status(404).json({ message: "Лобби не найдено" });
    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Только хост может кикать игроков!" });
    }
    if (String(userIdToKick) === String(hostId)) {
      return res.status(400).json({ message: "Хост не может кикнуть сам себя!" });
    }

    lobby.slots = lobby.slots.map(slot => {
      if (slot.user?.id === userIdToKick) {
        return { ...slot, user: null };
      }
      return slot;
    });

    lobby.spectators = lobby.spectators.filter(spec => spec.id !== userIdToKick);
    lobby.players = lobby.slots.filter(s => s.user).length;

    if (!lobby.bannedUsers) lobby.bannedUsers = [];
    if (!lobby.bannedUsers.includes(String(userIdToKick))) {
      lobby.bannedUsers.push(String(userIdToKick));
    }

    lobby.markModified('slots');
    lobby.markModified('spectators');
    lobby.markModified('bannedUsers');

    const updatedLobby = await lobby.save();

    const allSockets = await io.in(roomName).fetchSockets();
    const kickedSocket = allSockets.find(s => s.data?.userId === userIdToKick);

    if (kickedSocket) {
      kickedSocket.emit('youWereKicked', { lobbyId: lobby.id, message: "Вы были исключены из лобби." });
      console.log(`[Кик] Отправлено личное уведомление о кике сокету ${kickedSocket.id}`);
    } else {
      console.log(`[Кик] Сокет для пользователя ${userIdToKick} не найден (возможно, он уже оффлайн).`);
    }

    io.in(roomName).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Ошибка при кике игрока:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/:id/start', async (req, res) => {
  try {
    const lobbyId = req.params.id;
    const { hostId } = req.body;

    console.log('========== START GAME ==========');
    console.log('Lobby ID:', lobbyId);
    console.log('Host ID:', hostId);

    const lobby = await Lobby.findOne({ id: lobbyId });
    if (!lobby) {
      return res.status(404).json({ message: "Lobby not found" });
    }

    console.log('✅ Lobby found:', lobby.title);
    console.log('Game:', lobby.game);
    console.log('Mode:', lobby.mode);
    console.log('BotAccountId:', lobby.botAccountId);
    console.log('Slots:', JSON.stringify(lobby.slots, null, 2));

    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Only the host can start the game!" });
    }

    if (lobby.status === 'in_progress' || lobby.status === 'finished') {
        return res.status(400).json({ message: "The game has already started or is finished." });
    }

    // СНАЧАЛА СОЗДАЕМ ЛОББИ В DOTA 2
    if (lobby.game === 'Dota 2' && !lobby.botAccountId) {
      try {
        console.log('[Bot API] Создание Dota 2 лобби перед стартом...');
        
        // Собираем игроков из слотов
        const radiantSlots = lobby.slots.filter(s => s.user && s.team === 'Radiant');
        const direSlots = lobby.slots.filter(s => s.user && s.team === 'Dire');

        // Проверяем Steam ID
        const radiantPlayers = [];
        const direPlayers = [];

        for (const slot of radiantSlots) {
          const user = await User.findOne({ id: slot.user.id });
          if (user && user.steamId) {
            radiantPlayers.push({
              steamId: user.steamId,
              slot: slot.position
            });
          } else {
            console.log(`⚠️ У игрока ${slot.user.username} нет Steam ID`);
          }
        }

        for (const slot of direSlots) {
          const user = await User.findOne({ id: slot.user.id });
          if (user && user.steamId) {
            direPlayers.push({
              steamId: user.steamId,
              slot: slot.position
            });
          } else {
            console.log(`⚠️ У игрока ${slot.user.username} нет Steam ID`);
          }
        }

        if (radiantPlayers.length === 0 && direPlayers.length === 0) {
          console.log('[Bot API] Нет игроков с Steam ID, пропускаем создание Dota 2 лобби');
        } else {
          // Создаем лобби через Bot API
          const botResult = await botService.createDotaLobby({
            name: lobby._id.toString(),
            password: lobby.password || '',
            region: lobby.dotaRegion || 3,
            gameMode: lobby.dotaGameMode || 22,
            radiantPlayers,
            direPlayers
          });

          // Сохраняем информацию о боте
          lobby.botServerId = botResult.botServerId;
          lobby.botAccountId = botResult.lobbyId;
          await lobby.save();

          console.log(`[Bot API] Dota 2 лобби создано! ID: ${botResult.lobbyId}`);
          
          // 🆕 ЗАПУСКАЕМ МОНИТОРИНГ ЛОББИ БОТОМ
          // Бот автоматически начнёт отслеживать результат игры
          console.log(`[Bot API] Бот начал мониторинг лобби ${lobby.id}`);
        }
      } catch (botError) {
        console.error('[Bot API] Ошибка создания Dota 2 лобби:', botError.message);
        // Не возвращаем ошибку - игра запустится на сайте даже без Dota 2
      }
    }

    // ПОТОМ ЗАПУСКАЕМ ИГРУ (если лобби уже было создано)
    if (lobby.game === 'Dota 2' && lobby.botAccountId) {
      try {
        const server = botService.getAvailableBotServer();
        
        // Ждем 15 секунд чтобы игроки успели зайти
        console.log('[Bot API] Ожидание 15 секунд для входа игроков...');
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        // Проверяем кто зашел
        console.log('[Bot API] Проверка игроков в лобби...');
        const playersStatus = await botService.checkLobbyPlayers(lobby.botAccountId, server.url);
        
        console.log(`[Bot API] В лобби: ${playersStatus.playersInLobby?.length || 0} из ${playersStatus.expectedPlayers} игроков`);
        console.log(`[Bot API] Все зашли: ${playersStatus.allJoined}`);
        
        // Запускаем игру
        await botService.startGame(lobby.botAccountId, server.url);
        console.log(`[Bot API] Игра запущена в Dota 2!`);
        
      } catch (botError) {
        console.error('[Bot API] Ошибка запуска игры в Dota 2:', botError.message);
      }
    }

    // Обновляем статус
    lobby.status = 'in_progress';
    lobby.countdownStartTime = null;
    lobby.startedAt = new Date();

    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Error starting game:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================================
// 🆕 НОВЫЙ ENDPOINT: Автоматическое получение результата от бота
// ========================================

/**
 * POST /api/lobbies/:id/match-result
 * Принимает результат матча от бота после окончания игры в Dota 2
 * Бот автоматически отправляет сюда данные когда игра завершается
 */
// ========================================
// 🔧 ВРЕМЕННАЯ ВЕРСИЯ ДЛЯ ОТЛАДКИ
// ========================================

router.post('/:id/match-result', async (req, res) => {
  try {
    const { lobbyId, botAccountId, matchId, winner, duration, timestamp } = req.body;
    
    console.log('========================================');
    console.log('🏁 [Match Result] Получен результат матча');
    console.log('========================================');
    console.log(`Lobby ID (URL): ${req.params.id}`);
    console.log(`Lobby ID (body): ${lobbyId}`);
    console.log(`Bot Account (body): ${botAccountId}`);
    console.log(`Match ID: ${matchId}`);
    console.log(`Winner: ${winner}`);
    console.log(`Duration: ${duration}s`);
    console.log(`Timestamp: ${new Date(timestamp * 1000).toISOString()}`);
    console.log('========================================');

    // Находим лобби
    const lobby = await Lobby.findById(req.params.id);
    
    if (!lobby) {
      console.error(`❌ [Match Result] Лобби ${req.params.id} не найдено`);
      return res.status(404).json({ 
        success: false,
        message: 'Лобби не найдено' 
      });
    }

    console.log(`✅ [Match Result] Лобби найдено: ${lobby.title} (ID: ${lobby.id}, game: ${lobby.game})`);
    console.log(`🔍 [Debug] Bot Account в базе: ${lobby.botAccountId}`);
    console.log(`🔍 [Debug] Bot Account из запроса: ${botAccountId}`);

    // 🔧 ВРЕМЕННО: СМЯГЧАЕМ ПРОВЕРКУ
    if (lobby.botAccountId && lobby.botAccountId !== botAccountId) {
      console.warn(`⚠️ [Match Result] Bot Account ID не совпадает, но продолжаем...`);
      console.warn(`   Ожидался: ${lobby.botAccountId}`);
      console.warn(`   Получен: ${botAccountId}`);
      // НЕ возвращаем ошибку, продолжаем работу
    }

    // Проверяем что игра ещё не завершена
    if (lobby.status === 'finished' || lobby.status === 'cancelled') {
      console.warn(`⚠️ [Match Result] Лобби ${lobby.id} уже завершено`);
      console.warn(`   Текущий статус: ${lobby.status}`);
      return res.status(200).json({ 
        success: true,
        message: 'Game already finished or cancelled' 
      });
    }

    // Обрабатываем разные типы результатов
    if (winner === 'timeout') {
      console.log(`⏰ [Match Result] Таймаут игры для лобби ${lobby.id}`);
      await handleMatchTimeout(lobby);
      
    } else if (winner === 'unknown') {
      console.log(`❓ [Match Result] Неопределённый результат для лобби ${lobby.id}`);
      await handleMatchCancelled(lobby, 'Game ended abnormally');
      
    } else if (winner === 'radiant' || winner === 'dire') {
      console.log(`🏆 [Match Result] Команда ${winner} победила в лобби ${lobby.id}`);
      
      const winningTeam = winner === 'radiant' ? 'A' : 'B';
      await handleMatchComplete(lobby, winningTeam, matchId, duration);
      
    } else {
      console.error(`❌ [Match Result] Неизвестный тип победителя: ${winner}`);
      return res.status(400).json({ 
        success: false,
        message: 'Invalid winner value' 
      });
    }

    // Освобождаем бота
    console.log(`🤖 [Match Result] Освобождаем бота ${botAccountId}...`);
    try {
      const server = botService.getAvailableBotServer();
      await botService.releaseLobby(lobby.botAccountId || botAccountId, server.url);
      console.log(`✅ [Match Result] Бот успешно освобождён`);
    } catch (error) {
      console.error(`⚠️ [Match Result] Ошибка освобождения бота:`, error.message);
    }

    // WebSocket уведомление
    const io = req.app.get('socketio');
    const freshLobby = await Lobby.findById(req.params.id);
    io.in(lobby.id.toString()).emit('lobbyUpdated', freshLobby.toObject());

    console.log(`✅ [Match Result] Результат успешно обработан для лобби ${lobby.id}`);
    console.log('========================================\n');

    res.status(200).json({ 
      success: true,
      message: 'Match result processed successfully',
      lobby: freshLobby.toObject()
    });

  } catch (error) {
    console.error('========================================');
    console.error("❌ [Match Result] Критическая ошибка обработки результата:");
    console.error(error);
    console.error('========================================\n');
    res.status(500).json({ 
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// ========================================
// Вспомогательные функции для обработки результатов
// ========================================

/**
 * Обрабатывает нормальное завершение матча с победителем
 */
async function handleMatchComplete(lobby, winningTeam, matchId, duration) {
  console.log(`\n💰 [Prize Distribution] Начинаем распределение призов`);
  console.log(`   Лобби: ${lobby.id}`);
  console.log(`   Победитель: Команда ${winningTeam}`);

  // 🆕 Конвертируем radiant/dire в названия команд из лобби
  let actualWinningTeam = winningTeam;
  
  if (lobby.game === 'Dota 2') {
    // Для Dota 2: бот отправляет 'radiant' или 'dire'
    // Нужно конвертировать в 'Radiant' или 'Dire' (с заглавной)
    actualWinningTeam = winningTeam.charAt(0).toUpperCase() + winningTeam.slice(1);
    console.log(`   Победитель (конвертирован): ${actualWinningTeam}`);
  }

  console.log(`   Match ID: ${matchId}`);
  
  // Сохраняем результат
  lobby.matchId = matchId;
  lobby.winner = actualWinningTeam;
  lobby.duration = duration;
  lobby.status = 'finished';
  lobby.finishedAt = new Date();

  // Распределяем призы
  await distributePrizes(lobby, winningTeam);

  await lobby.save();
  
  console.log(`✅ [Match Complete] Лобби ${lobby.id} завершено\n`);
}

/**
 * Обрабатывает таймаут игры (игра длилась слишком долго)
 */
async function handleMatchTimeout(lobby) {
  console.log(`\n⏰ [Timeout] Обработка таймаута игры`);
  console.log(`   Лобби: ${lobby.id}`);
  
  lobby.status = 'cancelled';
  lobby.cancelReason = 'Game timeout - exceeded maximum duration (2 hours)';
  lobby.finishedAt = new Date();

  // Возвращаем ставки всем игрокам
  await refundAllPlayers(lobby);

  await lobby.save();
  
  console.log(`✅ [Timeout] Ставки возвращены всем игрокам\n`);
}

/**
 * Обрабатывает отменённый/некорректно завершённый матч
 */
async function handleMatchCancelled(lobby, reason = 'Game ended abnormally or was cancelled') {
  console.log(`\n❌ [Cancelled] Обработка отменённой игры`);
  console.log(`   Лобби: ${lobby.id}`);
  console.log(`   Причина: ${reason}`);
  
  lobby.status = 'cancelled';
  lobby.cancelReason = reason;
  lobby.finishedAt = new Date();

  // Возвращаем ставки всем игрокам
  await refundAllPlayers(lobby);

  await lobby.save();
  
  console.log(`✅ [Cancelled] Ставки возвращены всем игрокам\n`);
}

/**
 * Распределяет призы между победителями
 */
async function distributePrizes(lobby, winningTeam) {
  const winners = lobby.slots.filter(s => s.user && s.team === winningTeam).map(s => s.user);
  const losers = lobby.slots.filter(s => s.user && s.team !== winningTeam).map(s => s.user);

  if (winners.length === 0) {
    console.error(`❌ [Prizes] Нет победителей в команде ${winningTeam}!`);
    return;
  }

  const totalPrizePool = lobby.entryFee * losers.length;
  const prizePerWinner = totalPrizePool / winners.length;

  console.log(`\n💵 [Prize Pool]`);
  console.log(`   Общий фонд: $${totalPrizePool}`);
  console.log(`   Победителей: ${winners.length}`);
  console.log(`   Проигравших: ${losers.length}`);
  console.log(`   Приз на победителя: $${prizePerWinner.toFixed(2)}`);
  console.log('');

  // Списываем со счетов проигравших
  for (const loser of losers) {
    await User.updateOne(
      { id: loser.id }, 
      { 
        $inc: { 
          balance: -lobby.entryFee,
          losses: 1,
          gamesPlayed: 1
        } 
      }
    );
    console.log(`   ❌ ${loser.username}: -$${lobby.entryFee} (проигрыш)`);
  }

  // Начисляем победителям
  for (const winner of winners) {
    await User.updateOne(
      { id: winner.id }, 
      { 
        $inc: { 
          balance: prizePerWinner,
          wins: 1,
          gamesPlayed: 1
        } 
      }
    );
    console.log(`   ✅ ${winner.username}: +$${prizePerWinner.toFixed(2)} (победа)`);
  }
  
  console.log('');
}

/**
 * Возвращает ставки всем игрокам (при отмене/таймауте)
 */
async function refundAllPlayers(lobby) {
  console.log(`\n💸 [Refund] Возврат ставок`);
  console.log(`   Лобби: ${lobby.id}`);
  console.log(`   Сумма возврата: $${lobby.entryFee} на игрока`);
  console.log('');

  const players = lobby.slots.filter(s => s.user).map(s => s.user);

  for (const player of players) {
    await User.updateOne(
      { id: player.id }, 
      { $inc: { balance: lobby.entryFee } }
    );
    console.log(`   ↩️ ${player.username}: +$${lobby.entryFee} (возврат)`);
  }
  
  console.log('');
}

// ========================================
// СТАРЫЙ ENDPOINT (можно оставить для совместимости или удалить)
// ========================================

/**
 * POST /api/lobbies/:id/declare-winner
 * УСТАРЕВШИЙ: Ручное объявление победителя хостом
 * Рекомендуется использовать автоматический endpoint /match-result
 */
// router.post('/:id/declare-winner', async (req, res) => {
//   try {
//     const { hostId, winningTeam } = req.body;
//     const lobby = await Lobby.findOne({ id: req.params.id });

//     console.log('⚠️ [Manual Winner] Использован ручной endpoint declare-winner');
//     console.log('   Рекомендуется использовать автоматический endpoint /match-result');

//     if (!lobby) return res.status(404).json({ message: "Лобби не найдено" });
//     if (String(lobby.host.id) !== String(hostId)) {
//       return res.status(403).json({ message: "Только хост может определять победителя!" });
//     }
//     if (lobby.status !== 'in_progress') {
//       return res.status(400).json({ message: "Игра не находится в процессе" });
//     }

//     const entryFee = lobby.entryFee;
//     const winners = lobby.slots.filter(s => s.user && s.team === winningTeam).map(s => s.user);
//     const losers = lobby.slots.filter(s => s.user && s.team !== winningTeam).map(s => s.user);
    
//     for (const loser of losers) {
//       await User.updateOne({ id: loser.id }, { $inc: { balance: -entryFee } });
//       console.log(`[Списано] С игрока ${loser.username} списано ${entryFee}$.`);
//     }

//     const amountToWin = entryFee * (losers.length / winners.length);
//     for (const winner of winners) {
//       await User.updateOne({ id: winner.id }, { $inc: { balance: amountToWin } });
//       console.log(`[Начислено] Игроку ${winner.username} начислено ${amountToWin}$.`);
//     }
    
//     lobby.status = 'finished';
//     lobby.finishedAt = new Date();
//     const updatedLobby = await lobby.save();

//     // Освобождаем бота после завершения игры
//     if (lobby.botAccountId && lobby.botServerId) {
//       try {
//         const server = botService.getAvailableBotServer();
//         await botService.releaseLobby(lobby.botAccountId, server.url);
//         console.log(`[Bot] ✅ Лобби ${lobby.id} завершено, бот освобожден (Dota Lobby ID: ${lobby.botAccountId})`);
//       } catch (error) {
//         console.error('[Bot] ❌ Ошибка освобождения бота:', error.message);
//       }
//     }

//     const io = req.app.get('socketio');
//     io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

//     res.status(200).json({ 
//       message: `Команда ${winningTeam} победила!`, 
//       lobby: updatedLobby.toObject()
//     });

//   } catch (error) {
//     console.error("Ошибка при распределении призов:", error);
//     res.status(500).json({ message: 'Ошибка сервера' });
//   }
// });

module.exports = router;