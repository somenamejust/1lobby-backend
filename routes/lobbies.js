const express = require('express');
const router = express.Router();
const Lobby = require('../models/Lobby');
const User = require('../models/User');
const dotaBotService = require('../services/DotaBotService');
const cs2ServerPool = require('../services/cs2ServerPool');
const cs2Service = require('../services/cs2Service');

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
      // Освобождаем Dota 2 бота
      if (lobby.botAccountId && lobby.botServerId) {
        try {
          const server = dotaBotService.getAvailableBotServer();
          await dotaBotService.releaseLobby(lobby.botAccountId, server.url);
          console.log(`[Bot] ✅ Хост покинул лобби ${lobby.id}, бот освобожден`);
        } catch (error) {
          console.error('[Bot] ⚠️ Ошибка освобождения бота:', error.message);
        }
      }

      // Освобождаем CS2 сервер
      if (lobby.cs2ServerId) {
        try {
          console.log(`[CS2] Хост покинул лобби ${lobby.id}, освобождаем сервер ${lobby.cs2ServerId}`);
          cs2ServerPool.releaseServer(lobby.cs2ServerId);
          
          const server = cs2ServerPool.getServerById(lobby.cs2ServerId);
          if (server) {
            await cs2Service.kickAll(server.host, server.port, server.rconPassword);
            console.log(`[CS2] ✅ Сервер ${lobby.cs2ServerId} освобождён и очищен`);
          }
        } catch (error) {
          console.error('[CS2] ⚠️ Ошибка освобождения сервера:', error.message);
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
      // Освобождаем Dota 2 бота
      if (lobby.botAccountId && lobby.botServerId) {
        try {
          const server = dotaBotService.getAvailableBotServer();
          await dotaBotService.releaseLobby(lobby.botAccountId, server.url);
          console.log(`[Bot] ✅ Лобби ${lobby.id} опустело, бот освобожден`);
        } catch (error) {
          console.error('[Bot] ⚠️ Ошибка освобождения бота:', error.message);
        }
      }

      // 🆕 ДОБАВЬ ЭТО: Освобождаем CS2 сервер
      if (lobby.cs2ServerId) {
        try {
          console.log(`[CS2] Лобби ${lobby.id} опустело, освобождаем сервер ${lobby.cs2ServerId}`);
          cs2ServerPool.releaseServer(lobby.cs2ServerId);
          
          const server = cs2ServerPool.getServerById(lobby.cs2ServerId);
          if (server) {
            await cs2Service.kickAll(server.host, server.port, server.rconPassword);
            console.log(`[CS2] ✅ Сервер ${lobby.cs2ServerId} освобождён и очищен`);
          }
        } catch (error) {
          console.error('[CS2] ⚠️ Ошибка освобождения сервера:', error.message);
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

// ========== 🆕 ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ==========
/**
 * Определяет карту CS2 
 * Приоритет: выбор пользователя (lobby.map) → дефолт по режиму
 */
function getCS2MapForMode(lobby) {
  // 1. Если в лобби указана карта - используем её
  if (lobby.map) {
    console.log(`[CS2] Карта из лобби: ${lobby.map}`);
    return lobby.map;
  }
  
  // 2. Иначе выбираем по режиму (на случай старых лобби без map)
  const modeToMap = {
    '1v1': 'de_dust2',
    '2v2': 'de_inferno',
    '3v3': 'de_mirage',
    '5v5': 'de_dust2',
    'Free-for-all': 'de_dust2'
  };
  
  const fallbackMap = modeToMap[lobby.mode] || 'de_dust2';
  console.log(`[CS2] Карта по режиму ${lobby.mode}: ${fallbackMap}`);
  return fallbackMap;
}

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
    console.log('Current Status:', lobby.status);

    // ========== ПРОВЕРКИ БЕЗОПАСНОСТИ ==========
    if (lobby.status === 'in_progress') {
      console.log('⚠️ [Start Game] Игра уже запущена!');
      return res.status(400).json({ message: "Game already in progress" });
    }

    if (lobby.status === 'finished') {
      return res.status(400).json({ message: "The game has already finished." });
    }

    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Only the host can start the game!" });
    }

    // 🆕 ========== СРАЗУ МЕНЯЕМ СТАТУС И ВОЗВРАЩАЕМ ОТВЕТ! ==========
    lobby.status = 'in_progress';
    lobby.countdownStartTime = null;
    lobby.startedAt = new Date();
    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    // 🆕 ВОЗВРАЩАЕМ ОТВЕТ НЕМЕДЛЕННО (модалка появится сразу!)
    res.status(200).json(updatedLobby.toObject());

    // 🆕 ========== ВСЯ НАСТРОЙКА ИДЁТ В ФОНЕ ==========
    
    // ========== DOTA 2 ЛОГИКА ==========
    if (lobby.game === 'Dota 2') {
      
      // СОЗДАЕМ ЛОББИ В DOTA 2
      if (!lobby.botAccountId) {
        try {
          console.log('[Dota 2] Создание лобби...');
          
          const radiantSlots = lobby.slots.filter(s => s.user && s.team === 'A');
          const direSlots = lobby.slots.filter(s => s.user && s.team === 'B');

          console.log(`[Dota 2] Найдено слотов: Radiant (A)=${radiantSlots.length}, Dire (B)=${direSlots.length}`);

          const radiantPlayers = [];
          const direPlayers = [];

          // === RADIANT (TEAM A) ===
          console.log('[DEBUG] === ПРОВЕРКА RADIANT (TEAM A) ===');
          for (const slot of radiantSlots) {
            console.log(`[DEBUG] Проверка игрока Radiant: ${slot.user.username} (ID: ${slot.user.id})`);
            const user = await User.findOne({ id: slot.user.id });
            
            if (!user) {
              console.log(`[DEBUG] ❌ Пользователь ${slot.user.id} НЕ НАЙДЕН в БД!`);
              continue;
            }
            
            console.log(`[DEBUG] Найден в БД: ${user.username}, steamId: ${user.steamId || 'НЕТ'}`);
            
            if (user.steamId) {
              radiantPlayers.push({ steamId: user.steamId, slot: slot.position });
              console.log(`[DEBUG] ✅ Добавлен в Radiant: ${user.steamId}`);
            } else {
              console.log(`[DEBUG] ⚠️ У игрока ${slot.user.username} steamId = ${user.steamId}`);
            }
          }

          // === DIRE (TEAM B) ===
          console.log('[DEBUG] === ПРОВЕРКА DIRE (TEAM B) ===');
          for (const slot of direSlots) {
            console.log(`[DEBUG] Проверка игрока Dire: ${slot.user.username} (ID: ${slot.user.id})`);
            const user = await User.findOne({ id: slot.user.id });
            
            if (!user) {
              console.log(`[DEBUG] ❌ Пользователь ${slot.user.id} НЕ НАЙДЕН в БД!`);
              continue;
            }
            
            console.log(`[DEBUG] Найден в БД: ${user.username}, steamId: ${user.steamId || 'НЕТ'}`);
            
            if (user.steamId) {
              direPlayers.push({ steamId: user.steamId, slot: slot.position });
              console.log(`[DEBUG] ✅ Добавлен в Dire: ${user.steamId}`);
            } else {
              console.log(`[DEBUG] ⚠️ У игрока ${slot.user.username} steamId = ${user.steamId}`);
            }
          }

          console.log(`[DEBUG] === ИТОГО ===`);
          console.log(`[DEBUG] Radiant игроков с Steam ID: ${radiantPlayers.length}`);
          console.log(`[DEBUG] Dire игроков с Steam ID: ${direPlayers.length}`);

          if (radiantPlayers.length === 0 && direPlayers.length === 0) {
            console.log('[Dota 2] ❌ Нет игроков с Steam ID - лобби НЕ создано');
          } else {
            console.log('[Dota 2] 🎮 Отправка запроса на создание лобби в боте...');
            
            const botResult = await dotaBotService.createDotaLobby({
              name: lobby._id.toString(),
              password: lobby.password || '',
              region: lobby.dotaRegion || 3,
              gameMode: lobby.dotaGameMode || 22,
              radiantPlayers,
              direPlayers
            });

            lobby.botServerId = botResult.botServerId;
            lobby.botAccountId = botResult.lobbyId;
            await lobby.save();

            console.log(`[Dota 2] ✅ Лобби создано! Bot Lobby ID: ${botResult.lobbyId}`);
          }
        } catch (botError) {
          console.error('[Dota 2] ❌ Ошибка создания лобби:', botError.message);
          console.error('[Dota 2] Stack trace:', botError.stack);
        }
      }

      // ЗАПУСКАЕМ ИГРУ
      if (lobby.botAccountId) {
        try {
          const server = dotaBotService.getAvailableBotServer();
          
          console.log('[Dota 2] ⏳ Ожидание 15 секунд для входа игроков...');
          await new Promise(resolve => setTimeout(resolve, 15000));
          
          console.log('[Dota 2] 🔍 Проверка игроков в лобби...');
          const playersStatus = await dotaBotService.checkLobbyPlayers(lobby.botAccountId, server.url);
          
          console.log(`[Dota 2] 📊 В лобби: ${playersStatus.playersInLobby?.length || 0} из ${playersStatus.expectedPlayers}`);
          
          console.log('[Dota 2] 🚀 Запуск игры...');
          await dotaBotService.startGame(lobby.botAccountId, server.url);
          console.log(`[Dota 2] ✅ Игра запущена!`);
          
        } catch (botError) {
          console.error('[Dota 2] ❌ Ошибка запуска игры:', botError.message);
        }
      }
    }
    
    // ========== CS2 ЛОГИКА ==========
    else if (lobby.game === 'CS2') {
      let assignedServer = null;
      
      try {
        console.log('[CS2] Запуск CS2 матча...');
        
        // 1. Назначаем сервер
        assignedServer = cs2ServerPool.assignServer(lobby.id);
        console.log(`[CS2] Назначен сервер: ${assignedServer.id} (${assignedServer.host}:${assignedServer.port})`);
        
        // 2. Сохраняем информацию о сервере
        lobby.cs2ServerId = assignedServer.id;
        await lobby.save();
        
        // 3. Определяем карту из лобби
        const mapName = lobby.mapName || getCS2MapForMode(lobby);
        console.log(`[CS2] Карта из лобби: ${mapName}`);
        
        // 4. Очищаем сервер
        console.log('[CS2] Очистка сервера...');
        await cs2Service.cleanupServer(
          assignedServer.host,
          assignedServer.port,
          assignedServer.rconPassword
        );
        
        // 5. Собираем игроков по командам
        console.log('[CS2] Сбор данных игроков...');
        const teamASlots = lobby.slots.filter(s => s.user && s.team === 'A');
        const teamBSlots = lobby.slots.filter(s => s.user && s.team === 'B');
        
        const teamAPlayers = {};
        const teamBPlayers = {};
        
        for (const slot of teamASlots) {
          const user = await User.findOne({ id: slot.user.id });
          if (user?.steamId) {
            teamAPlayers[user.steamId] = user.username;
            console.log(`  [Team A] ${user.username} (${user.steamId})`);
          }
        }
        
        for (const slot of teamBSlots) {
          const user = await User.findOne({ id: slot.user.id });
          if (user?.steamId) {
            teamBPlayers[user.steamId] = user.username;
            console.log(`  [Team B] ${user.username} (${user.steamId})`);
          }
        }
        
        const totalPlayers = Object.keys(teamAPlayers).length + Object.keys(teamBPlayers).length;
        console.log(`[CS2] Игроков с SteamID: ${totalPlayers}`);
        
        // 6. 🆕 ЗАПУСКАЕМ МАТЧ ЧЕРЕЗ MATCHZY CONFIG!
        if (totalPlayers > 0) {
          await cs2Service.startMatchViaConfig(
            lobby.id,
            mapName,
            teamAPlayers,
            teamBPlayers,
            assignedServer.host,
            assignedServer.port,
            assignedServer.rconPassword
          );
          console.log(`[CS2] ✅ Матч запущен! Подключение: connect ${assignedServer.host}:${assignedServer.port}`);
        } else {
          console.log('[CS2] ⚠️ Нет игроков с SteamID');
        }
        
      } catch (cs2Error) {
        console.error('[CS2] ❌ Ошибка запуска матча:', cs2Error.message);
        
        // Освобождаем сервер при ошибке
        if (assignedServer) {
          cs2ServerPool.releaseServer(lobby.id);
        }
      }
    }

  } catch (error) {
    console.error("❌ Error starting game:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================================
// 🆕 ОБЩАЯ ФУНКЦИЯ ОБРАБОТКИ РЕЗУЛЬТАТА
// ========================================
async function processMatchResult(lobbyId, event, io) {
  console.log('🎯 [Process Result] Начинаем обработку результата');
  
  const isMatchZyFormat = event.event === 'series_end';
  
  let winner, matchId, duration;

  if (isMatchZyFormat) {
    console.log('🎮 [MatchZy Format]');
    
    // ДЛЯ CS2: team1 (T) → A, team2 (CT) → B
    if (event.winner.team === 'team1') {
      winner = 'A';  // Terrorists = Team A
    } else if (event.winner.team === 'team2') {
      winner = 'B';  // Counter-Terrorists = Team B
    } else {
      winner = 'unknown';
    }
    
    matchId = event.matchid;
    duration = 0;
    
    console.log(`✅ Конвертировали: ${event.winner.team} → Team ${winner}`);
    
  } else {
    console.log('🤖 [Dota Format]');
    
    // ДЛЯ DOTA 2: radiant → A, dire → B
    if (event.winner === 'radiant') {
      winner = 'A';  // Radiant = Team A
    } else if (event.winner === 'dire') {
      winner = 'B';  // Dire = Team B
    } else {
      winner = event.winner; // timeout, unknown и т.д.
    }
    
    matchId = event.matchId;
    duration = event.duration || 0;
  }

  // Находим лобби (🆕 ИСПРАВЛЕНИЕ: Используем findOne вместо findById)
  const lobby = await Lobby.findOne({ id: lobbyId });
  
  if (!lobby) {
    throw new Error(`Лобби ${lobbyId} не найдено`);
  }

  console.log(`✅ Лобби найдено: ${lobby.title}`);

  // Проверяем статус
  if (lobby.status === 'finished' || lobby.status === 'cancelled') {
    console.warn(`⚠️ Лобби уже завершено (${lobby.status})`);
    return { success: true, message: 'Already finished', lobby };
  }

  // Обрабатываем результат
  if (winner === 'timeout') {
    await handleMatchTimeout(lobby, io); // ✅ Добавили io
  } else if (winner === 'unknown') {
    await handleMatchCancelled(lobby, 'Unknown result', io); // ✅ Добавили io
  } else {
    console.log(`🏆 Победитель: Team ${winner}`);
    await handleMatchComplete(lobby, winner, matchId, duration, io); // ✅ Добавили io
  }

  // Освобождаем ресурсы
  if (lobby.game === 'Dota 2' && lobby.botAccountId) {
    console.log(`🤖 Освобождаем Dota 2 бота...`);
    try {
      const server = dotaBotService.getAvailableBotServer();
      await dotaBotService.releaseLobby(lobby.botAccountId, server.url);
      console.log(`✅ Dota 2 бот освобождён`);
    } catch (error) {
      console.error(`⚠️ Ошибка освобождения бота:`, error.message);
    }
  }
  
  if (lobby.game === 'CS2') {
    console.log(`🎮 CS2 матч завершен, сервер будет освобожден через 10 секунд`);
  }

  console.log(`✅ Результат обработан!\n`);
  
  return { success: true, message: 'Processed', lobby: lobby };
}

// ========================================
// ДИСПЕТЧЕР ОТ MATCHZY (УПРОЩЁННЫЙ!)
// ========================================
router.post('/matchzy-events', async (req, res) => {
  try {
    const event = req.body;
    
    console.log('========================================');
    console.log('🎮 [MatchZy Event] ПОЛНЫЕ ДАННЫЕ:');
    console.log(JSON.stringify(event, null, 2));
    console.log('========================================');

    const eventType = event.event;
    
    if (eventType === 'round_end' || eventType === 'map_result') {
      console.log(`ℹ️ Событие ${eventType} проигнорировано`);
      return res.status(200).json({ success: true, message: 'Event ignored' });
    }

    const matchId = event.matchid;
    if (!matchId) {
      console.log('⚠️ Нет matchid в событии');
      return res.status(400).json({ success: false, error: 'No matchid' });
    }

    const lobby = await Lobby.findOne({
      id: { $gte: matchId * 1000, $lt: (matchId + 1) * 1000 }
    });

    if (!lobby) {
      console.log(`⚠️ Лобби не найдено для matchId: ${matchId}`);
      return res.status(404).json({ success: false, error: 'Lobby not found' });
    }

    if (eventType === 'series_end') {
      console.log('✅ Найдено лобби:', lobby.id);
      
      const io = req.app.get('socketio');
      
      // 🎮 CS2: СРАЗУ отключаем голосование (ДО processMatchResult!)
      if (lobby.game === 'CS2') {
        const cs2Service = require('../services/cs2Service');
        const cs2ServerPool = require('../services/cs2ServerPool');
        const server = cs2ServerPool.getServerByLobby(lobby.id);
        
        if (server) {
          const serverHost = server.host;
          const serverPort = server.port;
          const serverRconPassword = server.rconPassword;
          
          try {
            await cs2Service.executeCommand(
              serverHost, serverPort, serverRconPassword,
              'mp_endmatch_votenextmap 0'
            );
            await cs2Service.executeCommand(
              serverHost, serverPort, serverRconPassword,
              'mp_match_end_changelevel 0'
            );
            console.log('[CS2] ✅ Голосование отключено СРАЗУ после series_end');
          } catch (rconErr) {
            console.error('[CS2] ⚠️ Ошибка отключения голосования:', rconErr.message);
          }
        }
      }
      
      // Обрабатываем результат
      try {
        await processMatchResult(lobby.id, event, io);
      } catch (processError) {
        console.error('❌ [ProcessResult] Ошибка обработки результата:', processError);
      }
      
      // 🎮 CS2: Cleanup через 20 секунд
      if (lobby.game === 'CS2') {
        const cs2Service = require('../services/cs2Service');
        const cs2ServerPool = require('../services/cs2ServerPool');
        const server = cs2ServerPool.getServerByLobby(lobby.id);
        
        if (!server) {
          console.log('[CS2] ⚠️ Сервер не найден в пуле');
          return res.status(200).json({ success: true });
        }
        
        const serverHost = server.host;
        const serverPort = server.port;
        const serverRconPassword = server.rconPassword;
        const lobbyId = lobby.id;
        
        console.log('🎮 CS2 матч завершен, сервер будет очищен через 20 секунд');
        
        setTimeout(async () => {
          try {
            console.log(`[CS2] 🧹 Начинаем очистку для лобби ${lobbyId}`);
            
            try {
              console.log('[CS2] 📋 Получаем список игроков...');
              const statusResponse = await cs2Service.executeCommand(
                serverHost, serverPort, serverRconPassword, 'status'
              );

              console.log('[CS2] Ответ status:', statusResponse.substring(0, 500));

              const lines = statusResponse.split('\n');
              const playerIds = [];

              for (const line of lines) {
                const match = line.match(/^\s*(\d+)\s+\d+:\d+\s+\d+\s+\d+\s+active/);
                
                if (match) {
                  const playerId = match[1];
                  if (!line.includes('BOT') && playerId !== '65535') {
                    playerIds.push(playerId);
                  }
                }
              }

              console.log(`[CS2] Найдено игроков для кика: ${playerIds.length}`);
              if (playerIds.length > 0) {
                console.log(`[CS2] Player IDs: ${playerIds.join(', ')}`);
              }

              for (const playerId of playerIds) {
                console.log(`[CS2] Кикаем игрока с ID: ${playerId}`);
                try {
                  await cs2Service.executeCommand(
                    serverHost, serverPort, serverRconPassword, `kickid ${playerId}`
                  );
                  console.log(`[CS2] ✅ Игрок ${playerId} кикнут`);
                  await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (kickError) {
                  console.error(`[CS2] ⚠️ Ошибка кика игрока ${playerId}:`, kickError.message);
                }
              }

              console.log('[CS2] ✅ Все игроки обработаны');
              
            } catch (kickError) {
              console.error('[CS2] ⚠️ Ошибка кика игроков:', kickError.message);
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('[CS2] Сброс карты на de_dust2...');
            await cs2Service.executeCommand(
              serverHost,
              serverPort,
              serverRconPassword,
              'changelevel de_dust2'
            );
            console.log('[CS2] ✅ Карта сброшена на de_dust2');
            
            cs2ServerPool.releaseServer(lobbyId);
            console.log('[CS2] ✅ Сервер освобожден в пуле');
            
          } catch (error) {
            console.error('[CS2] ❌ Ошибка очистки сервера:', error);
            cs2ServerPool.releaseServer(lobbyId);
          }
        }, 20000);
      }
      
      return res.status(200).json({ success: true });
    }

    console.log(`ℹ️ Неизвестное событие ${eventType} проигнорировано`);
    res.status(200).json({ success: true, message: 'Event received' });

  } catch (error) {
    console.error('❌ [MatchZy] Ошибка:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// ОБРАБОТЧИК РЕЗУЛЬТАТОВ (УПРОЩЁННЫЙ!)
// ========================================
router.post('/:id/match-result', async (req, res) => {
  try {
    const lobbyId = req.params.id;
    const event = req.body;
    
    console.log('========================================');
    console.log('🏁 [Match Result] Получен результат');
    console.log('Lobby ID:', lobbyId);
    console.log('========================================');

    // 🎯 ВЫЗЫВАЕМ ОБЩУЮ ФУНКЦИЮ!
    const io = req.app.get('socketio');
    const result = await processMatchResult(lobbyId, event, io);
    
    res.status(200).json(result);

  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error',
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
async function handleMatchComplete(lobby, winningTeam, matchId, duration, io) {
  console.log(`\n💰 [Prize Distribution] Начинаем распределение призов`);
  console.log(`   Лобби: ${lobby.id}`);
  console.log(`   Игра: ${lobby.game}`);
  console.log(`   Победитель (от бота): ${winningTeam}`);
  console.log(`   Match ID: ${matchId}`);
  
  // Сохраняем результат
  lobby.matchId = matchId;
  lobby.winner = winningTeam;
  lobby.duration = duration;
  lobby.status = 'finished';
  lobby.finishedAt = new Date();

  // Распределяем призы
  await distributePrizes(lobby, winningTeam);

  // ✅ СОХРАНЯЕМ
  const updatedLobby = await lobby.save();
  
  console.log(`✅ [Match Complete] Лобби ${lobby.id} завершено`);
  console.log(`   Победитель: ${winningTeam}`);
  console.log(`   Match ID: ${matchId}`);
  console.log(`   Статус: ${updatedLobby.status}`);

  // ✅ ОТПРАВЛЯЕМ WEBSOCKET
  if (io) {
    try {
      const socketsInRoom = await io.in(String(lobby.id)).fetchSockets();
      console.log(`[WebSocket] 📡 Сокетов в комнате "${lobby.id}": ${socketsInRoom.length}`);
      
      io.in(String(lobby.id)).emit('lobbyUpdated', updatedLobby.toObject());
      console.log('[WebSocket] ✅ Отправлено обновление лобби\n');
    } catch (socketError) {
      console.error('[WebSocket] ❌ Ошибка отправки:', socketError.message);
    }
  } else {
    console.log('[WebSocket] ⚠️ Socket.io недоступен\n');
  }
}

/**
 * Обрабатывает таймаут игры (игра длилась слишком долго)
 */
async function handleMatchTimeout(lobby, io) {
  console.log(`\n⏰ [Timeout] Обработка таймаута игры`);
  console.log(`   Лобби: ${lobby.id}`);
  
  lobby.status = 'cancelled';
  lobby.cancelReason = 'Game timeout - exceeded maximum duration (2 hours)';
  lobby.finishedAt = new Date();

  // Возвращаем ставки всем игрокам
  await refundAllPlayers(lobby);

  const updatedLobby = await lobby.save();
  
  console.log(`✅ [Timeout] Ставки возвращены всем игрокам`);
  
  // ✅ ОТПРАВЛЯЕМ WEBSOCKET
  if (io) {
    io.in(String(lobby.id)).emit('lobbyUpdated', updatedLobby.toObject());
    console.log('[WebSocket] ✅ Отправлено обновление лобби\n');
  }
}

/**
 * Обрабатывает отменённый/некорректно завершённый матч
 */
async function handleMatchCancelled(lobby, reason, io) {
  console.log(`\n❌ [Cancelled] Обработка отменённой игры`);
  console.log(`   Лобби: ${lobby.id}`);
  console.log(`   Причина: ${reason}`);
  
  lobby.status = 'cancelled';
  lobby.cancelReason = reason;
  lobby.finishedAt = new Date();

  // Возвращаем ставки всем игрокам
  await refundAllPlayers(lobby);

  const updatedLobby = await lobby.save();
  
  console.log(`✅ [Cancelled] Ставки возвращены всем игрокам`);
  
  // ✅ ОТПРАВЛЯЕМ WEBSOCKET
  if (io) {
    io.in(String(lobby.id)).emit('lobbyUpdated', updatedLobby.toObject());
    console.log('[WebSocket] ✅ Отправлено обновление лобби\n');
  }
}

/**
 * Распределяет призы между победителями
 */
async function distributePrizes(lobby, winningTeam) {
  console.log(`\n💸 [Prizes] Начинаем распределение`);
  console.log(`   Команда-победитель: ${winningTeam}`);
  console.log(`   Ставка: $${lobby.entryFee}`);

  const entryFee = lobby.entryFee;
  
  // Находим всех игроков
  const winners = lobby.slots.filter(s => s.user && s.team === winningTeam).map(s => s.user);
  const losers = lobby.slots.filter(s => s.user && s.team !== winningTeam).map(s => s.user);

  console.log(`   Победителей: ${winners.length}`);
  console.log(`   Проигравших: ${losers.length}`);

  if (winners.length === 0) {
    console.log(`❌ [Prizes] Нет победителей в команде ${winningTeam}!`);
    return;
  }

  // Списываем с проигравших
  for (const loser of losers) {
    await User.updateOne({ id: loser.id }, { $inc: { balance: -entryFee } });
    console.log(`   💸 Списано $${entryFee} с ${loser.username}`);
  }

  // Начисляем победителям
  const totalPrize = entryFee * losers.length;
  const amountPerWinner = totalPrize / winners.length;
  
  for (const winner of winners) {
    await User.updateOne({ id: winner.id }, { $inc: { balance: amountPerWinner } });
    console.log(`   💰 Начислено $${amountPerWinner.toFixed(2)} игроку ${winner.username}`);
  }

  console.log(`✅ [Prizes] Распределение завершено\n`);
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

module.exports = router;