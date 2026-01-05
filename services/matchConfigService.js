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
    
    this.configDir = '/root/cs2-configs';
    this.tempDir = '/tmp/matchzy-configs';
    this.containerPath = '/home/steam/cs2-dedicated/game/csgo/cfg/MatchZy';
  }

  async createAndUploadMatchConfig(matchData) {
    const { matchId, map, teamA, teamB } = matchData;

    // 🆕 ИСПРАВЛЕНИЕ: Уменьшаем matchId до размера int32
    const safeMatchId = Math.floor(matchId / 1000); // Убираем миллисекунды
    console.log(`[MatchConfig] Исходный matchId: ${matchId}`);
    console.log(`[MatchConfig] Безопасный matchId: ${safeMatchId}`);
    
    const config = {
      "matchid": safeMatchId,
      "num_maps": 1,
      "maplist": ["de_dust2"],
      "map_sides": ["team2_ct"],
      "skip_veto": true,
      "players_per_team": Math.max(Object.keys(teamA).length, Object.keys(teamB).length),
      "min_players_to_ready": Math.max(Object.keys(teamA).length, Object.keys(teamB).length),
      "team1": {
        "name": "Team A",
        "players": teamA
      },
      "team2": {
        "name": "Team B",
        "players": teamB
      }
    };

    console.log('[MatchConfig] Создан config:', JSON.stringify(config, null, 2));

    const fs = require('fs').promises;
    await fs.mkdir(this.configDir, { recursive: true });

    const filename = `match_${matchId}.json`;
    const localPath = path.join(this.configDir, filename);
    await fs.writeFile(localPath, JSON.stringify(config, null, 2));
    console.log(`[MatchConfig] Сохранён локально: ${localPath}`);

    // 🆕 УПРОЩЕННЫЙ ПОДХОД: Загружаем СРАЗУ в контейнер
    await this.uploadToContainer(localPath, filename);

    console.log(`[MatchConfig] ✅ Файл загружен в контейнер`);

    return filename;
  }

  /**
   * 🆕 Загрузка НАПРЯМУЮ в контейнер
   */
  async uploadToContainer(localPath, filename) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        console.log('[SSH] Соединение установлено');
        
        // Шаг 1: Создаем временную папку на хосте
        const tempPath = `${this.tempDir}/${filename}`;
        const mkdirCmd = `mkdir -p ${this.tempDir}`;
        
        console.log('[SSH] Создаю временную папку:', this.tempDir);
        
        conn.exec(mkdirCmd, (err, stream) => {
          if (err) {
            console.error('[SSH] ❌ Ошибка mkdir:', err.message);
            conn.end();
            return reject(err);
          }

          stream.on('close', (code) => {
            console.log(`[SSH] mkdir завершен с кодом: ${code}`);
            
            // Шаг 2: Загружаем файл на хост через SFTP
            console.log('[SFTP] Начинаю загрузку файла...');
            
            conn.sftp((err, sftp) => {
              if (err) {
                console.error('[SFTP] ❌ Ошибка sftp:', err.message);
                conn.end();
                return reject(err);
              }

              const fs = require('fs');
              const readStream = fs.createReadStream(localPath);
              const writeStream = sftp.createWriteStream(tempPath);

              writeStream.on('close', () => {
                console.log('[SFTP] ✅ Файл загружен на хост:', tempPath);
                
                // Шаг 3: Создаем папку в контейнере
                const mkdirContainerCmd = `docker exec cs2-docker mkdir -p ${this.containerPath}`;
                
                console.log('[Docker] Создаю папку в контейнере...');
                
                conn.exec(mkdirContainerCmd, (err, stream2) => {
                  if (err) {
                    console.error('[Docker] ❌ Ошибка mkdir в контейнере:', err.message);
                    conn.end();
                    return reject(err);
                  }

                  stream2.on('close', (code2) => {
                    console.log(`[Docker] mkdir в контейнере завершен с кодом: ${code2}`);
                    
                    // Шаг 4: Копируем файл в контейнер
                    const cpCmd = `docker cp ${tempPath} cs2-docker:${this.containerPath}/${filename}`;
                    
                    console.log('[Docker] Копирую файл в контейнер...');
                    console.log('[Docker] Команда:', cpCmd);
                    
                    conn.exec(cpCmd, (err, stream3) => {
                      if (err) {
                        console.error('[Docker] ❌ Ошибка docker cp:', err.message);
                        conn.end();
                        return reject(err);
                      }

                      let stdout = '';
                      let stderr = '';

                      stream3.on('data', (data) => {
                        stdout += data.toString();
                        console.log('[Docker stdout]', data.toString());
                      });

                      stream3.stderr.on('data', (data) => {
                        stderr += data.toString();
                        console.error('[Docker stderr]', data.toString());
                      });

                      stream3.on('close', (code3) => {
                        console.log(`[Docker] cp завершен с кодом: ${code3}`);
                        
                        if (code3 !== 0) {
                          conn.end();
                          return reject(new Error(`docker cp failed: ${stderr}`));
                        }
                        
                        // 🆕 ШАГ 5: МЕНЯЕМ OWNERSHIP
                        const containerFilePath = `${this.containerPath}/${filename}`;
                        const chownCmd = `docker exec -u root cs2-docker chown steam:steam ${containerFilePath}`;
                        
                        console.log('[Docker] Меняю ownership на steam:steam...');
                        
                        conn.exec(chownCmd, (err, stream4) => {
                          if (err) {
                            console.error('[Docker] ⚠️ Ошибка chown:', err.message);
                          }

                          stream4.on('close', (code4) => {
                            console.log(`[Docker] chown завершен с кодом: ${code4}`);
                            
                            // ШАГ 6: УДАЛЯЕМ ВРЕМЕННЫЙ ФАЙЛ
                            const rmCmd = `rm -f ${tempPath}`;
                            
                            console.log('[Cleanup] Удаляю временный файл...');
                            
                            conn.exec(rmCmd, (err, stream5) => {
                              if (err) {
                                console.error('[Cleanup] ⚠️ Не удалось удалить временный файл:', err.message);
                              } else {
                                stream5.on('close', () => {
                                  console.log('[Cleanup] ✅ Временный файл удален');
                                });
                              }
                              
                              conn.end();
                              resolve();
                            });
                          });

                          stream4.on('data', (data) => {
                            console.log('[Docker chown stdout]', data.toString());
                          });

                          stream4.stderr.on('data', (data) => {
                            console.error('[Docker chown stderr]', data.toString());
                          });
                        });
                      });
                    });
                  });

                  stream2.on('data', (data) => {
                    console.log('[Docker mkdir stdout]', data.toString());
                  });

                  stream2.stderr.on('data', (data) => {
                    console.error('[Docker mkdir stderr]', data.toString());
                  });
                });
              });

              writeStream.on('error', (err) => {
                console.error('[SFTP] ❌ Ошибка записи:', err.message);
                sftp.end();
                conn.end();
                reject(err);
              });

              readStream.on('error', (err) => {
                console.error('[SFTP] ❌ Ошибка чтения:', err.message);
                sftp.end();
                conn.end();
                reject(err);
              });

              readStream.pipe(writeStream);
            });
          });

          stream.on('data', (data) => {
            console.log('[SSH mkdir stdout]', data.toString());
          });

          stream.stderr.on('data', (data) => {
            console.error('[SSH mkdir stderr]', data.toString());
          });
        });
      });

      conn.on('error', (err) => {
        console.error('[SSH] ❌ Ошибка подключения:', err.message);
        reject(err);
      });

      conn.connect(this.sshConfig);
    });
  }

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