// src/routes/coletar.js
import express from 'express';
import { executarColeta, executarColetaRapida } from '../scrapers/orquestrador.js';
import { logError, logInfo } from '../utils/logger.js';

const router = express.Router();

// POST /coletar — coleta completa (n8n chama isso)
// Body opcional: { incluirCategorias: true, gerarAfiliado: true, marcarRedis: true }
router.post('/', async (req, res) => {
  try {
    const {
      incluirCategorias = true,
      gerarAfiliado = true,
      marcarRedis = true,
    } = req.body || {};

    logInfo('POST /coletar recebido', { incluirCategorias, gerarAfiliado, marcarRedis });

    const resultado = await executarColeta({ incluirCategorias, gerarAfiliado, marcarRedis });
    return res.status(200).json(resultado);

  } catch (err) {
    logError('Erro em POST /coletar', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// GET /coletar — alias GET para facilitar teste manual no browser
router.get('/', async (req, res) => {
  try {
    const incluirCategorias = req.query.categorias !== 'false';
    const gerarAfiliado = req.query.afiliado !== 'false';
    const marcarRedis = req.query.redis !== 'false';
    const dryRun = req.query.dry === 'true';

    logInfo('GET /coletar recebido', { incluirCategorias, gerarAfiliado, marcarRedis, dryRun });

    const resultado = await executarColeta({ incluirCategorias, gerarAfiliado, marcarRedis, dryRun });
    return res.status(200).json(resultado);

  } catch (err) {
    logError('Erro em GET /coletar', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// GET /coletar/rapido — só ganhos extras, sem afiliado (teste rápido)
router.get('/rapido', async (req, res) => {
  try {
    logInfo('GET /coletar/rapido recebido');
    const resultado = await executarColetaRapida();
    return res.status(200).json(resultado);
  } catch (err) {
    logError('Erro em GET /coletar/rapido', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

export default router;
