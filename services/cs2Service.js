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
}

module.exports = new CS2Service();