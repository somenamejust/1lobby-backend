const mongoose = require('mongoose');

// --- 1. Описываем, как выглядит объект пользователя внутри лобби ---
const userSubSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  _id: { type: String, required: true },
  email: { type: String, required: true },
  username: { type: String, required: true },
  avatarUrl: { type: String },
  isReady: { type: Boolean, default: false }
}, { _id: false });

// --- 2. Описываем, как выглядит один слот ---
const slotSchema = new mongoose.Schema({
  team: { type: String, required: true },
  position: { type: Number, required: true },
  user: { type: userSubSchema, default: null }
}, { _id: false });

// --- 3. Основная схема лобби ---
const lobbySchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  title: { type: String, required: true },
  host: { type: Object, required: true },
  game: { type: String, required: true },
  mode: { type: String, required: true },
  region: { type: String, required: true },
  
  dotaGameMode: { type: Number, default: 22 }, // По умолчанию All Pick (22)
  dotaRegion: { type: Number, default: null },

  type: { type: String, default: 'public' },
  password: { type: String, default: null },
  entryFee: { type: Number, default: 0 },
  maxPlayers: { type: Number, required: true },
  status: { type: String, default: 'waiting' },
  countdownStartTime: { type: Number, default: null },
  players: { type: Number, default: 1 },

  matchId: { type: String, default: null },
  winner: { type: String, default: null },      // 'Radiant' или 'Dire' для Dota 2
  duration: { type: Number, default: null },
  cancelReason: { type: String, default: null },
  
  slots: [slotSchema],
  spectators: [userSubSchema],
  
  chat: { type: Array, default: [] },
  bannedUsers: { type: [String], default: [] },

  // 🆕 НОВЫЕ ПОЛЯ ДЛЯ ИНТЕГРАЦИИ С BOT API
  botServerId: { type: String, default: null },
  botAccountId: { type: String, default: null },

  cs2ServerId: { type: String, default: null },
  cs2ServerIp: { type: String, default: null },
  map: { type: String, default: 'de_dust2' },

  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
});

const Lobby = mongoose.model('Lobby', lobbySchema);

module.exports = Lobby;