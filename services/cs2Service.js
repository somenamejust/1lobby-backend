const { Rcon } = require('rcon-client');

class CS2Service {
  constructor() {
    this.connections = new Map(); // Кеш RCON соединений
  }

  /**
   * Получить RCON соединение (с кешированием)
   */
    async getConnection(host, port, password) {
        const key = `${host}:${port}`;
        
        // 🆕 ДИАГНОСТИКА
        console.log('========================================');
        console.log('[CS2 RCON] Попытка подключения:');
        console.log(`  Host: ${host}`);
        console.log(`  Port: ${port}`);
        console.log(`  Password: ${password.substring(0, 3)}***${password.substring(password.length - 3)}`); // Показываем только начало и конец
        console.log(`  Password Length: ${password.length}`);
        console.log('========================================');
        
        if (this.connections.has(key)) {
            const conn = this.connections.get(key);
            if (conn.authenticated) {
            console.log('[CS2 RCON] ✅ Используем существующее соединение');
            return conn;
            } else {
            console.log('[CS2 RCON] ⚠️ Старое соединение не авторизовано, создаём новое');
            }
        }
        
        try {
            console.log('[CS2 RCON] Подключаемся...');
            const rcon = await Rcon.connect({
            host,
            port,
            password,
            timeout: 5000
            });
            
            console.log('[CS2 RCON] ✅ Подключение успешно!');
            this.connections.set(key, rcon);
            return rcon;
            
        } catch (error) {
            console.error('[CS2 RCON] ❌ ОШИБКА:');
            console.error(`  Сообщение: ${error.message}`);
            console.error(`  Код: ${error.code}`);
            console.error(`  Детали:`, error);
            throw new Error(`Cannot connect to CS2 server: ${error.message}`);
        }
    }

  /**
   * Выполнить команду на сервере
   */
  async executeCommand(host, port, password, command) {
    try {
      const rcon = await this.getConnection(host, port, password);
      const response = await rcon.send(command);
      console.log(`[CS2] ${host}:${port} > ${command}`);
      return response;
    } catch (error) {
      console.error(`[CS2] Command failed: ${command}`, error);
      throw error;
    }
  }

  /**
   * Установить карту и режим
   */
  async setMapAndMode(serverHost, serverPort, rconPassword, mapName, gameType = 0, gameMode = 1) {
    try {
      console.log(`[CS2] Setting up: ${mapName}, type=${gameType}, mode=${gameMode}`);
      
      // Устанавливаем режим
      await this.executeCommand(serverHost, serverPort, rconPassword, `game_type ${gameType}`);
      await this.executeCommand(serverHost, serverPort, rconPassword, `game_mode ${gameMode}`);
      
      // 🆕 ИСПОЛЬЗУЕМ "changelevel" ВМЕСТО "map" - НЕ ПЕРЕЗАГРУЖАЕТ СЕРВЕР!
      console.log(`[CS2] Меняем карту на ${mapName} через changelevel...`);
      await this.executeCommand(serverHost, serverPort, rconPassword, `changelevel ${mapName}`);
      
      // 🆕 ЖДЕМ ЗАГРУЗКИ НОВОЙ КАРТЫ (30 секунд достаточно)
      console.log('[CS2] Ожидание загрузки карты (30 сек)...');
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      // 🆕 ПРОВЕРЯЕМ ДОСТУПНОСТЬ
      console.log('[CS2] Проверка доступности сервера...');
      let serverReady = false;
      let attempts = 0;
      
      while (!serverReady && attempts < 10) {
        attempts++;
        try {
          await this.executeCommand(serverHost, serverPort, rconPassword, 'echo "Server Ready"');
          serverReady = true;
          console.log('[CS2] ✅ Сервер готов!');
        } catch (err) {
          console.log(`[CS2] Попытка ${attempts}/10: сервер еще загружается...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      if (!serverReady) {
        throw new Error('Сервер не ответил после смены карты (таймаут 60+ секунд)');
      }
      
      console.log(`[CS2] ✅ Карта ${mapName} загружена, сервер готов!`);
      
    } catch (error) {
      console.error(`[CS2] Failed to configure server:`, error.message);
      throw error;
    }
  }

  /**
   * Кикнуть всех игроков
   */
  async kickAll(host, port, password) {
    console.log(`[CS2] Kicking all players from ${host}:${port}`);
    await this.executeCommand(host, port, password, 'kickall');
  }

  /**
   * Получить статус сервера
   */
  async getStatus(host, port, password) {
    const response = await this.executeCommand(host, port, password, 'status');
    return this.parseStatus(response);
  }

  /**
   * Парсинг вывода команды status
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
      // hostname: 1Lobby CS2 Server
      if (line.includes('hostname:')) {
        status.hostname = line.split(':')[1]?.trim() || '';
      }
      
      // map     : de_dust2
      if (line.includes('map') && line.includes(':')) {
        status.map = line.split(':')[1]?.trim() || '';
      }
      
      // players : 5 / 10
      if (line.includes('players')) {
        const match = line.match(/(\d+)\s*\/\s*(\d+)/);
        if (match) {
          status.players = parseInt(match[1]);
          status.maxPlayers = parseInt(match[2]);
        }
      }
      
      // # userid name uniqueid connected ping loss state rate
      // # 2 "DURAEB" STEAM_1:0:123456 05:23 50 0 active 786432
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
    // STEAM_0:1:123456 -> 76561197960265728 + (123456 * 2) + 1
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

  /**
   * Создать match config и загрузить через get5
   */
  async assignPlayersToTeams(teamAPlayers, teamBPlayers, serverHost, serverPort, rconPassword) {
    try {
      console.log('[CS2] Создаем match config для MatchZy...');
      
      // Формируем config
      const matchConfig = {
        "matchid": `1lobby_${Date.now()}`,
        "num_maps": 1,
        "maplist": ["de_dust2"], // Будет текущая карта
        "skip_veto": true,
        "players_per_team": Math.max(Object.keys(teamAPlayers).length, Object.keys(teamBPlayers).length),
        "min_players_to_ready": 0, // Автостарт
        "team1": {
          "name": "Team A",
          "players": Object.entries(teamAPlayers).reduce((acc, [steamId, username]) => {
            acc[steamId] = username;
            return acc;
          }, {})
        },
        "team2": {
          "name": "Team B", 
          "players": Object.entries(teamBPlayers).reduce((acc, [steamId, username]) => {
            acc[steamId] = username;
            return acc;
          }, {})
        }
      };
      
      console.log('[CS2] Match Config:', JSON.stringify(matchConfig, null, 2));
      
      // 🆕 АЛЬТЕРНАТИВА: Просто логируем команды для ручной проверки
      // В будущем можно загрузить config через HTTP endpoint MatchZy
      
      console.log('[CS2] === КОМАНДЫ ДЛЯ РУЧНОГО РАЗМЕЩЕНИЯ ===');
      console.log('[CS2] Если игроки не разместятся автоматически, выполните в консоли сервера:');
      for (const [steamId, username] of Object.entries(teamAPlayers)) {
        console.log(`[CS2]   matchzy_addplayer ${steamId} team1 "${username}"`);
      }
      for (const [steamId, username] of Object.entries(teamBPlayers)) {
        console.log(`[CS2]   matchzy_addplayer ${steamId} team2 "${username}"`);
      }
      console.log('[CS2] ==========================================');
      
      console.log('[CS2] ⚠️ Автоматическое размещение пока недоступно.');
      console.log('[CS2] Игроки должны вручную выбрать команды при подключении.');
      
    } catch (error) {
      console.error('[CS2 Match] ❌ Ошибка:', error.message);
      throw error;
    }
  }

}

module.exports = new CS2Service();