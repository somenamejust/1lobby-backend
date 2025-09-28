const express = require('express');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const User = require('../models/User');
const router = express.Router();
const LocalStrategy = require('passport-local').Strategy;

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
        const user = await User.findOne({ email: email });
        if (!user || user.password !== password) {
            return done(null, false, { message: 'Invalid credentials.' });
        }
        return done(null, user);
    } catch (err) { return done(err); }
}));

passport.use(new SteamStrategy({
    returnURL: 'https://1lobby.xyz/api/auth/steam/return',
    realm: 'https://1lobby.xyz/',
    apiKey: process.env.STEAM_API_KEY, // 👈 Don't forget your key
    passReqToCallback: true
  },
  async (req, identifier, profile, done) => {
    try {
      const loggedInUser = req.user; // User from our session
      if (loggedInUser) {
        loggedInUser.steamId = profile.id;
        loggedInUser.steamProfile = profile._json;
        await loggedInUser.save();
        return done(null, loggedInUser); // Return OUR user, not the steam profile
      } else {
        throw new Error('User not logged in before linking.');
      }
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => {
    done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
    const user = await User.findById(id).catch(err => done(err));
    done(null, user || null);
});

// Маршрут для регистрации: POST /api/auth/register
router.post('/register', async (req, res, next) => { // Добавляем next
  try {
    const { email, password, username } = req.body;
    // ... ваша проверка на существующего пользователя ...
    if (await User.findOne({ $or: [{ email }, { username }] })) {
      return res.status(400).json({ message: 'Email или логин уже занят' });
    }

    const newUser = new User({
      id: Date.now(),
      email,
      username,
      password,
      avatarUrl: `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`,
    });

    await newUser.save();

    // --- 👇 ГЛАВНОЕ ИЗМЕНЕНИЕ 👇 ---
    // Сразу после сохранения, создаём сессию для нового пользователя
    req.login(newUser, (err) => {
      if (err) { 
        return next(err); 
      }
      // Отправляем успешный ответ с данными пользователя
      return res.status(201).json({ message: 'Пользователь успешно зарегистрирован', user: newUser });
    });

  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Маршрут для входа: POST /api/auth/login
router.post('/login', passport.authenticate('local'), (req, res) => {
    res.status(200).json({ message: 'Login successful', user: req.user });
});

// Маршрут для обновления сессии лобби
// PUT /api/auth/session
router.put('/session', async (req, res) => {
  try {
    const { userId, lobbyId } = req.body; // Получаем ID пользователя и ID лобби

    // Находим пользователя и обновляем только его currentLobbyId
    const updatedUser = await User.findOneAndUpdate(
      { id: userId }, // Найти пользователя по его уникальному id
      { $set: { currentLobbyId: lobbyId } }, // Установить новое значение
      { new: true } // Вернуть обновленный документ
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    res.status(200).json(updatedUser);

  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера при обновлении сессии' });
  }
});

router.get('/steam', passport.authenticate('steam'));

// --- 👇 THE FINAL FIX IS HERE 👇 ---
router.get('/steam/return',
  // 1. Сначала Passport просто проверяет, что ответ от Steam корректен.
  passport.authenticate('steam', { failureRedirect: 'https://1lobby.vercel.app/profile' }),
  
  // 2. После успеха, мы вручную обновляем сессию и делаем редирект.
  async (req, res) => {
    try {
      // req.user здесь - это наш пользователь, обновленный в стратегии Steam
      const updatedUserFromStrategy = req.user;
      
      // 3. Явно вызываем req.login(), чтобы ПЕРЕЗАПИСАТЬ старую сессию новыми данными
      req.login(updatedUserFromStrategy, (err) => {
        if (err) {
          console.error("Ошибка при обновлении сессии после привязки Steam:", err);
          return res.redirect('https://1lobby.vercel.app/profile?error=session_error');
        }
        
        // 4. Теперь, когда сессия обновлена, безопасно перенаправляем на профиль
        return res.redirect('https://1lobby.vercel.app/profile');
      });
    } catch (error) {
        console.error("Критическая ошибка в /steam/return:", error);
        res.redirect('https://1lobby.vercel.app/profile?error=unknown_error');
    }
  }
);

module.exports = router;