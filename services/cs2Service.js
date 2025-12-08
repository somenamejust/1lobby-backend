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
  async createAndLoadMatchConfig(lobbyId, teamAPlayers, teamBPlayers, mapName, serverHost, serverPort, rconPassword) {
    const { exec } = require('child_process');
    const util = require('util');
    const fs = require('fs').promises;
    const execPromise = util.promisify(exec);
    
    try {
      console.log('[CS2 Config] Создаём match config...');
      
      const matchConfig = {
        matchid: String(lobbyId),
        num_maps: 1,
        maplist: [mapName],
        team1: { 
          name: "Team A", 
          players: teamAPlayers 
        },
        team2: { 
          name: "Team B", 
          players: teamBPlayers 
        },
        "minimum_ready_required": 0,
        "players_per_team": Object.keys(teamAPlayers).length,
        "skip_veto": true,
        "clinch_series": false,
        "wingman": false
      };
      
      console.log('[CS2 Config] Match config:', JSON.stringify(matchConfig, null, 2));
      
      const configFileName = `match_${lobbyId}.json`;
      const remotePath = `~/cs2-docker/cs2-data/game/csgo/cfg/MatchZy/${configFileName}`;
      const localPath = `/tmp/${configFileName}`;
      const configContent = JSON.stringify(matchConfig, null, 2);
      await fs.writeFile(localPath, configContent);
      
      const scpCommand = `scp ${localPath} root@${serverHost}:${remotePath}`;
      await execPromise(scpCommand);
      console.log(`[CS2 Config] ✅ Конфиг скопирован`);
      
      const chownCmd = `ssh root@${serverHost} "docker exec -u root cs2-docker chown 1000:1000 /home/steam/cs2-dedicated/game/csgo/cfg/MatchZy/${configFileName}"`;
      await execPromise(chownCmd);
      console.log('[CS2 Config] ✅ Владелец изменён');
      
      await fs.unlink(localPath);
    
      // 🆕 Ждём 10 секунд после changelevel (достаточно!)
      console.log('[CS2] Ожидание загрузки карты (10 сек)...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      const self = this;
      
      // 🆕 Загружаем конфиг СРАЗУ (MatchZy теперь знает расстановку)
      console.log('[CS2] Загружаем match config в MatchZy...');
      await self.executeCommand(serverHost, serverPort, rconPassword, `matchzy_loadmatch ${configFileName}`);
      console.log('[CS2 Config] ✅ MatchZy знает кто в какой команде!');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 🆕 АКТИВНОЕ ОЖИДАНИЕ игроков (проверяем каждые 3 секунды)
      console.log('[CS2] Ожидание подключения игроков...');
      const expectedPlayers = Object.keys(teamAPlayers).length + Object.keys(teamBPlayers).length;
      let connectedPlayers = 0;
      let attempts = 0;
      const maxAttempts = 20; // 20 попыток по 3 сек = максимум 1 минута
      
      while (connectedPlayers < expectedPlayers && attempts < maxAttempts) {
        attempts++;
        
        try {
          const statusOutput = await self.executeCommand(serverHost, serverPort, rconPassword, 'status');
          
          // Считаем игроков (строки с [U:1:...] но без BOT)
          const lines = statusOutput.split('\n');
          connectedPlayers = lines.filter(line => 
            line.includes('[U:1:') && !line.includes('BOT')
          ).length;
          
          console.log(`[CS2] Попытка ${attempts}/${maxAttempts}: Подключено ${connectedPlayers}/${expectedPlayers} игроков`);
          
          if (connectedPlayers >= expectedPlayers) {
            console.log('[CS2] ✅ Все игроки подключены!');
            break;
          }
          
          // Ждём 3 секунды перед следующей проверкой
          await new Promise(resolve => setTimeout(resolve, 3000));
          
        } catch (err) {
          console.warn(`[CS2] Ошибка проверки status: ${err.message}`);
        }
      }
      
      if (connectedPlayers < expectedPlayers) {
        console.warn(`[CS2] ⚠️ Подключено только ${connectedPlayers}/${expectedPlayers}, но продолжаем...`);
      }

      // 🆕 ТЕПЕРЬ размещаем игроков (они УЖЕ на сервере!)
      console.log('[CS2] Размещаем игроков в команды...');
      await self.executeCommand(serverHost, serverPort, rconPassword, `matchzy_loadmatch ${configFileName}`);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Рестарт для применения
      console.log('[CS2] Применяем через рестарт...');
      await self.executeCommand(serverHost, serverPort, rconPassword, 'mp_restartgame 1');

      console.log('[CS2 Match] ✅ Игроки размещены в команды!');

      return configFileName;
    } catch (error) {
      console.error('[CS2 Config] ❌ Ошибка:', error.message);
      throw error;
    }
  }

}

module.exports = new CS2Service();