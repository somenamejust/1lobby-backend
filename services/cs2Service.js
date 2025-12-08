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
  async setMapAndMode(host, port, password, map = 'de_dust2', gameType = 0, gameMode = 1) {
    console.log(`[CS2] Setting up: ${map}, type=${gameType}, mode=${gameMode}`);
    
    await this.executeCommand(host, port, password, `game_type ${gameType}`);
    await this.executeCommand(host, port, password, `game_mode ${gameMode}`);
    await this.executeCommand(host, port, password, `changelevel ${map}`);
    
    console.log(`[CS2] Server configured successfully`);
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
   * Создать и загрузить match config
   */
  async assignPlayersToTeams(teamAPlayers, teamBPlayers, serverHost, serverPort, rconPassword) {
    try {
      console.log('[CS2] Назначаем игроков в команды через MatchZy...');
      
      const self = this;
      
      // 🆕 УВЕЛИЧИВАЕМ ЗАДЕРЖКУ до 15 секунд!
      console.log('[CS2] Ожидание загрузки карты (15 сек)...');
      await new Promise(resolve => setTimeout(resolve, 15000));
      
      // 🆕 ПРОВЕРЯЕМ ДОСТУПНОСТЬ RCON перед началом
      console.log('[CS2] Проверка доступности RCON...');
      let rconReady = false;
      let rconAttempts = 0;
      
      while (!rconReady && rconAttempts < 10) {
        rconAttempts++;
        try {
          await self.executeCommand(serverHost, serverPort, rconPassword, 'echo "RCON OK"');
          rconReady = true;
          console.log('[CS2] ✅ RCON доступен!');
        } catch (err) {
          console.log(`[CS2] RCON попытка ${rconAttempts}/10: ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      if (!rconReady) {
        throw new Error('CS2 сервер не отвечает на RCON после 20+ секунд');
      }
      
      // 🆕 ТЕПЕРЬ ЖДЁМ ИГРОКОВ
      const expectedPlayers = Object.keys(teamAPlayers).length + Object.keys(teamBPlayers).length;
      let connectedPlayers = 0;
      let attempts = 0;
      const maxAttempts = 20;
      
      console.log('[CS2] Ожидание подключения игроков...');
      
      while (connectedPlayers < expectedPlayers && attempts < maxAttempts) {
        attempts++;
        
        try {
          const statusOutput = await self.executeCommand(serverHost, serverPort, rconPassword, 'status');
          const lines = statusOutput.split('\n');
          connectedPlayers = lines.filter(line => 
            line.includes('[U:1:') && !line.includes('BOT')
          ).length;
          
          console.log(`[CS2] Попытка ${attempts}/${maxAttempts}: Подключено ${connectedPlayers}/${expectedPlayers} игроков`);
          
          if (connectedPlayers >= expectedPlayers) {
            console.log('[CS2] ✅ Все игроки подключены!');
            break;
          }
          
          await new Promise(resolve => setTimeout(resolve, 3000));
          
        } catch (err) {
          console.warn(`[CS2] Ошибка проверки игроков: ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      if (connectedPlayers < expectedPlayers) {
        console.warn(`[CS2] ⚠️ Подключено только ${connectedPlayers}/${expectedPlayers}, продолжаем...`);
      }

      // 🆕 РАЗМЕЩАЕМ ИГРОКОВ через matchzy_addplayer
      console.log('[CS2] Добавляем игроков в Team A...');
      for (const [steamId, username] of Object.entries(teamAPlayers)) {
        const command = `matchzy_addplayer ${steamId} team1 "${username}"`;
        console.log(`[CS2] > ${command}`);
        try {
          await self.executeCommand(serverHost, serverPort, rconPassword, command);
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          console.error(`[CS2] ❌ Не удалось добавить ${username}: ${err.message}`);
        }
      }
      
      console.log('[CS2] Добавляем игроков в Team B...');
      for (const [steamId, username] of Object.entries(teamBPlayers)) {
        const command = `matchzy_addplayer ${steamId} team2 "${username}"`;
        console.log(`[CS2] > ${command}`);
        try {
          await self.executeCommand(serverHost, serverPort, rconPassword, command);
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          console.error(`[CS2] ❌ Не удалось добавить ${username}: ${err.message}`);
        }
      }

      console.log('[CS2 Match] ✅ Все игроки размещены в команды!');
      
    } catch (error) {
      console.error('[CS2 Match] ❌ Ошибка:', error.message);
      throw error;
    }
  }

}

module.exports = new CS2Service();