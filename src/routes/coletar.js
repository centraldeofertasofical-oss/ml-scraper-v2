const express = require('express');
const router = express.Router();
const { executarColeta } = require('../scrapers/orquestrador');
const { getCookie } = require('../utils/redis');
const { PERFIS } = require('../config/settings');
const { log } = require('../utils/logger');

// GET /coletar — coleta completa com perfil automático + afiliado
router.get('/', async (req, res) => {
  log(`GET /coletar recebido`);
  try {
    const dry = req.query.dry === 'true';
    const semAfiliado = req.query.afiliado === 'false';
    const perfilId = req.query.perfil ? parseInt(req.query.perfil) - 1 : null;

    const resultado = await executarColeta({
      gerarAfiliado: !semAfiliado,
      dry,
      perfilForçado: perfilId,
    });
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /coletar/rapido — sem afiliado, sem marcar Redis (teste rápido)
router.get('/rapido', async (req, res) => {
  log(`GET /coletar/rapido recebido`);
  try {
    const resultado = await executarColeta({
      gerarAfiliado: false,
      dry: true,
      perfilForçado: 0,
    });
    res.json({ ...resultado, fonte: 'GANHOS_EXTRAS', modo: 'dry_sem_afiliado' });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;