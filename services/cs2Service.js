const { Rcon } = require('rcon-client');
const matchConfigService = require('./matchConfigService');

class CS2Service {
  constructor() {
    this.connections = new Map(); // Кеш RCON соединений
  }

  /**
   * Получить RCON соединение (с кешированием)
   */
  async getConnection(host, port, password) {
    const key = `${host}:${port}`;
    
    console.log('========================================');
    console.log('[CS2 RCON] Попытка подключения:');
    console.log(`  Host: ${host}`);
    console.log(`  Port: ${port}`);
    console.log(`  Password: ${password.substring(0, 3)}***${password.substring(password.length - 3)}`);
    console.log(`  Password Length: ${password.length}`);
    console.log('========================================');
    
    if (this.connections.has(key)) {
      const conn = this.connections.get(key);
      if (conn.authenticated) {
        console.log('[CS2 RCON] ✅ Используем существующее соединение');
        return conn;
      } else {
        console.log('[CS2 RCON] ⚠️ Старое соединение не авторизовано, создаём новое');
        this.connections.delete(key);
      }
    }
    
    try {
      console.log('[CS2 RCON] Подключаемся...');
      const rcon = await Rcon.connect({
        host,
        port,
        password,
        timeout: 10000 // Увеличили до 10 секунд
      });
      
      console.log('[CS2 RCON] ✅ Подключение успешно!');
      this.connections.set(key, rcon);
      return rcon;
      
    } catch (error) {
      console.error('[CS2 RCON] ❌ ОШИБКА:', error.message);
      throw new Error(`Cannot connect to CS2 server: ${error.message}`);
    }
  }

  async executeCommand(host, port, password, command) {
    try {
      console.log(`[CS2] Отправка команды: ${command}`);
      
      const rcon = await this.getConnection(host, port, password);
      
      // 🆕 ПРОВЕРКА СОЕДИНЕНИЯ
      if (!rcon || !rcon.authenticated) {
        console.error('[CS2 RCON] ❌ Соединение потеряно! Переподключаемся...');
        const key = `${host}:${port}`;
        this.connections.delete(key);
        
        const newRcon = await this.getConnection(host, port, password);
        const response = await newRcon.send(command);
        console.log(`[CS2] ${host}:${port} > ${command}`);
        console.log(`[CS2] Response:`, response || '(empty response)');
        return response;
      }
      
      const response = await rcon.send(command);
      console.log(`[CS2] ${host}:${port} > ${command}`);
      console.log(`[CS2] Response:`, response || '(empty response)');
      
      return response;
      
    } catch (error) {
      console.error(`[CS2] ❌ Ошибка выполнения команды "${command}":`, error.message);
      throw error;
    }
  }

  /**
   * 🆕 ГЛАВНЫЙ МЕТОД: Запустить матч через MatchZy Config
   */
  async startMatchViaConfig(lobbyId, mapName, teamAPlayers, teamBPlayers, serverHost, serverPort, rconPassword) {
    try {
      console.log('[CS2 Match] Запуск матча через MatchZy config...');
      console.log(`[CS2 Match] Карта: ${mapName}`);
      console.log(`[CS2 Match] Team A (${Object.keys(teamAPlayers).length} игроков):`, teamAPlayers);
      console.log(`[CS2 Match] Team B (${Object.keys(teamBPlayers).length} игроков):`, teamBPlayers);

      // 1. Создаем и загружаем config
      const configPath = await matchConfigService.createAndUploadMatchConfig({
        matchId: lobbyId,
        map: mapName,
        teamA: teamAPlayers,
        teamB: teamBPlayers
      });

      console.log(`[CS2 Match] Config загружен: ${configPath}`);

      // 🆕 2. ЗАКРЫВАЕМ СТАРОЕ RCON СОЕДИНЕНИЕ
      const rconKey = `${serverHost}:${serverPort}`;
      if (this.connections.has(rconKey)) {
        const oldRcon = this.connections.get(rconKey);
        try {
          await oldRcon.end();
          console.log('[CS2 RCON] 🔄 Старое соединение закрыто');
        } catch (e) {
          console.log('[CS2 RCON] ⚠️ Ошибка закрытия старого соединения:', e.message);
        }
        this.connections.delete(rconKey);
      }

      // 🆕 3. ПАУЗА 3 СЕКУНДЫ перед отправкой команды
      console.log('[CS2] ⏱️ Ожидание 3 сек перед загрузкой config...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 4. Загружаем матч через MatchZy
      console.log(`[CS2 Match] Отправка команды: matchzy_loadmatch ${configPath}`);
      const response = await this.executeCommand(serverHost, serverPort, rconPassword, `matchzy_loadmatch cfg/MatchZy/${configPath.replace('MatchZy/', '').replace('matchzy/', '')}`);

      console.log('[CS2 Match] ✅ Команда отправлена! MatchZy загружает матч...');
      console.log('[CS2 Match] Ответ сервера:', response);
      
      return {
        success: true,
        message: 'Матч загружается через MatchZy'
      };

    } catch (error) {
      console.error('[CS2 Match] ❌ Ошибка:', error.message);
      throw error;
    }
  }

  /**
   * Очистить сервер перед матчем
   */
  async cleanupServer(serverHost, serverPort, rconPassword) {
    try {
      console.log('[CS2] Сервер готов к запуску матча');
      
      // 🆕 Просто пауза 2 секунды
      console.log('[CS2] ⏱️ Ожидание 2 сек...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('[CS2] Ошибка:', error.message);
    }
  }

  /**
   * Получить статус сервера
   */
  async getStatus(host, port, password) {
    const response = await this.executeCommand(host, port, password, 'status');
    return this.parseStatus(response);
  }

  /**
   * Парсинг вывода status
   */
  parseStatus(output) {
    const lines = output.split('\n');
    const status = {
      hostname: '',
      map: '',
      players: 0,
      maxPlayers: 0,
      connectedPlayers: []
    };

    for (const line of lines) {
      if (line.includes('hostname:')) {
        status.hostname = line.split(':')[1]?.trim() || '';
      }
      
      if (line.includes('map') && line.includes(':')) {
        status.map = line.split(':')[1]?.trim() || '';
      }
      
      if (line.includes('players')) {
        const match = line.match(/(\d+)\s*\/\s*(\d+)/);
        if (match) {
          status.players = parseInt(match[1]);
          status.maxPlayers = parseInt(match[2]);
        }
      }
      
      if (line.match(/STEAM_\d:\d:\d+/)) {
        const steamMatch = line.match(/STEAM_(\d):(\d):(\d+)/);
        if (steamMatch) {
          const steamId64 = this.convertToSteamID64(steamMatch[0]);
          status.connectedPlayers.push(steamId64);
        }
      }
    }

    return status;
  }

  /**
   * Конвертация STEAM_X:Y:Z в SteamID64
   */
  convertToSteamID64(steamId) {
    const match = steamId.match(/STEAM_(\d):(\d):(\d+)/);
    if (!match) return null;
    
    const [, , Y, Z] = match;
    const accountNumber = BigInt(Z) * 2n + BigInt(Y);
    const steamID64 = 76561197960265728n + accountNumber;
    
    return steamID64.toString();
  }

  /**
   * Закрыть все соединения
   */
  async disconnectAll() {
    for (const [key, rcon] of this.connections.entries()) {
      try {
        await rcon.end();
        console.log(`[CS2] Disconnected from ${key}`);
      } catch (error) {
        console.error(`[CS2] Error disconnecting ${key}:`, error);
      }
    }
    this.connections.clear();
  }
}

module.exports = new CS2Service();