const axios = require('axios');

// Конфигурация Bot Servers
const BOT_SERVERS = [
  {
    id: 'bot-server-1',
    url: 'http://134.209.246.42:8080',
    maxBots: 5,
    status: 'online'
  }
  // Добавляй сюда новые серверы по мере роста
];

class BotService {
  /**
   * Получить доступный Bot Server
   */
  getAvailableBotServer() {
    const server = BOT_SERVERS.find(s => s.status === 'online');
    
    if (!server) {
      throw new Error('No bot servers available');
    }
    
    return server;
  }

  /**
   * Проверить статус ботов на сервере
   */
  async checkBotsStatus(serverUrl) {
    try {
      const response = await axios.get(`${serverUrl}/bots/status`, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error(`Failed to check bots status: ${error.message}`);
      throw new Error('Bot server unavailable');
    }
  }

  /**
   * Создать лобби в Dota 2
   */
  async createDotaLobby(lobbyData) {
    const server = this.getAvailableBotServer();
    
    // Проверяем есть ли свободные боты
    const status = await this.checkBotsStatus(server.url);
    
    if (status.available === 0) {
      throw new Error('All bots are busy. Please try again later.');
    }

    try {
      const response = await axios.post(`${server.url}/lobby/create`, {
        lobbyName: lobbyData.name,
        password: lobbyData.password || '',
        region: lobbyData.region || 8, // Europe West
        gameMode: lobbyData.gameMode || 22, // All Pick
        radiantPlayers: lobbyData.radiantPlayers.map(p => ({
          steamId: p.steamId, // Оставляем как строку!
          slot: p.slot || 1
        })),
        direPlayers: lobbyData.direPlayers.map(p => ({
          steamId: p.steamId, // Оставляем как строку!
          slot: p.slot || 1
        }))
      }, {
        timeout: 60000 // 60 секунд для создания лобби
      });

      return {
        success: true,
        lobbyId: response.data.lobbyId,
        botServerId: server.id,
        message: response.data.message
      };
    } catch (error) {
      console.error('Failed to create lobby:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error || 'Failed to create lobby');
    }
  }

  /**
   * Запустить игру
   */
  async startGame(lobbyId, serverUrl) {
    try {
      const response = await axios.post(`${serverUrl}/lobby/${lobbyId}/start`, {}, {
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      console.error('Failed to start game:', error.response?.data || error.message);
      throw new Error('Failed to start game');
    }
  }

  /**
   * Кикнуть игрока из лобби
   */
  async kickPlayer(lobbyId, steamId, serverUrl) {
    try {
      const response = await axios.post(
        `${serverUrl}/lobby/${lobbyId}/kick/${steamId}`,
        {},
        { timeout: 5000 }
      );
      return response.data;
    } catch (error) {
      console.error('Failed to kick player:', error.response?.data || error.message);
      throw new Error('Failed to kick player');
    }
  }

  /**
   * Получить статус лобби
   */
  async getLobbyStatus(lobbyId, serverUrl) {
    try {
      const response = await axios.get(`${serverUrl}/lobby/${lobbyId}/status`, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('Failed to get lobby status:', error.response?.data || error.message);
      throw new Error('Failed to get lobby status');
    }
  }

  /**
   * Проверить сколько игроков зашло в лобби
   */
  async checkLobbyPlayers(lobbyId, serverUrl) {
    try {
      const response = await axios.get(`${serverUrl}/lobby/${lobbyId}/players`, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('Failed to check lobby players:', error.response?.data || error.message);
      throw new Error('Failed to check lobby players');
    }
  }

  /**
   * 🆕 Получить результат матча
   */
  async getMatchResult(lobbyId, serverUrl) {
    try {
      const response = await axios.get(`${serverUrl}/lobby/${lobbyId}/result`, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('Failed to get match result:', error.response?.data || error.message);
      throw new Error('Failed to get match result');
    }
  }

  /**
   * Освободить лобби и бота
   */
  async releaseLobby(lobbyId, serverUrl) {
    try {
      const response = await axios.post(`${serverUrl}/lobby/${lobbyId}/release`, {}, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.error('Failed to release lobby:', error.response?.data || error.message);
      throw new Error('Failed to release lobby');
    }
  }

  /**
   * Health check всех Bot Servers
   */
  async healthCheckAll() {
    const results = [];

    for (const server of BOT_SERVERS) {
      try {
        const response = await axios.get(`${server.url}/health`, {
          timeout: 3000
        });
        
        results.push({
          serverId: server.id,
          status: 'online',
          url: server.url
        });
      } catch (error) {
        results.push({
          serverId: server.id,
          status: 'offline',
          url: server.url,
          error: error.message
        });
      }
    }

    return results;
  }
}

module.exports = new BotService();