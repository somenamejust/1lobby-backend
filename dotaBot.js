require('dotenv').config(); // Загружаем переменные из .env
const SteamUser = require('steam-user');
const Dota2 = require('node-dota2');

const client = new SteamUser({
    dataDirectory: "./sentry" // 👈 Tell steam-user to save files here
});
const dota = new Dota2.Dota2Client(client, true, true);

const logOnOptions = {
    accountName: process.env.BOT_ACCOUNT_NAME,
    password: process.env.BOT_PASSWORD,
    sharedSecret: process.env.BOT_SHARED_SECRET,
    identitySecret: process.env.BOT_IDENTITY_SECRET
};

console.log("Пытаюсь войти в Steam как бот...");
client.logOn(logOnOptions);

client.on('loggedOn', () => {
    console.log('✅ Бот успешно вошел в Steam!');
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(570); // Сообщаем Steam, что мы "играем" в Dota 2 (ID 570)
});

// Это событие сработает, когда клиент Dota 2 будет готов принимать команды
dota.on('ready', () => {
    console.log('✅ Клиент Dota 2 готов к работе!');
});

client.on('error', (e) => {
    console.error('❌ Ошибка Steam клиента:', e);
});

// Экспортируем dota и client, чтобы ими можно было управлять из других файлов
module.exports = { dota, client };