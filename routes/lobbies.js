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

    // 🆕 ИНТЕГРАЦИЯ С BOT API: Создание лобби в Dota 2
    if (newLobby.game === 'Dota 2') {
      try {
        // Проверяем что у всех игроков в слотах есть Steam ID
        const playersInSlots = newLobby.slots.filter(s => s.user);
        const missingSteamId = [];

        for (const slot of playersInSlots) {
          const user = await User.findOne({ id: slot.user.id });
          if (!user || !user.steamId) {
            missingSteamId.push(slot.user.username);
          }
        }

        if (missingSteamId.length > 0) {
          console.log(`[Bot API] Не удалось создать Dota 2 лобби: у игроков нет Steam ID: ${missingSteamId.join(', ')}`);
          // Лобби создано на сайте, но не в Dota 2
          newLobby.status = 'waiting'; // Можно добавить отдельный статус типа 'no_steam_id'
          await newLobby.save();
          return res.status(201).json(newLobby);
        }

        // Формируем массивы игроков для команд
        const radiantSlots = newLobby.slots.filter(s => s.user && s.team === 'radiant');
        const direSlots = newLobby.slots.filter(s => s.user && s.team === 'dire');

        const radiantPlayers = await Promise.all(
          radiantSlots.map(async (slot, index) => {
            const user = await User.findOne({ id: slot.user.id });
            return {
              steamId: user.steamId,
              slot: index + 1
            };
          })
        );

        const direPlayers = await Promise.all(
          direSlots.map(async (slot, index) => {
            const user = await User.findOne({ id: slot.user.id });
            return {
              steamId: user.steamId,
              slot: index + 1
            };
          })
        );

        // Создаем лобби через Bot API
        const botResult = await botService.createDotaLobby({
          name: newLobby._id.toString(), // MongoDB ID как название
          password: newLobby.password || '',
          region: 8, // Europe West
          gameMode: 23, // All Pick
          radiantPlayers,
          direPlayers
        });

        // Обновляем лобби с информацией о боте
        newLobby.botServerId = botResult.botServerId;
        newLobby.botAccountId = botResult.lobbyId;
        await newLobby.save();

        console.log(`[Bot API] Dota 2 лобби создано успешно! Bot ID: ${botResult.lobbyId}`);
      } catch (botError) {
        console.error('[Bot API] Ошибка при создании Dota 2 лобби:', botError.message);
        // Лобби создано на сайте, но не в Dota 2 - это не критично
        // Игроки смогут играть на сайте, но не в реальной Dota 2
      }
    }

    res.status(201).json(newLobby);
  } catch (error) {
    console.error('Ошибка создания лобби:', error);
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

    const isHostLeaving = String(lobby.host.id) === String(userId);

    if (isHostLeaving) {
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
    } 
    else if (userAsSpectator) {
      console.log("Зритель занимает слот.");
      targetSlot.user = { ...userAsSpectator, isReady: false };
      lobby.spectators = lobby.spectators.filter(spec => spec.id !== userId);
    } 
    else {
      return res.status(404).json({ message: "Пользователь не найден в этом лобби" });
    }

    lobby.players = lobby.slots.filter(s => s.user).length;
    lobby.markModified('slots');
    lobby.markModified('spectators');

    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Ошибка при попытке занять слот:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
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
    const lobbyId = req.params.id;
    const { userIdToKick, hostId } = req.body;
    const io = req.app.get('socketio');
    const roomName = String(lobbyId);

    if (!userIdToKick || !hostId) {
      return res.status(400).json({ message: 'Недостаточно данных для кика' });
    }

    const lobby = await Lobby.findOne({ id: lobbyId });
    if (!lobby) {
      return res.status(404).json({ message: "Лобби не найдено" });
    }

    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Только хост может кикать игроков!" });
    }

    const slotIndex = lobby.slots.findIndex(s => s.user?.id === userIdToKick);
    if (slotIndex !== -1) {
      lobby.bannedUsers.push(userIdToKick);
      lobby.slots[slotIndex].user = null;
      lobby.players = lobby.slots.filter(s => s.user).length;
      lobby.markModified('slots');
      lobby.markModified('bannedUsers');
    } else {
        return res.status(404).json({ message: "Кикаемый игрок не найден в слоте" });
    }

    const updatedLobby = await lobby.save();

    // 🆕 ИНТЕГРАЦИЯ С BOT API: Кик из Dota 2 лобби
    if (lobby.game === 'dota2' && lobby.botAccountId) {
      try {
        const kickedUser = await User.findOne({ id: userIdToKick });
        if (kickedUser && kickedUser.steamId) {
          const server = botService.getAvailableBotServer();
          await botService.kickPlayer(lobby.botAccountId, kickedUser.steamId, server.url);
          console.log(`[Bot API] Игрок ${kickedUser.username} кикнут из Dota 2 лобби`);
        }
      } catch (botError) {
        console.error('[Bot API] Ошибка при кике из Dota 2:', botError.message);
        // Игрок кикнут с сайта, но возможно остался в Dota 2 - не критично
      }
    }

    const socketsInRoom = await io.in(roomName).fetchSockets();
    const kickedSocket = socketsInRoom.find(s => String(s.data.userId) === String(userIdToKick));
    
    if (kickedSocket) {
      kickedSocket.emit('youWereKicked', { message: 'Хост исключил вас из лобби.' });
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

    const lobby = await Lobby.findOne({ id: lobbyId });
    if (!lobby) {
      return res.status(404).json({ message: "Lobby not found" });
    }

    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Only the host can start the game!" });
    }

    if (lobby.status === 'in_progress' || lobby.status === 'finished') {
        return res.status(400).json({ message: "The game has already started or is finished." });
    }

    // 🆕 ИНТЕГРАЦИЯ С BOT API: Запуск игры в Dota 2
    if (lobby.game === 'dota2' && lobby.botAccountId) {
      try {
        const server = botService.getAvailableBotServer();
        await botService.startGame(lobby.botAccountId, server.url);
        console.log(`[Bot API] Игра запущена в Dota 2! Lobby ID: ${lobby.botAccountId}`);
      } catch (botError) {
        console.error('[Bot API] Ошибка при запуске игры в Dota 2:', botError.message);
        return res.status(500).json({ 
          message: 'Не удалось запустить игру в Dota 2',
          error: botError.message 
        });
      }
    }

    lobby.status = 'in_progress';
    lobby.countdownStartTime = null;
    lobby.startedAt = new Date(); // Добавляем временную метку старта

    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json(updatedLobby.toObject());

  } catch (error) {
    console.error("Error starting game:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/declare-winner', async (req, res) => {
  try {
    const { hostId, winningTeam } = req.body;
    const lobby = await Lobby.findOne({ id: req.params.id });

    if (!lobby) return res.status(404).json({ message: "Лобби не найдено" });
    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Только хост может определять победителя!" });
    }
    if (lobby.status !== 'in_progress') {
      return res.status(400).json({ message: "Игра не находится в процессе" });
    }

    const entryFee = lobby.entryFee;
    const winners = lobby.slots.filter(s => s.user && s.team === winningTeam).map(s => s.user);
    const losers = lobby.slots.filter(s => s.user && s.team !== winningTeam).map(s => s.user);
    
    for (const loser of losers) {
      await User.updateOne({ id: loser.id }, { $inc: { balance: -entryFee } });
      console.log(`[Списано] С игрока ${loser.username} списано ${entryFee}$.`);
    }

    const amountToWin = entryFee * (losers.length / winners.length);
    for (const winner of winners) {
      await User.updateOne({ id: winner.id }, { $inc: { balance: amountToWin } });
      console.log(`[Начислено] Игроку ${winner.username} начислено ${amountToWin}$.`);
    }
    
    lobby.status = 'finished';
    lobby.finishedAt = new Date(); // Добавляем временную метку завершения
    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json({ 
      message: `Команда ${winningTeam} победила!`, 
      lobby: updatedLobby.toObject()
    });

  } catch (error) {
    console.error("Ошибка при распределении призов:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;