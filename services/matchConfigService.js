const { Client } = require('ssh2');
const path = require('path');

class MatchConfigService {
  constructor() {
    this.sshConfig = {
      host: '134.209.246.42',
      port: 22,
      username: 'root',
      privateKey: require('fs').readFileSync('/root/.ssh/id_rsa')
    };
    
    this.configDir = '/root/cs2-configs'; // Локальная папка для конфигов
    this.serverConfigDir = '/home/steam/cs2-dedicated/game/csgo/cfg/MatchZy'; // На CS2 сервере
  }

  /**
   * Создать и загрузить match config на сервер
   */
  async createAndUploadMatchConfig(matchData) {
    const { matchId, map, teamA, teamB } = matchData;
    
    // 1. Формируем JSON config для MatchZy
    const config = {
      "matchid": `1lobby_${matchId}`,
      "num_maps": 1,
      "maplist": [map], // 🆕 ПРАВИЛЬНАЯ КАРТА ИЗ ЛОББИ!
      "skip_veto": true,
      "players_per_team": Math.max(Object.keys(teamA).length, Object.keys(teamB).length),
      "min_players_to_ready": 0, // Автостарт
      "team1": {
        "name": "Team A",
        "players": teamA // { "76561198841464187": "durachek", ... }
      },
      "team2": {
        "name": "Team B",
        "players": teamB
      }
    };

    console.log('[MatchConfig] Создан config:', JSON.stringify(config, null, 2));

    // 2. Создаем локальную директорию если нет
    const fs = require('fs').promises;
    await fs.mkdir(this.configDir, { recursive: true });

    // 3. Сохраняем локально
    const localPath = path.join(this.configDir, `match_${matchId}.json`);
    await fs.writeFile(localPath, JSON.stringify(config, null, 2));
    console.log(`[MatchConfig] Сохранён локально: ${localPath}`);

    // 4. Загружаем на сервер через SCP
    const remotePath = `${this.serverConfigDir}/match_${matchId}.json`;
    await this.uploadFileViaSCP(localPath, remotePath);
    console.log(`[MatchConfig] Загружен на сервер: ${remotePath}`);

    return `cfg/MatchZy/match_${matchId}.json`; // Относительный путь для команды
  }

  /**
   * Загрузить файл на сервер через SCP
   */
  async uploadFileViaSCP(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        console.log('[SCP] SSH соединение установлено');
        
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          const fs = require('fs');
          const readStream = fs.createReadStream(localPath);
          const writeStream = sftp.createWriteStream(remotePath);

          writeStream.on('close', () => {
            console.log('[SCP] ✅ Файл успешно загружен!');
            conn.end();
            resolve();
          });

          writeStream.on('error', (err) => {
            conn.end();
            reject(err);
          });

          readStream.pipe(writeStream);
        });
      });

      conn.on('error', (err) => {
        reject(err);
      });

      conn.connect(this.sshConfig);
    });
  }

  /**
   * Удалить старый конфиг
   */
  async deleteMatchConfig(matchId) {
    try {
      const fs = require('fs').promises;
      const localPath = path.join(this.configDir, `match_${matchId}.json`);
      await fs.unlink(localPath);
      console.log(`[MatchConfig] Удалён локальный файл: ${localPath}`);
    } catch (err) {
      console.error('[MatchConfig] Ошибка удаления:', err.message);
    }
  }
}

module.exports = new MatchConfigService();