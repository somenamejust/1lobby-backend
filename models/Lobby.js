const mongoose = require('mongoose');

// --- 1. Описываем, как выглядит объект пользователя внутри лобби ---
// Это "под-схема", которую мы будем использовать в слотах и зрителях.
const userSubSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  _id: { type: String, required: true },
  email: { type: String, required: true },
  username: { type: String, required: true },
  avatarUrl: { type: String },
  isReady: { type: Boolean, default: false }
}, { _id: false }); // Отключаем создание _id для этой под-схемы

// --- 2. Описываем, как выглядит один слот ---
const slotSchema = new mongoose.Schema({
  team: { type: String, required: true },
  position: { type: Number, required: true },
  user: { type: userSubSchema, default: null } // Слот может быть пустым (null)
}, { _id: false });


// --- 3. Используем наши новые схемы в основной схеме лобби ---
const lobbySchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  title: { type: String, required: true },
  host: { type: Object, required: true },
  game: { type: String, required: true },
  mode: { type: String, required: true },
  region: { type: String, required: true },
  type: { type: String, default: 'public' },
  password: { type: String, default: null },
  entryFee: { type: Number, default: 0 },
  maxPlayers: { type: Number, required: true },
  status: { type: String, default: 'waiting' },
  countdownStartTime: { type: Number, default: null },
  players: { type: Number, default: 1 },
  
  // --- 👇 ГЛАВНОЕ ИЗМЕНЕНИЕ ЗДЕСЬ 👇 ---
  slots: [slotSchema], // Массив, содержащий объекты по схеме slotSchema
  spectators: [userSubSchema], // Массив, содержащий объекты по схеме userSubSchema
  
  chat: { type: Array, default: [] },
  bannedUsers: { type: [String], default: [] }
});

const Lobby = mongoose.model('Lobby', lobbySchema);

module.exports = Lobby;