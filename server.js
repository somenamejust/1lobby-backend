require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');

// Модели и маршруты
const Lobby = require('./models/Lobby');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const lobbyRoutes = require('./routes/lobbies');
const botService = require('./services/DotaBotService');

// Инициализация
const app = express();
const server = http.createServer(app);
const PORT = 5000;

const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://1lobby.vercel.app', 'https://1lobby.xyz'],
    methods: ["GET", "POST", "PUT"],
    credentials: true // --- 👇 ИЗМЕНЕНИЕ №1: Разрешаем передачу cookie 👇 ---
  }
});

// Мидлвары (помощники)
app.set('socketio', io); // Делаем io доступным в роутах

app.set('trust proxy', 1); 

// --- 👇 ИЗМЕНЕНИЕ №2: Более надёжная конфигурация CORS и сессий 👇 ---
app.use(cors({
    origin: ['http://localhost:3000', 'https://1lobby.vercel.app', 'https://1lobby.xyz'],
    credentials: true // Разрешаем браузеру отправлять cookie
}));

app.use(express.json());

// --- НАСТРОЙКА СЕССИЙ И PASSPORT (ДО МАРШРУТОВ!) ---
app.use(session({ 
    secret: process.env.SESSION_SECRET, 
    resave: false, 
    saveUninitialized: false, // Оставляем false для безопасности
    cookie: {
        secure: false, // false для http
        httpOnly: true,
        sameSite: 'lax', // Lax - лучший баланс для OAuth редиректов
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// Маршруты
app.use('/api/auth', authRoutes);
app.use('/api/lobbies', lobbyRoutes);
app.use('/api/users', userRoutes);

// Логика Socket.IO
io.on('connection', (socket) => {
  console.log(`🔌 Пользователь подключился: ${socket.id}`);

  socket.on('registerUser', (userId) => {
    socket.data.userId = userId;
    console.log(`[Регистрация] Сокет ${socket.id} зарегистрирован для пользователя ${userId}`);
  });

  socket.on('joinLobbyRoom', (lobbyId) => {
    const roomName = String(lobbyId);
    socket.join(roomName);
    console.log(`[Комната] Сокет ${socket.id} вошел в комнату ${roomName}`);
  });

  socket.on('sendChatMessage', async ({ lobbyId, user, message }) => {
    try {
      const lobby = await Lobby.findOne({ id: lobbyId });
      if (lobby) {
        const newMessage = { user, message, timestamp: new Date() };
        lobby.chat.push(newMessage);
        lobby.markModified('chat');
        const updatedLobby = await lobby.save();
        io.in(String(lobbyId)).emit('lobbyUpdated', updatedLobby.toObject());
      }
    } catch (error) {
      console.error("Ошибка в чате:", error);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Пользователь отключился: ${socket.id}`);
  });
});

// Подключение к БД и запуск сервера
mongoose.connect(process.env.DATABASE_URL)
  .then(() => {
    console.log('Успешное подключение к MongoDB');
    server.listen(PORT, () => {
      console.log(`🚀 Сервер с Socket.IO запущен на порту ${PORT}`);
    });

    const botService = require('./services/DotaBotService');    
    setInterval(async () => {
      try {
        const Lobby = require('./models/Lobby');
        const lobbies = await Lobby.find({ status: 'countdown' });
        
        for (const lobby of lobbies) {
          if (lobby.countdownStartTime) {
            const elapsed = Date.now() - lobby.countdownStartTime;
            
            // Если прошло 60 секунд
            if (elapsed >= 60000) {
              console.log(`[Автостарт] Запуск лобби ${lobby.id} (таймер истек)`);
              
              // Запускаем игру в Dota 2
              if (lobby.game === 'dota2' && lobby.botAccountId) {
                try {
                  const server = botService.getAvailableBotServer();
                  await botService.startGame(lobby.botAccountId, server.url);
                  console.log(`[Bot API] Игра запущена автоматически! Lobby ID: ${lobby.botAccountId}`);
                } catch (botError) {
                  console.error('[Bot API] Ошибка автостарта в Dota 2:', botError.message);
                }
              }
              
              // Обновляем статус лобби
              lobby.status = 'in_progress';
              lobby.countdownStartTime = null;
              lobby.startedAt = new Date();
              await lobby.save();
              
              // Уведомляем всех через WebSocket
              io.in(lobby.id.toString()).emit('lobbyUpdated', lobby.toObject());
            }
          }
        }
      } catch (error) {
        console.error('[Автостарт] Ошибка:', error);
      }
    }, 5000); // Проверяем каждые 5 секунд
  })
  .catch(err => console.error('Ошибка подключения к MongoDB:', err));

module.exports.io = io;  