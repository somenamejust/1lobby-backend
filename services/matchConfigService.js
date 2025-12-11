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
    this.tempDir = '/tmp/matchzy-configs'; // 🆕 Временная папка на хосте
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

    // 2. Создаем локальную директорию
    const fs = require('fs').promises;
    await fs.mkdir(this.configDir, { recursive: true });

    // 3. Сохраняем локально
    const filename = `match_${matchId}.json`;
    const localPath = path.join(this.configDir, filename);
    await fs.writeFile(localPath, JSON.stringify(config, null, 2));
    console.log(`[MatchConfig] Сохранён локально: ${localPath}`);

    // 4. 🆕 Загружаем на хост во временную папку
    const tempPath = `${this.tempDir}/${filename}`;
    await this.uploadFileViaSCP(localPath, tempPath);

    // 5. 🆕 Копируем внутрь контейнера через docker cp
    await this.copyToContainer(filename);

    // 6. 🆕 Удаляем временный файл
    await this.cleanupTempFile(filename);

    console.log(`[MatchConfig] ✅ Файл загружен в контейнер: ${this.containerPath}/${filename}`);

    return `cfg/MatchZy/${filename}`; // Путь для MatchZy команды
  }

  /**
   * 🆕 Копировать файл внутрь контейнера
   */
  async copyToContainer(filename) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        const tempPath = `${this.tempDir}/${filename}`;
        const containerPath = `${this.containerPath}/${filename}`;
        
        // Сначала создаем папку в контейнере
        const mkdirCmd = `docker exec cs2-docker mkdir -p ${this.containerPath}`;
        
        conn.exec(mkdirCmd, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          
          stream.on('close', () => {
            // Теперь копируем файл
            const cpCmd = `docker cp ${tempPath} cs2-docker:${containerPath}`;
            
            conn.exec(cpCmd, (err, stream) => {
              if (err) {
                conn.end();
                return reject(err);
              }
              
              stream.on('close', (code) => {
                conn.end();
                if (code === 0) {
                  console.log('[Docker] ✅ Файл скопирован в контейнер');
                  resolve();
                } else {
                  reject(new Error(`docker cp failed with code ${code}`));
                }
              });
              
              stream.on('data', (data) => {
                console.log('[Docker]', data.toString());
              });
              
              stream.stderr.on('data', (data) => {
                console.error('[Docker Error]', data.toString());
              });
            });
          });
          
          stream.on('data', (data) => {
            console.log('[Docker]', data.toString());
          });
        });
      });

      conn.on('error', (err) => {
        reject(err);
      });

      conn.connect(this.sshConfig);
    });
  }

  /**
   * 🆕 Удалить временный файл
   */
  async cleanupTempFile(filename) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        const cmd = `rm -f ${this.tempDir}/${filename}`;
        
        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          
          stream.on('close', () => {
            console.log('[Cleanup] ✅ Временный файл удален');
            conn.end();
            resolve();
          });
        });
      });

      conn.on('error', (err) => {
        reject(err);
      });

      conn.connect(this.sshConfig);
    });
  }

  /**
   * Загрузить файл на хост через SCP
   */
  async uploadFileViaSCP(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        console.log('[SCP] SSH соединение установлено');
        
        // Сначала создаем папку
        const dir = path.dirname(remotePath);
        conn.exec(`mkdir -p ${dir}`, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          
          stream.on('close', () => {
            // Теперь загружаем файл
            conn.sftp((err, sftp) => {
              if (err) {
                conn.end();
                return reject(err);
              }

              const fs = require('fs');
              const readStream = fs.createReadStream(localPath);
              const writeStream = sftp.createWriteStream(remotePath);

              writeStream.on('close', () => {
                console.log('[SCP] ✅ Файл загружен на хост');
                sftp.end();
                conn.end();
                resolve();
              });

              writeStream.on('error', (err) => {
                sftp.end();
                conn.end();
                reject(err);
              });

              readStream.pipe(writeStream);
            });
          });
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