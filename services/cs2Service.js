const { exec } = require('child_process');
const { Rcon } = require('rcon-client');
const matchConfigService = require('./matchConfigService');
const cs2ServerPool = require('./cs2ServerPool');

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
   * Запустить матч через MatchZy Config
   */
  async startMatchViaConfig(lobbyId, map, teamA, teamB) {
    try {
      const server = cs2ServerPool.getServerByLobby(lobbyId);
      if (!server) {
        throw new Error('Server not assigned to this lobby');
      }

      console.log('[CS2] Запуск нового матча...');
      
      // Перезагружаем плагин MatchZy
      console.log('[CS2] Перезагрузка плагина MatchZy...');
      await this.executeCommand(
        server.host,
        server.port,
        server.rconPassword,
        'css_plugins reload MatchZy'
      );
      console.log('[CS2] ✅ MatchZy перезагружен');
      
      // Пауза после перезагрузки
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Создаем конфиг
      const configPath = await matchConfigService.createAndUploadMatchConfig({
        matchId: lobbyId,
        map: map,
        teamA: teamA,
        teamB: teamB
      });
      
      console.log(`[CS2 Match] Config создан: ${configPath}`);
      console.log(`[CS2 Match] Карта: ${map}`);
      console.log(`[CS2 Match] Team A (T): ${Object.keys(teamA).join(', ')}`);
      console.log(`[CS2 Match] Team B (CT): ${Object.keys(teamB).join(', ')}`);
      
      // Загружаем конфиг (MatchZy САМ сменит карту!)
      console.log(`[CS2 Match] Загрузка конфига...`);
      const loadResponse = await this.executeCommand(
        server.host,
        server.port,
        server.rconPassword,
        `matchzy_loadmatch cfg/MatchZy/${configPath}`
      );
      
      console.log(`[CS2 Match] Ответ MatchZy:`, loadResponse);
      
      // Проверяем успех загрузки
      if (loadResponse && loadResponse.includes('cannot load a new match')) {
        throw new Error('Failed to load match config after plugin reload');
      }
      
      // 🆕 ПРИНУДИТЕЛЬНО УСТАНАВЛИВАЕМ CVARS ДЛЯ АВТОМАТИЧЕСКОГО РАСПРЕДЕЛЕНИЯ
      console.log('[CS2] Установка cvars для автоматического распределения...');
      await this.executeCommand(
        server.host,
        server.port,
        server.rconPassword,
        'mp_team_intro_time 0; mp_force_pick_time 0; mp_limitteams 0; mp_autoteambalance 0'
      );
      console.log('[CS2] ✅ Cvars установлены принудительно');
      
      // ЖДЕМ ПОКА MATCHZY СМЕНИТ КАРТУ (если нужно)
      console.log(`[CS2] ⏱️ Ожидание готовности сервера...`);

      let serverReady = false;
      let attempts = 0;
      const maxAttempts = 20;

      while (!serverReady && attempts < maxAttempts) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        try {
          const response = await this.executeCommand(
            server.host,
            server.port,
            server.rconPassword,
            'status'
          );
          
          // Проверяем что:
          // 1. Сервер в состоянии "game" (не "levelload")
          // 2. Карта правильная
          if (response && 
              response.includes('@ Current  :  game') && 
              response.includes(`map     : ${map}`)) {
            serverReady = true;
            console.log(`[CS2] ✅ Сервер готов на карте ${map}`);
          }
        } catch (error) {
          // Продолжаем ждать
        }
      }

      if (!serverReady) {
        console.log('[CS2] ⚠️ Таймаут ожидания готовности сервера');
      }
      
      console.log('[CS2 Match] ✅ Конфиг загружен!');
      console.log('[CS2 Match] ℹ️ Инструкция:');
      console.log('[CS2 Match]   1. connect 134.209.246.42:27015');
      console.log('[CS2 Match]   2. АВТОМАТИЧЕСКОЕ распределение в команды');
      console.log('[CS2 Match]   3. Написать .ready в чат');
      
      return {
        success: true,
        message: `Матч на ${map}. Подключитесь и напишите .ready!`,
        connectString: `connect ${server.host}:${server.port}`
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