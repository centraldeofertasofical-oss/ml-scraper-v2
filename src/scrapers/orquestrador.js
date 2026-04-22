// src/scrapers/orquestrador.js
import { coletarTudo, coletarGanhosExtras } from './hub.js';
import { gerarLinksAfiliado } from './afiliado.js';
import { jaPostado, marcarPostadoLote } from '../utils/redis.js';
import { logInfo, logError } from '../utils/logger.js';

// Deduplica por ID dentro da própria coleta
function deduplicarInternamente(produtos = []) {
  const seen = new Map();
  for (const p of produtos) {
    const key = p.ID;
    if (!key || seen.has(key)) continue;
    seen.set(key, p);
  }
  return Array.from(seen.values());
}

// Filtra produtos já postados nas últimas 24h (Redis)
async function filtrarJaPostados(produtos = []) {
  const novos = [];
  for (const p of produtos) {
    const bloqueado = await jaPostado(p.ID);
    if (!bloqueado) novos.push(p);
  }
  return novos;
}

// Filtra qualidade mínima
function filtrarQualidade(produtos = []) {
  return produtos.filter(p =>
    p.PRODUTO &&
    p.LINK_ORIGINAL &&
    p.PRECO_POR &&
    p.PRECO_POR > 0 &&
    p.PRECO_POR < 10000
  );
}

// ─── Coleta completa orquestrada ──────────────────────────────────────────────

export async function executarColeta({ 
  incluirCategorias = true,
  gerarAfiliado = true,
  marcarRedis = true,
  dryRun = false,
} = {}) {

  const inicio = Date.now();
  logInfo('=== INICIANDO COLETA COMPLETA ===');

  const resultado = {
    ok: true,
    inicio: new Date().toISOString(),
    fim: null,
    duracao_segundos: null,
    fontes: [],
    stats: {
      brutos: 0,
      apos_dedup_interna: 0,
      apos_filtro_redis: 0,
      apos_filtro_qualidade: 0,
      com_link_afiliado: 0,
      sem_link_afiliado: 0,
    },
    produtos: [],
  };

  try {
    // 1. COLETA
    logInfo('ETAPA 1: Coleta do Hub de Afiliados');
    const { fontes, produtos_brutos } = await coletarTudo({ incluirCategorias });
    resultado.fontes = fontes;
    resultado.stats.brutos = produtos_brutos.length;
    logInfo(`Coleta concluída: ${produtos_brutos.length} produtos brutos`);

    // 2. DEDUP INTERNA
    logInfo('ETAPA 2: Deduplicação interna por ID');
    const deduped = deduplicarInternamente(produtos_brutos);
    resultado.stats.apos_dedup_interna = deduped.length;
    logInfo(`Após dedup interna: ${deduped.length} produtos únicos`);

    // 3. FILTRO REDIS (já postados 24h)
    logInfo('ETAPA 3: Filtro Redis 24h');
    const novos = dryRun ? deduped : await filtrarJaPostados(deduped);
    resultado.stats.apos_filtro_redis = novos.length;
    logInfo(`Após filtro Redis: ${novos.length} produtos novos (${deduped.length - novos.length} bloqueados)`);

    // 4. FILTRO DE QUALIDADE
    logInfo('ETAPA 4: Filtro de qualidade');
    const validos = filtrarQualidade(novos);
    resultado.stats.apos_filtro_qualidade = validos.length;
    logInfo(`Após filtro qualidade: ${validos.length} produtos válidos`);

    if (!validos.length) {
      logInfo('Nenhum produto válido para processar');
      resultado.produtos = [];
      resultado.stats.com_link_afiliado = 0;
      resultado.stats.sem_link_afiliado = 0;
    } else {
      // 5. GERAÇÃO DE LINKS DE AFILIADO
      let produtosFinais = validos;

      if (gerarAfiliado && !dryRun) {
        logInfo('ETAPA 5: Geração de links de afiliado');
        produtosFinais = await gerarLinksAfiliado(validos);
      }

      resultado.stats.com_link_afiliado = produtosFinais.filter(p => p.LINK_AFILIADO).length;
      resultado.stats.sem_link_afiliado = produtosFinais.filter(p => !p.LINK_AFILIADO).length;

      // 6. MARCA NO REDIS (somente os que têm link afiliado)
      if (marcarRedis && !dryRun) {
        logInfo('ETAPA 6: Marcando no Redis');
        const idsParaMarcar = produtosFinais
          .filter(p => p.LINK_AFILIADO)
          .map(p => p.ID);
        await marcarPostadoLote(idsParaMarcar);
        logInfo(`${idsParaMarcar.length} IDs marcados no Redis (TTL 24h)`);
      }

      resultado.produtos = produtosFinais;
    }

  } catch (err) {
    logError('Erro fatal na coleta', err?.message);
    resultado.ok = false;
    resultado.erro = err?.message;
  }

  const fim = Date.now();
  resultado.fim = new Date().toISOString();
  resultado.duracao_segundos = Math.round((fim - inicio) / 1000);
  resultado.total = resultado.produtos.length;

  logInfo('=== COLETA FINALIZADA ===', {
    duracao: `${resultado.duracao_segundos}s`,
    stats: resultado.stats,
  });

  return resultado;
}

// Coleta rápida só de Ganhos Extras (para testes)
export async function executarColetaRapida() {
  logInfo('=== COLETA RÁPIDA: Só Ganhos Extras ===');

  const produtos = await coletarGanhosExtras();
  const deduped = deduplicarInternamente(produtos);
  const novos = await filtrarJaPostados(deduped);
  const validos = filtrarQualidade(novos);

  return {
    ok: true,
    fonte: 'GANHOS_EXTRAS',
    brutos: produtos.length,
    apos_dedup: deduped.length,
    apos_redis: novos.length,
    validos: validos.length,
    produtos: validos,
  };
}
