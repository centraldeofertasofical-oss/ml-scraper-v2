/**
 * status.js — Rotas de status e monitoramento
 */

const express = require('express');
const router  = express.Router();

const { getCookie, getPerfilIndex, getTodosScoresCategorias } = require('../utils/redis');
const { buscarTendenciasPelando, CATEGORIA_IDS }              = require('../scrapers/hub');
const { settings, PERFIS }                                    = require('../config/settings');

// GET /status
router.get('/', async (req, res) => {
  try {
    const cookie       = await getCookie();
    const perfilIdx    = await getPerfilIndex();
    const perfilAtual  = PERFIS[perfilIdx % PERFIS.length];
    const perfilProximo = PERFIS[(perfilIdx + 1) % PERFIS.length];

    const scoresCategorias = await getTodosScoresCategorias();
    const scoresOrdenados  = Object.entries(scoresCategorias)
      .sort(([, a], [, b]) => b - a)
      .reduce((acc, [k, v]) => {
        acc[k] = { score: v, nome: CATEGORIA_IDS[k] || k };
        return acc;
      }, {});

    res.json({
      ok:        true,
      servico:   'ml-scraper-v2',
      timestamp: new Date().toISOString(),

      checks: {
        redis:     cookie !== null ? '✅ conectado' : '❌ sem cookie',
        cookie_ml: cookie          ? '✅ presente'  : '❌ ausente',
      },

      config: {
        tag_afiliado:        settings.AFILIADO_TAG,
        limite_por_execucao: settings.LIMITE_POR_EXECUCAO,
        lote_afiliado:       settings.LOTE_AFILIADO,
        dedupe_ttl_horas:    settings.DEDUPE_TTL_HORAS,
        total_perfis:        PERFIS.length,
      },

      rotacao: {
        perfil_index_atual: perfilIdx,
        perfil_atual:       { id: perfilAtual.id,   nome: perfilAtual.nome   },
        proximo_perfil:     { id: perfilProximo.id, nome: perfilProximo.nome },
        todos_perfis:       PERFIS.map(p => ({ id: p.id, nome: p.nome })),
      },

      aprendizado: {
        scores_categorias: scoresOrdenados,
        info: 'Score acumulado por categoria — média móvel 70/30, TTL 7 dias',
      },

      fontes: {
        hub_ganhos_extras: '✅ ativo',
        hub_categorias:    '✅ ativo (priorizado por Pelando)',
        ofertas_relampago: '✅ ativo',
        ofertas_do_dia:    '✅ ativo',
        pelando:           '✅ ativo (tendências de grupos de achadinhos)',
      },

      endpoints: {
        'GET /status':                    'Este status + scores de aprendizado',
        'GET /status/tendencias':         'Tendências ao vivo do Pelando',
        'GET /coletar':                   'Coleta completa (todas as fontes)',
        'GET /coletar?perfil=1':          'Força perfil específico (1-7)',
        'GET /coletar?afiliado=false':    'Sem geração de link afiliado',
        'GET /coletar?dry=true':          'Dry run (sem Redis, sem afiliado)',
        'GET /coletar?ofertas=false':     'Sem página de ofertas',
        'GET /coletar/rapido':            'Ganhos Extras rápido (teste)',
      },

      cookie_preview: cookie ? cookie.substring(0, 60) + '...' : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /status/tendencias — tendências ao vivo do Pelando
router.get('/tendencias', async (req, res) => {
  try {
    const tendencias = await buscarTendenciasPelando();
    res.json({
      ok:        true,
      total:     tendencias.length,
      timestamp: new Date().toISOString(),
      tendencias: tendencias
        .sort((a, b) => b.temperatura - a.temperatura)
        .map(t => ({
          titulo:      t.titulo,
          temperatura: t.temperatura,
          categoriaML: t.categoriaML,
          nomeCategoria: t.categoriaML ? (CATEGORIA_IDS[t.categoriaML] || t.categoriaML) : null,
        })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
