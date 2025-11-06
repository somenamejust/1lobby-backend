const express = require('express');
const router = express.Router();
const cs2MatchMonitor = require('../services/cs2MatchMonitor');

// GSI endpoint для приёма событий от CS2
router.post('/gsi', async (req, res) => {
  try {
    const data = req.body;

    // Проверка токена безопасности
    if (data.auth?.token !== '1lobby_secret_token_12345') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Логируем события раундов
    if (data.round?.phase) {
      console.log(`[CS2 GSI] Round phase: ${data.round.phase}`);
    }

    // Отслеживаем завершение матча
    if (data.map?.phase === 'gameover') {
      console.log(`[CS2 GSI] 🏁 ИГРА ЗАВЕРШЕНА!`);
      console.log(`[CS2 GSI] CT: ${data.map.team_ct?.score || 0} - T: ${data.map.team_t?.score || 0}`);

      // Определяем победителя
      const ctScore = data.map.team_ct?.score || 0;
      const tScore = data.map.team_t?.score || 0;

      let winner = null;
      if (ctScore > tScore) {
        winner = 'CT';
      } else if (tScore > ctScore) {
        winner = 'T';
      }

      if (winner) {
        // Находим активное лобби для этого сервера
        // (нужно сохранять соответствие сервер -> лобби)
        console.log(`[CS2 GSI] Победитель: ${winner} (${ctScore}:${tScore})`);
        
        // TODO: Вызвать обработку завершения матча
        // cs2MatchMonitor.handleMatchEndFromGSI(lobbyId, winner);
      }
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('[CS2 GSI] Ошибка обработки:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;