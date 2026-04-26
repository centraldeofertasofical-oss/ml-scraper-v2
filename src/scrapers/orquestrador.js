/**
 * orquestrador.js — Coleta completa integrada
 *
 * Fontes:
 *   1. Hub ML — Ganhos Extras (comissão elevada)
 *   2. Hub ML — Categorias priorizadas por tendências do Pelando
 *   3. Ofertas Relâmpago (página /ofertas?promotion_type=lightning)
 *   4. Ofertas do Dia    (página /ofertas?promotion_type=deal_of_the_day)
 *
 * Sistema de aprendizado:
 *   - Calcula score por produto (desconto + comissão + ganho extra + destaque)
 *   - Acumula score histórico por categoria no Redis (média móvel 70/30, TTL 7d)
 *   - Usa scores para ordenar produtos e priorizar categorias nas próximas execuções
 *   - Pelando garante alinhamento com o que está em alta nos grupos de achadinhos
 */

const { settings, FILTROS_GLOBAIS, PERFIS } = require('../config/settings');
const { coletarGanhosExtras, coletarCategoria, getCategoriasPriorizadas } = require('./hub');
const { scraparTodasOfertas } = require('./ofertas');
const { processarLoteAfiliado } = require('./afiliado');
const {
  getCookie, jaPostado, marcarPostado,
  getPerfilIndex, avancarPerfilIndex,
  getScoreCategoria, atualizarScoreCategoria,
} = require('../utils/redis');
const { log, err } = require('../utils/logger');

// ─── Score de produto (quanto mais alto, mais prioritário) ───────────────────

function calcularScore(produto, scoresCategorias) {
  let score = 0;

  // Desconto: cada % vale 1 ponto
  score += (produto.DESCONTO_PCT || 0) * 1;

  // Comissão: cada % vale 2 pontos
  score += (produto.COMISSAO_PCT || 0) * 2;

  // Ganho extra: bônus fixo de 30
  if (produto.GANHO_EXTRA) score += 30;

  // Produtos de oferta relâmpago têm mais urgência
  if (produto.FONTE === 'OFERTAS') score += 15;

  // Destaques ML
  if (produto.DESTAQUE === 'MAIS VENDIDO')  score += 25;
  if (produto.DESTAQUE === 'OFERTA DO DIA') score += 20;
  if (produto.DESTAQUE === 'RECOMENDADO')   score += 10;

  // Score histórico da categoria (aprendizado acumulado)
  const catScore = scoresCategorias[produto.ORIGEM] || 0;
  score += catScore * 0.5;

  return score;
}

// ─── Execução principal ──────────────────────────────────────────────────────

async function executarColeta(opcoes = {}) {
  const {
    gerarAfiliado   = true,
    dry             = false,
    perfilForçado   = null,
    incluirOfertas  = true,
  } = opcoes;

  // 1. Cookie
  const cookie = await getCookie();
  if (!cookie) throw new Error('Cookie ML não encontrado no Redis');
  log(`[COOKIE] Cookie lido: ${cookie.substring(0, 40)}...`);

  // 2. Perfil
  const idx    = perfilForçado !== null ? perfilForçado : await getPerfilIndex();
  const perfil = PERFIS[idx % PERFIS.length];
  log(`[PERFIL] Perfil ${perfil.id}: ${perfil.nome} (idx=${idx})`);

  if (!dry && perfilForçado === null) {
    await avancarPerfilIndex(PERFIS.length);
  }

  // 3. Limites por fonte
  const limite       = settings.LIMITE_POR_EXECUCAO;
  const temCatsExtra = perfil.categorias_extra.length > 0;
  const limiteCat    = temCatsExtra ? Math.floor(limite * 0.35) : 0;
  const limiteOfertas = incluirOfertas ? Math.floor(limite * 0.25) : 0;
  const limiteGE     = limite - limiteCat - limiteOfertas;

  log(`[LIMITES] GE:${limiteGE} | Categorias:${limiteCat} | Ofertas:${limiteOfertas} | Total:${limite}`);

  // 4. Carrega scores históricos das categorias
  const scoresCategorias = {};
  try {
    for (const cat of perfil.categorias_extra) {
      scoresCategorias[`CAT_${cat}`] = await getScoreCategoria(cat);
    }
    // Scores das origens de ofertas
    scoresCategorias['OFERTA_LIGHTNING']       = await getScoreCategoria('OFERTA_LIGHTNING');
    scoresCategorias['OFERTA_DEAL_OF_THE_DAY'] = await getScoreCategoria('OFERTA_DEAL_OF_THE_DAY');
    log('[SCORE] Scores históricos carregados:', JSON.stringify(scoresCategorias));
  } catch(e) {
    err('[SCORE] Erro ao carregar scores:', e.message);
  }

  let brutos = [];

  // 5. Ganhos Extras (Hub ML)
  log(`[COLETA] Buscando Ganhos Extras (limite bruto: ${limiteGE * 3})...`);
  try {
    const ge = await coletarGanhosExtras(cookie, limiteGE * 3);
    brutos.push(...ge);
    log(`[COLETA] Ganhos Extras: ${ge.length} produtos`);
  } catch(e) {
    err('[COLETA] Erro Ganhos Extras:', e.message);
  }

  // 6. Categorias (priorizadas pelo Pelando)
  if (temCatsExtra && limiteCat > 0) {
    let categoriasOrdenadas = perfil.categorias_extra;
    try {
      categoriasOrdenadas = await getCategoriasPriorizadas(perfil.categorias_extra);
      log(`[TENDENCIAS] Ordem: ${categoriasOrdenadas.join(', ')}`);
    } catch(e) {
      err('[TENDENCIAS] Falha ao priorizar — usando ordem padrão:', e.message);
    }

    const porCat = Math.ceil((limiteCat * 3) / categoriasOrdenadas.length);
    for (const cat of categoriasOrdenadas) {
      try {
        log(`[COLETA] Categoria: ${cat} (limite: ${porCat})`);
        const items = await coletarCategoria(cookie, cat, porCat);
        brutos.push(...items);
        log(`[COLETA] ${cat}: ${items.length} produtos`);
      } catch(e) {
        err(`[COLETA] Erro categoria ${cat}:`, e.message);
      }
    }
  }

  // 7. Página de Ofertas (Relâmpago + Do Dia)
  if (incluirOfertas && limiteOfertas > 0) {
    try {
      log(`[COLETA] Buscando Ofertas Relâmpago e Ofertas do Dia...`);
      const resultadoOfertas = await scraparTodasOfertas(cookie, {
        pagina: 1,
        maxPaginas: 1,
        apenasOrganicos: true,
      });

      const itensOfertas = [
        ...(resultadoOfertas.lightning?.items       || []),
        ...(resultadoOfertas.deal_of_the_day?.items || []),
      ];

      log(`[COLETA] Ofertas coletadas: ${itensOfertas.length} (relâmpago + do dia)`);
      brutos.push(...itensOfertas);
    } catch(e) {
      err('[COLETA] Erro ao coletar ofertas:', e.message);
    }
  }

  const totalBrutos = brutos.length;
  log(`[FILTRO] Total brutos: ${totalBrutos}`);

  if (totalBrutos === 0) {
    log('[AVISO] Nenhum produto coletado — verifique cookie e logs');
    return {
      ok: true,
      perfil: { id: perfil.id, nome: perfil.nome },
      brutos: 0, apos_dedup: 0, apos_filtros: 0, apos_redis: 0, validos: 0,
      limite_execucao: limite,
      produtos: [],
    };
  }

  // 8. Valida domínio do LINK_ORIGINAL (garante rastreamento)
  let validos = brutos.filter(p => {
    if (!p || !p.ID || !p.LINK_ORIGINAL) return false;
    if (!p.LINK_ORIGINAL.startsWith('https://www.mercadolivre.com.br')) {
      err(`[FILTRO] Link inválido descartado: ${p.LINK_ORIGINAL}`);
      return false;
    }
    return true;
  });
  log(`[FILTRO] Após validação de link: ${validos.length}`);

  // 9. Dedup interna por ID
  const seenIds = new Set();
  validos = validos.filter(p => {
    if (seenIds.has(p.ID)) return false;
    seenIds.add(p.ID);
    return true;
  });
  const aposDedup = validos.length;
  log(`[FILTRO] Após dedup interna: ${aposDedup}`);

  // 10. Filtros globais de qualidade
  validos = validos.filter(p => aplicarFiltrosGlobais(p));
  log(`[FILTRO] Após filtros globais: ${validos.length}`);

  // 11. Filtros do perfil
  validos = validos.filter(p => aplicarFiltrosPerfil(p, perfil.filtros));
  const aposFiltros = validos.length;
  log(`[FILTRO] Após filtros perfil (${perfil.nome}): ${aposFiltros}`);

  // 12. Filtro Redis (dedup 24h)
  let aposRedis = validos;
  if (!dry) {
    const checks = await Promise.all(validos.map(p => jaPostado(p.ID)));
    aposRedis    = validos.filter((_, i) => !checks[i]);
    log(`[REDIS] Bloqueados: ${validos.length - aposRedis.length} | Disponíveis: ${aposRedis.length}`);
  }

  // 13. Ordena por score (aprendizado acumulado + métricas do produto)
  aposRedis.sort((a, b) => calcularScore(b, scoresCategorias) - calcularScore(a, scoresCategorias));
  log('[SCORE] Produtos ordenados por relevância');

  // 14. Limita ao máximo
  const finaisSemAfiliado = aposRedis.slice(0, limite);
  log(`[FINAL] Produtos para retorno: ${finaisSemAfiliado.length}`);

  // 15. Gera shortlinks meli.la
  let finais = finaisSemAfiliado;
  if (gerarAfiliado && finaisSemAfiliado.length > 0 && !dry) {
    log(`[AFILIADO] Gerando ${finaisSemAfiliado.length} shortlinks...`);
    finais = await processarLoteAfiliado(finaisSemAfiliado);
    const comLink = finais.filter(p => p.LINK_AFILIADO).length;
    const semLink = finais.length - comLink;
    log(`[AFILIADO] ${comLink}/${finais.length} shortlinks gerados`);
    if (semLink > 0) err(`[AFILIADO] ⚠️ ${semLink} produtos SEM shortlink`);
  }

  // 16. Marca no Redis
  if (!dry && finais.length > 0) {
    await Promise.all(finais.map(p => marcarPostado(p.ID, settings.DEDUPE_TTL_HORAS)));
    log(`[REDIS] ${finais.length} produtos marcados (TTL: ${settings.DEDUPE_TTL_HORAS}h)`);
  }

  // 17. Atualiza scores das categorias (aprendizado)
  // Categorias que trouxeram produtos com score alto ganham mais peso na próxima execução
  if (!dry) {
    try {
      const scoresPorCat = {};
      for (const p of finais) {
        if (!p.ORIGEM) continue;
        const catKey = p.ORIGEM.startsWith('CAT_')
          ? p.ORIGEM.replace('CAT_', '')
          : p.ORIGEM; // OFERTA_LIGHTNING, OFERTA_DEAL_OF_THE_DAY, GANHOS_EXTRAS
        scoresPorCat[catKey] = (scoresPorCat[catKey] || 0) + calcularScore(p, scoresCategorias);
      }
      for (const [cat, s] of Object.entries(scoresPorCat)) {
        await atualizarScoreCategoria(cat, s);
      }
      log('[SCORE] Scores atualizados:', JSON.stringify(scoresPorCat));
    } catch(e) {
      err('[SCORE] Erro ao atualizar scores:', e.message);
    }
  }

  return {
    ok:              true,
    perfil:          { id: perfil.id, nome: perfil.nome },
    brutos:          totalBrutos,
    apos_dedup:      aposDedup,
    apos_filtros:    aposFiltros,
    apos_redis:      aposRedis.length,
    validos:         finais.length,
    limite_execucao: limite,
    produtos:        finais,
  };
}

// ─── Filtros ─────────────────────────────────────────────────────────────────

function aplicarFiltrosGlobais(p) {
  if (FILTROS_GLOBAIS.EXIGE_IMAGEM && !p.LINK_IMAGEM) return false;
  if (p.PRECO_POR !== null && p.PRECO_POR !== undefined && p.PRECO_POR < FILTROS_GLOBAIS.PRECO_MIN) return false;
  if (p.DESCONTO_PCT !== null && p.DESCONTO_PCT !== undefined && p.DESCONTO_PCT < FILTROS_GLOBAIS.DESCONTO_MIN) return false;
  return true;
}

function aplicarFiltrosPerfil(p, filtros) {
  if (filtros.comissao_min > 0 && (p.COMISSAO_PCT === null || p.COMISSAO_PCT < filtros.comissao_min)) return false;
  if (filtros.desconto_min > 0) {
    const desc = p.DESCONTO_PCT;
    if (desc === null || desc === undefined || desc < filtros.desconto_min) return false;
  }
  return true;
}

module.exports = { executarColeta };
