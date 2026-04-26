/**
 * server.js — Servidor Express do ml-scraper-v2
 */

const express      = require('express');
const { settings } = require('./config/settings');
const { executarColeta } = require('./scrapers/orquestrador');
const { log, err }       = require('./utils/logger');

const app = express();
app.use(express.json());

// ─── Status ───────────────────────────────────────────────────────────────────
app.use('/status', require('./routes/status'));

// ─── Coleta completa ──────────────────────────────────────────────────────────
app.get('/coletar', async (req, res) => {
  try {
    const perfilParam  = req.query.perfil;
    const perfilForçado = perfilParam !== undefined ? parseInt(perfilParam) - 1 : null;
    const dry          = req.query.dry     === 'true';
    const gerarAfiliado = req.query.afiliado !== 'false';
    const incluirOfertas = req.query.ofertas !== 'false';

    log(`[SERVER] /coletar — perfil:${perfilForçado ?? 'auto'} dry:${dry} afiliado:${gerarAfiliado} ofertas:${incluirOfertas}`);

    const resultado = await executarColeta({
      gerarAfiliado,
      dry,
      perfilForçado,
      incluirOfertas,
    });

    res.json(resultado);
  } catch (e) {
    err('[SERVER] Erro /coletar:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── Coleta rápida (apenas Ganhos Extras — para teste) ────────────────────────
app.get('/coletar/rapido', async (req, res) => {
  try {
    log('[SERVER] /coletar/rapido');
    const resultado = await executarColeta({
      gerarAfiliado:  false,
      dry:            true,
      perfilForçado:  null,
      incluirOfertas: false,
    });
    res.json({ ...resultado, modo: 'rapido_dry' });
  } catch (e) {
    err('[SERVER] Erro /coletar/rapido:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, servico: 'ml-scraper-v2', ts: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(settings.PORT, () => {
  log(`[SERVER] ml-scraper-v2 rodando na porta ${settings.PORT}`);
});

module.exports = app;
