const express = require('express');
const router = express.Router();
const Lobby = require('../models/Lobby');
const User = require('../models/User');

// Маршрут для получения ВСЕХ лобби
// GET /api/lobbies
router.get('/', async (req, res) => {
  try {
    // Находим все лобби, у которых статус НЕ РАВЕН ($ne) 'finished'
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
    // req.body будет содержать все данные, которые мы отправим с фронтенда
    const newLobby = new Lobby(req.body); 
    await newLobby.save(); // Сохраняем новое лобби в базу
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
      // --- 👇 FINAL FIX IS HERE 👇 ---
      // SCENARIO 2: User wants to join as a player

      // 1. FIRST, check for bans and if the user is already in a slot.
      if (lobby.bannedUsers?.includes(String(userFromRequest.id))) {
        return res.status(403).json({ message: "You have been banned from this lobby." });
      }
      if (lobby.slots.some(slot => slot.user?.id === userFromRequest.id)) {
        return res.status(200).json(lobby.toObject());
      }

      // 2. SECOND, check if the lobby is full.
      const freeSlotIndex = lobby.slots.findIndex(slot => !slot.user);
      if (freeSlotIndex === -1) {
        return res.status(400).json({ message: 'Lobby is full' });
      }

      // 3. THIRD, check the user's balance BEFORE adding them.
      const userForCheck = await User.findOne({ id: userFromRequest.id });
      if (!userForCheck || userForCheck.balance < lobby.entryFee) {
          return res.status(403).json({ message: "You do not have enough funds to join." });
      }

      // 4. FINALLY, if all checks pass, add the user to the slot.
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

    // --- 👇 FINAL, SIMPLIFIED LOGIC 👇 ---
    
    // Get the initial number of people in the lobby
    const initialCount = lobby.slots.filter(s => s.user).length + lobby.spectators.length;

    // Remove the user from SLOTS
    lobby.slots = lobby.slots.map(slot => {
      if (slot.user?.id === userId) return { ...slot, user: null };
      return slot;
    });

    // Remove the user from SPECTATORS
    lobby.spectators = lobby.spectators.filter(spec => spec.id !== userId);
    
    // Get the final number of people
    const finalPlayerCount = lobby.slots.filter(s => s.user).length;
    const finalSpectatorCount = lobby.spectators.length;
    const finalTotalCount = finalPlayerCount + finalSpectatorCount;

    // If the number of people has not changed, the user was not found.
    if (finalTotalCount === initialCount) {
      return res.status(404).json({ message: "User was not found in the lobby." });
    }
    
    // If the lobby is now empty, delete it.
    if (finalTotalCount === 0) {
      io.in(roomName).emit('lobbyDeleted', { message: 'The lobby is now empty.' });
      await Lobby.deleteOne({ id: req.params.id });
      return res.status(200).json({ message: "Lobby deleted." });
    }

    // Otherwise, update the lobby and broadcast the changes.
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
    const { userId, slot: targetSlotInfo } = req.body; // Получаем ID юзера и инфо о слоте (team, position)
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
    
    // Сценарий 1: Игрок уже в слоте и хочет переместиться
    if (currentSlotIndex !== -1) {
      console.log("Игрок перемещается из одного слота в другой.");
      const userToMove = lobby.slots[currentSlotIndex].user; // Сохраняем данные пользователя
      lobby.slots[currentSlotIndex].user = null; // Освобождаем старый слот
      targetSlot.user = userToMove; // Занимаем новый слот
    } 
    // Сценарий 2: Зритель занимает слот
    else if (userAsSpectator) {
      console.log("Зритель занимает слот.");
      targetSlot.user = { ...userAsSpectator, isReady: false }; // Занимаем слот
      lobby.spectators = lobby.spectators.filter(spec => spec.id !== userId); // Удаляем из зрителей
    } 
    // Если пользователь не найден ни в слотах, ни в зрителях
    else {
      return res.status(404).json({ message: "Пользователь не найден в этом лобби" });
    }

    // Обновляем состояние и сохраняем
    lobby.players = lobby.slots.filter(s => s.user).length;
    lobby.markModified('slots');
    lobby.markModified('spectators');

    const updatedLobby = await lobby.save();

        // --- 👇 ОТПРАВКА ОБНОВЛЕНИЯ ЧЕРЕЗ WEBSOCKET 👇 ---
    const io = req.app.get('socketio'); // Получаем io из app
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject()); // Отправляем всем в "комнате"

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

    // TODO: Здесь должна быть логика возврата денег (lobby.entryFee) на баланс userToMove.
    // Это потребует доступа к модели User.

    // Перемещаем пользователя
    lobby.slots[slotIndex].user = null; // Освобождаем слот
    if (!lobby.spectators.some(spec => spec.id === userId)) {
        lobby.spectators.push(userToMove); // Добавляем в зрители, если его там еще нет
    }
    lobby.players = lobby.slots.filter(s => s.user).length;

    lobby.markModified('slots');
    lobby.markModified('spectators');

    const updatedLobby = await lobby.save();

        // --- 👇 ОТПРАВКА ОБНОВЛЕНИЯ ЧЕРЕЗ WEBSOCKET 👇 ---
    const io = req.app.get('socketio'); // Получаем io из app
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject()); // Отправляем всем в "комнате"

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

    // 1. Переключаем статус готовности конкретного игрока
    slot.user.isReady = !slot.user.isReady;

    // --- 👇 ВОТ ГЛАВНОЕ ИСПРАВЛЕНИЕ 👇 ---
    
    // 2. После изменения, проверяем, готовы ли теперь ВСЕ игроки
    const playersInSlots = lobby.slots.filter(s => s.user);
    const areAllPlayersReady = playersInSlots.length === lobby.maxPlayers && playersInSlots.every(p => p.user.isReady);

    if (areAllPlayersReady) {
      // 3. Если все готовы - запускаем отсчет!
      lobby.status = 'countdown';
      lobby.countdownStartTime = Date.now();
      console.log(`[Лобби ${lobby.id}] Все готовы! Запуск отсчета.`);
    } else {
      // 4. Если кто-то отменил готовность - сбрасываем таймер
      lobby.status = 'waiting';
      lobby.countdownStartTime = null;
      console.log(`[Лобби ${lobby.id}] Отмена готовности. Отсчет остановлен.`);
    }
    // --- Конец исправления ---

    lobby.markModified('slots'); // Помечаем массив как измененный

    const updatedLobby = await lobby.save();

        // --- 👇 ОТПРАВКА ОБНОВЛЕНИЯ ЧЕРЕЗ WEBSOCKET 👇 ---
    const io = req.app.get('socketio'); // Получаем io из app
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject()); // Отправляем всем в "комнате"

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
    const io = req.app.get('socketio'); // Получаем доступ к io
    const roomName = String(lobbyId);

    if (!userIdToKick || !hostId) {
      return res.status(400).json({ message: 'Недостаточно данных для кика' });
    }

    const lobby = await Lobby.findOne({ id: lobbyId });
    if (!lobby) {
      return res.status(404).json({ message: "Лобби не найдено" });
    }

    // --- 🔐 Проверка авторизации хоста (остаётся без изменений) ---
    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Только хост может кикать игроков!" });
    }

    // --- 1. Сначала выполняем все стандартные действия с базой данных ---
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


    // --- 👇 НОВАЯ ЛОГИКА: ПОИСК СОКЕТА И ОТПРАВКА ЛИЧНОГО СОБЫТИЯ 👇 ---

    // 2. Получаем список всех сокетов в комнате лобби
    const socketsInRoom = await io.in(roomName).fetchSockets();
    
    // 3. Находим конкретный сокет кикнутого игрока, используя `socket.data.userId`,
    // который мы установили при событии 'registerUser'.
    const kickedSocket = socketsInRoom.find(s => String(s.data.userId) === String(userIdToKick));
    
    // 4. Если сокет найден, отправляем ему личное событие
    if (kickedSocket) {
      kickedSocket.emit('youWereKicked', { message: 'Хост исключил вас из лобби.' });
      console.log(`[Кик] Отправлено личное уведомление о кике сокету ${kickedSocket.id}`);
    } else {
      console.log(`[Кик] Сокет для пользователя ${userIdToKick} не найден (возможно, он уже оффлайн).`);
    }

    // 5. После этого отправляем ОБЩЕЕ обновление всем остальным в комнате,
    // чтобы они увидели, что слот освободился.
    io.in(roomName).emit('lobbyUpdated', updatedLobby.toObject());

    // 6. Отправляем успешный HTTP-ответ хосту.
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

    // 1. 🔐 Security Check: Only the host can start the game
    if (String(lobby.host.id) !== String(hostId)) {
      return res.status(403).json({ message: "Only the host can start the game!" });
    }

    // 2. Logic Check: The game shouldn't already be in progress or finished
    if (lobby.status === 'in_progress' || lobby.status === 'finished') {
        return res.status(400).json({ message: "The game has already started or is finished." });
    }

    // 3. Update the lobby status
    lobby.status = 'in_progress';
    lobby.countdownStartTime = null; // Clear the timer just in case

    const updatedLobby = await lobby.save();

        // --- 👇 ОТПРАВКА ОБНОВЛЕНИЯ ЧЕРЕЗ WEBSOCKET 👇 ---
    const io = req.app.get('socketio'); // Получаем io из app
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject()); // Отправляем всем в "комнате"

    res.status(200).json(updatedLobby.toObject());

  } catch (error)
    {
    console.error("Error starting game:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/declare-winner', async (req, res) => {
  try {
    const { hostId, winningTeam } = req.body;
    const lobby = await Lobby.findOne({ id: req.params.id });

    // --- Проверки остаются без изменений ---
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
    
    // --- 👇 НОВАЯ И ПРАВИЛЬНАЯ ЛОГИКА РАСПРЕДЕЛЕНИЯ ПРИЗОВ 👇 ---

    // 1. Списываем деньги с проигравших
    for (const loser of losers) {
      await User.updateOne({ id: loser.id }, { $inc: { balance: -entryFee } });
      console.log(`[Списано] С игрока ${loser.username} списано ${entryFee}$.`);
    }

    // 2. Начисляем деньги победителям (каждый победитель получает взнос одного проигравшего)
    // Эта логика работает для игр 1v1, 2v2, 5v5 и т.д.
    const amountToWin = entryFee * (losers.length / winners.length);
    for (const winner of winners) {
      await User.updateOne({ id: winner.id }, { $inc: { balance: amountToWin } });
      console.log(`[Начислено] Игроку ${winner.username} начислено ${amountToWin}$.`);
    }
    
    // 3. Обновляем статус лобби
    lobby.status = 'finished';
    const updatedLobby = await lobby.save();

    const io = req.app.get('socketio');
    io.in(req.params.id).emit('lobbyUpdated', updatedLobby.toObject());

    res.status(200).json({ 
      message: `Команда ${winningTeam} победила!`, 
      lobby: updatedLobby.toObject() // Добавляем .toObject() и здесь
    });

  } catch (error) {
    console.error("Ошибка при распределении призов:", error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;