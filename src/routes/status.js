// src/routes/status.js
import express from 'express';
import { pingRedis, getCookie } from '../utils/redis.js';
import { settings } from '../config/settings.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const redis = await pingRedis();

  let cookieOk = false;
  let cookiePreview = null;

  try {
    const cookie = await getCookie();
    cookieOk = !!cookie && cookie.length > 10;
    // Mostra só os primeiros 80 chars para não expor tudo
    cookiePreview = cookie ? cookie.substring(0, 80) + '...' : null;
  } catch {
    cookieOk = false;
  }

  const tudo_ok = redis && cookieOk;

  return res.status(tudo_ok ? 200 : 503).json({
    ok: tudo_ok,
    servico: 'ml-scraper-v2',
    timestamp: new Date().toISOString(),
    checks: {
      redis: redis ? '✅ conectado' : '❌ falhou',
      cookie_ml: cookieOk ? '✅ presente' : '❌ ausente ou vazio',
    },
    cookie_preview: cookiePreview,
    config: {
      tag_afiliado: settings.afiliadoTag,
      page_size: settings.pageSize,
      max_pages_por_fonte: settings.maxPagesPerFonte,
      lote_afiliado: settings.afiliadoLoteSize,
      dedupe_ttl_horas: settings.dedupeTTL / 3600,
      total_categorias: settings.categorias.length,
    },
    endpoints: {
      'GET  /status': 'Status do serviço',
      'GET  /coletar': 'Coleta completa (ganhos extras + categorias + afiliado)',
      'GET  /coletar?categorias=false': 'Só ganhos extras',
      'GET  /coletar?afiliado=false': 'Sem geração de link afiliado',
      'GET  /coletar?dry=true': 'Dry run (sem Redis, sem afiliado)',
      'GET  /coletar/rapido': 'Só ganhos extras, sem afiliado (teste rápido)',
      'POST /coletar': 'Coleta completa via body JSON',
    },
    proximo_passo: tudo_ok
      ? 'Serviço pronto. Use GET /coletar/rapido para testar.'
      : 'Verifique REDIS_URL e o cookie "cookies-mercadolivre" no Redis.',
  });
});

export default router;
