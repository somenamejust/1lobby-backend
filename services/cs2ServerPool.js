class CS2ServerPool {
  constructor() {
    this.servers = [
      {
        id: 'cs2-main',
        host: '134.209.246.42',
        port: 27015,
        rconPassword: 'ps123if34duU', // 🔴 ЗАМЕНИ на свой!
        status: 'available', // available, in_use, offline
        currentLobbyId: null,
        maxPlayers: 10
      }
      // 🆕 Добавишь больше серверов потом:
      // {
      //   id: 'cs2-2',
      //   host: 'другой_ip',
      //   port: 27015,
      //   rconPassword: 'pass2',
      //   status: 'available',
      //   currentLobbyId: null,
      //   maxPlayers: 10
      // }
    ];
  }

  /**
   * Получить свободный сервер
   */
  getAvailableServer() {
    const available = this.servers.filter(s => s.status === 'available');
    
    if (available.length === 0) {
      throw new Error('No available CS2 servers. All servers are busy.');
    }
    
    // Возвращаем первый свободный
    return available[0];
  }

  /**
   * Назначить сервер для лобби
   */
  assignServer(lobbyId) {
    const server = this.getAvailableServer();
    
    server.status = 'in_use';
    server.currentLobbyId = lobbyId;
    
    console.log(`[CS2Pool] Server ${server.id} assigned to lobby ${lobbyId}`);
    
    return server;
  }

  /**
   * Освободить сервер
   */
  releaseServer(serverId) {
    const server = this.servers.find(s => s.id === serverId);
    
    if (!server) {
      console.warn(`[CS2Pool] Server ${serverId} not found`);
      return;
    }
    
    server.status = 'available';
    server.currentLobbyId = null;
    
    console.log(`[CS2Pool] Server ${serverId} released`);
  }

  /**
   * Получить сервер по ID
   */
  getServerById(serverId) {
    return this.servers.find(s => s.id === serverId);
  }

  /**
   * Получить все серверы
   */
  getAllServers() {
    return this.servers;
  }

  /**
   * Health check всех серверов
   */
  async healthCheckAll() {
    const cs2Service = require('./cs2Service');
    
    for (const server of this.servers) {
      try {
        await cs2Service.getStatus(server.host, server.port, server.rconPassword);
        
        // Если был offline - восстанавливаем статус
        if (server.status === 'offline' && !server.currentLobbyId) {
          server.status = 'available';
        }
        
      } catch (error) {
        console.error(`[CS2Pool] Server ${server.id} health check failed:`, error.message);
        server.status = 'offline';
      }
    }
    
    console.log(`[CS2Pool] Health check complete:`, this.getStatusSummary());
  }

  /**
   * Сводка по статусам серверов
   */
  getStatusSummary() {
    return {
      total: this.servers.length,
      available: this.servers.filter(s => s.status === 'available').length,
      inUse: this.servers.filter(s => s.status === 'in_use').length,
      offline: this.servers.filter(s => s.status === 'offline').length
    };
  }
}

module.exports = new CS2ServerPool();