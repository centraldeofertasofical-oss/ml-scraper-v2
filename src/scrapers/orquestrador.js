const { settings, FILTROS_GLOBAIS, PERFIS } = require('../config/settings');
const { coletarGanhosExtras, coletarCategoria } = require('./hub');
const { processarLoteAfiliado } = require('./afiliado');
const { getCookie, jaPostado, marcarPostado, getPerfilIndex, avancarPerfilIndex } = require('../utils/redis');
const { log, err } = require('../utils/logger');

async function executarColeta(opcoes = {}) {
  const {
    gerarAfiliado = true,
    dry = false,
    perfilForçado = null,
  } = opcoes;

  // 1. Lê cookie PRIMEIRO antes de qualquer operação
  const cookie = await getCookie();
  if (!cookie) throw new Error('Cookie ML não encontrado no Redis');
  log(`[COOKIE] Cookie lido: ${cookie.substring(0, 40)}...`);

  // 2. Seleciona perfil
  const idx = perfilForçado !== null ? perfilForçado : await getPerfilIndex();
  const perfil = PERFIS[idx % PERFIS.length];
  log(`[PERFIL] Perfil ${perfil.id}: ${perfil.nome} (idx=${idx})`);

  // 3. Avança índice para PRÓXIMA execução (exceto dry)
  if (!dry && perfilForçado === null) {
    await avancarPerfilIndex(PERFIS.length);
  }

  // 4. Calcula limites por fonte
  const limite = settings.LIMITE_POR_EXECUCAO;
  const temCatsExtra = perfil.categorias_extra.length > 0;
  const limiteCat = temCatsExtra ? Math.floor(limite * 0.4) : 0;
  const limiteGE  = limite - limiteCat;

  log(`[LIMITES] GE:${limiteGE} | Categorias:${limiteCat} | Total:${limite}`);

  // 5. Coleta Ganhos Extras (sempre — base de todos os perfis)
  let brutos = [];
  log(`[COLETA] Buscando Ganhos Extras (limite bruto: ${limiteGE * 3})...`);
  try {
    const ge = await coletarGanhosExtras(cookie, limiteGE * 3);
    brutos.push(...ge);
    log(`[COLETA] Ganhos Extras: ${ge.length} produtos`);
  } catch(e) {
    err('[COLETA] Erro Ganhos Extras:', e.message);
  }

  // 6. Coleta categorias extras do perfil
  if (temCatsExtra && limiteCat > 0) {
    const porCat = Math.ceil((limiteCat * 3) / perfil.categorias_extra.length);
    for (const cat of perfil.categorias_extra) {
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

  const totalBrutos = brutos.length;
  log(`[FILTRO] Total brutos: ${totalBrutos}`);

  if (totalBrutos === 0) {
    log('[AVISO] Nenhum produto coletado — verifique cookie e logs do hub');
    return { ok: true, perfil: { id: perfil.id, nome: perfil.nome }, brutos: 0, apos_dedup: 0, apos_filtros: 0, apos_redis: 0, validos: 0, limite_execucao: limite, produtos: [] };
  }

  // 7. Remove nulos
  let validos = brutos.filter(p => p && p.ID && p.LINK_ORIGINAL);
  log(`[FILTRO] Após remover nulos: ${validos.length}`);

  // 8. Dedup interna por ID
  const seenIds = new Set();
  validos = validos.filter(p => {
    if (seenIds.has(p.ID)) return false;
    seenIds.add(p.ID);
    return true;
  });
  const aposDedup = validos.length;
  log(`[FILTRO] Após dedup interna: ${aposDedup}`);

  // 9. Filtros globais de qualidade
  validos = validos.filter(p => aplicarFiltrosGlobais(p));
  log(`[FILTRO] Após filtros globais: ${validos.length}`);

  // 10. Filtros específicos do perfil
  validos = validos.filter(p => aplicarFiltrosPerfil(p, perfil.filtros));
  const aposFiltros = validos.length;
  log(`[FILTRO] Após filtros perfil (${perfil.nome}): ${aposFiltros}`);

  // 11. Filtro Redis 24h (exceto dry)
  let aposRedis = validos;
  if (!dry) {
    const checks = await Promise.all(validos.map(p => jaPostado(p.ID)));
    aposRedis = validos.filter((_, i) => !checks[i]);
    log(`[REDIS] Bloqueados: ${validos.length - aposRedis.length} | Disponíveis: ${aposRedis.length}`);
  }

  // 12. Limita ao máximo configurado
  const finaisSemAfiliado = aposRedis.slice(0, limite);
  log(`[FINAL] Produtos para retorno: ${finaisSemAfiliado.length}`);

  // 13. Gera shortlinks meli.la (idêntico ao workflow n8n)
  let finais = finaisSemAfiliado;
  if (gerarAfiliado && finaisSemAfiliado.length > 0 && !dry) {
    log(`[AFILIADO] Gerando ${finaisSemAfiliado.length} shortlinks meli.la...`);
    finais = await processarLoteAfiliado(finaisSemAfiliado);
    const comLink = finais.filter(p => p.LINK_AFILIADO).length;
    log(`[AFILIADO] ${comLink}/${finais.length} shortlinks gerados com sucesso`);
  }

  // 14. Marca como vistos no Redis (exceto dry)
  if (!dry && finais.length > 0) {
    await Promise.all(finais.map(p => marcarPostado(p.ID, settings.DEDUPE_TTL_HORAS)));
    log(`[REDIS] ${finais.length} produtos marcados (TTL: ${settings.DEDUPE_TTL_HORAS}h)`);
  }

  return {
    ok: true,
    perfil: { id: perfil.id, nome: perfil.nome },
    brutos: totalBrutos,
    apos_dedup: aposDedup,
    apos_filtros: aposFiltros,
    apos_redis: aposRedis.length,
    validos: finais.length,
    limite_execucao: limite,
    produtos: finais,
  };
}

function aplicarFiltrosGlobais(p) {
  if (FILTROS_GLOBAIS.EXIGE_IMAGEM && !p.LINK_IMAGEM) return false;
  if (p.PRECO_POR !== null && p.PRECO_POR < FILTROS_GLOBAIS.PRECO_MIN) return false;
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