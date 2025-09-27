const express = require('express');
const router = express.Router();
const User = require('../models/User'); // Убедитесь, что путь к модели верный

router.get('/search', async (req, res) => {
    try {
        const { term, currentUserId } = req.query;

        // --- 👇 Диагностический лог №1: Что пришло с фронтенда? 👇 ---
        console.log(`[Поиск] Получен запрос: term='${term}', currentUserId='${currentUserId}'`);

        if (!term || !currentUserId) {
            return res.json([]);
        }

        const termAsNumber = parseInt(term, 10);
        const searchCriteria = [
            { username: { $regex: term, $options: 'i' } }
        ];

        if (!isNaN(termAsNumber)) {
            searchCriteria.push({ id: termAsNumber });
        }

        // --- 👇 Диагностический лог №2: Какой финальный запрос мы строим? 👇 ---
        const finalQuery = {
            $and: [
                { $or: searchCriteria },
                { id: { $ne: parseInt(currentUserId, 10) } }
            ]
        };
        console.log('[Поиск] Финальный запрос к MongoDB:', JSON.stringify(finalQuery, null, 2));

        const users = await User.find(finalQuery).limit(10);

        // --- 👇 Диагностический лог №3: Что нашла база данных? 👇 ---
        console.log(`[Поиск] Найдено пользователей: ${users.length}`);

        res.status(200).json(users);

    } catch (error) {
        console.error("Ошибка при поиске пользователей:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// GET /api/users/:id - Получить данные одного пользователя по его ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Ошибка сервера" });
  }
});

router.post('/by-ids', async (req, res) => {
    try {
        const { ids } = req.body; // Ожидаем массив ID, например: [123, 456]
        if (!ids || !Array.isArray(ids)) {
            return res.status(400).json({ message: "Требуется массив ID" });
        }

        const users = await User.find({ id: { $in: ids } });
        res.status(200).json(users);

    } catch (error) {
        console.error("Ошибка при получении пользователей по ID:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

router.post('/friends/request', async (req, res) => {
  try {
    const { senderId, recipientId } = req.body;
    if (!senderId || !recipientId) {
      return res.status(400).json({ message: "Необходимы ID отправителя и получателя." });
    }

    // Находим обоих пользователей
    const sender = await User.findOne({ id: senderId });
    const recipient = await User.findOne({ id: recipientId });

    if (!sender || !recipient) {
      return res.status(404).json({ message: "Один из пользователей не найден." });
    }

    // --- Логика добавления в списки заявок (остаётся) ---
    recipient.friendRequests.addToSet({ fromUserId: sender.id, fromUsername: sender.username, fromAvatarUrl: sender.avatarUrl });
    sender.outgoingRequests.addToSet({ toUserId: recipient.id, toUsername: recipient.username });

    // --- 👇 НОВАЯ ЛОГИКА: ДОБАВЛЕНИЕ УВЕДОМЛЕНИЯ 👇 ---
    if (!recipient.notifications) {
      recipient.notifications = [];
    }
    const newNotification = {
      id: Date.now(),
      message: `Пользователь ${sender.username} отправил вам заявку в друзья.`,
      timestamp: new Date(),
      isRead: false,
    };
    recipient.notifications.unshift(newNotification); // Добавляем в начало массива

    // Сохраняем изменения для обоих пользователей
    await recipient.save();
    await sender.save();

    res.status(200).json({ message: "Заявка в друзья отправлена." });

  } catch (error) {
    console.error("Ошибка при отправке заявки:", error);
    res.status(500).json({ message: "Ошибка сервера" });
  }
});

router.post('/friends/accept', async (req, res) => {
    try {
        const { userId, requesterId } = req.body;

        // --- 👇 ГЛАВНОЕ ИСПРАВЛЕНИЕ ЗДЕСЬ 👇 ---

        // 1. Удаляем заявки, указывая, какой ОБЪЕКТ нужно удалить
        // У текущего пользователя удаляем входящую заявку
        await User.updateOne(
            { id: userId }, 
            { $pull: { friendRequests: { fromUserId: requesterId } } }
        );
        // У отправителя удаляем исходящую заявку
        await User.updateOne(
            { id: requesterId }, 
            { $pull: { outgoingRequests: { toUserId: userId } } }
        );

        // 2. Добавляем друг друга в списки друзей (этот код уже был правильным)
        await User.updateOne({ id: userId }, { $addToSet: { friends: requesterId } });
        await User.updateOne({ id: requesterId }, { $addToSet: { friends: userId } });

        res.status(200).json({ message: "Заявка в друзья принята." });
        
    } catch (error) {
        console.error("Ошибка при принятии заявки:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

router.post('/friends/decline', async (req, res) => {
    try {
        const { userId, requesterId } = req.body;
        // Просто удаляем заявки с обеих сторон
        await User.updateOne({ id: userId }, { $pull: { friendRequests: { fromUserId: requesterId } } });
        await User.updateOne({ id: requesterId }, { $pull: { outgoingRequests: { toUserId: userId } } });
        res.status(200).json({ message: "Заявка отклонена." });
    } catch (error) {
        console.error("Ошибка при отклонении заявки:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

router.post('/friends/remove', async (req, res) => {
    try {
        const { userId, friendId } = req.body;
        // Удаляем друг друга из списков друзей
        await User.updateOne({ id: userId }, { $pull: { friends: friendId } });
        await User.updateOne({ id: friendId }, { $pull: { friends: userId } });
        res.status(200).json({ message: "Пользователь удален из друзей." });
    } catch (error) {
        console.error("Ошибка при удалении друга:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

router.post('/praise', async (req, res) => {
    try {
        const { targetUserId } = req.body;
        // Находим юзера и увеличиваем счетчик
        await User.updateOne({ id: targetUserId }, { $inc: { praises: 1 } });
        res.status(200).json({ message: "User praised." });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/report', async (req, res) => {
    try {
        const { targetUserId } = req.body;
        // Находим юзера и увеличиваем счетчик
        await User.updateOne({ id: targetUserId }, { $inc: { reports: 1 } });
        res.status(200).json({ message: "User reported." });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/deposit', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        const amountNumber = parseFloat(amount);

        if (!userId || isNaN(amountNumber) || amountNumber <= 0) {
            return res.status(400).json({ message: "Некорректные данные для пополнения." });
        }

        // Находим пользователя и увеличиваем его баланс
        // { new: true } говорит Mongoose вернуть обновленный документ
        const updatedUser = await User.findOneAndUpdate(
            { id: userId }, 
            { $inc: { balance: amountNumber } },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(404).json({ message: "Пользователь не найден." });
        }

        res.status(200).json(updatedUser);

    } catch (error) {
        console.error("Ошибка при пополнении баланса:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

router.post('/withdraw', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        const amountNumber = parseFloat(amount);

        if (!userId || isNaN(amountNumber) || amountNumber <= 0) {
            return res.status(400).json({ message: "Некорректные данные для вывода." });
        }

        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ message: "Пользователь не найден." });
        }

        // Проверяем, достаточно ли средств
        if (user.balance < amountNumber) {
            return res.status(400).json({ message: "Недостаточно средств на балансе." });
        }

        // Списываем средства
        user.balance -= amountNumber;
        const updatedUser = await user.save();

        res.status(200).json(updatedUser);

    } catch (error) {
        console.error("Ошибка при выводе средств:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

module.exports = router;