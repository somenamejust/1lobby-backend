// backend/models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // Пароли будем хранить в открытом виде для простоты
  avatarUrl: { type: String },
  balance: { type: Number, default: 10 },
  currentLobbyId: { type: Number, default: null },
  steamId: { type: String, default: null, index: true },   // Для хранения SteamID64
  steamProfile: { type: Object, default: null }, // Для хранения всех данных профиля Steam
  friends: { type: [Number], default: [] },
  friendRequests: { type: [Object], default: [] },
  outgoingRequests: { type: [Object], default: [] },
  praises: { type: Number, default: 0 },
  reports: { type: Number, default: 0 },
  notifications: { type: [Object], default: [] },
});

const User = mongoose.model('User', userSchema);

module.exports = User;