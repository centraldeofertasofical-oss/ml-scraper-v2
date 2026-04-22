const express = require('express');
const router = express.Router();
const { getCookie, getPerfilIndex } = require('../utils/redis');
const { settings, PERFIS } = require('../config/settings');

router.get('/', async (req, res) => {
  try {
    const cookie = await getCookie();
    const perfilIdx = await getPerfilIndex();
    const perfilAtual = PERFIS[perfilIdx % PERFIS.length];
    const perfilProximo = PERFIS[(perfilIdx) % PERFIS.length];

    const cookiePreview = cookie
      ? cookie.substring(0, 60) + '...'
      : null;

    res.json({
      ok: true,
      servico: 'ml-scraper-v2',
      timestamp: new Date().toISOString(),
      checks: {
        redis: cookie !== null ? '✅ conectado' : '❌ sem cookie',
        cookie_ml: cookie ? '✅ presente' : '❌ ausente',
      },
      config: {
        tag_afiliado: settings.AFILIADO_TAG,
        limite_por_execucao: settings.LIMITE_POR_EXECUCAO,
        lote_afiliado: settings.LOTE_AFILIADO,
        dedupe_ttl_horas: settings.DEDUPE_TTL_HORAS,
        total_perfis: PERFIS.length,
      },
      rotacao: {
        perfil_index_atual: perfilIdx,
        proximo_perfil: { id: perfilProximo.id, nome: perfilProximo.nome },
        todos_perfis: PERFIS.map(p => ({ id: p.id, nome: p.nome })),
      },
      endpoints: {
        'GET /status': 'Status do serviço',
        'GET /coletar': 'Coleta completa (perfil automático + afiliado shortlink)',
        'GET /coletar?perfil=1': 'Força perfil específico (1-7)',
        'GET /coletar?afiliado=false': 'Sem geração de link afiliado',
        'GET /coletar?dry=true': 'Dry run (sem Redis, sem afiliado)',
        'GET /coletar/rapido': 'Ganhos Extras rápido (teste)',
      },
      cookie_preview: cookiePreview,
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;