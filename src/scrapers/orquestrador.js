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

  const cookie = await getCookie();
  if (!cookie) throw new Error('Cookie ML não encontrado no Redis');

  // Seleciona perfil
  const idx = perfilForçado !== null ? perfilForçado : await getPerfilIndex();
  const perfil = PERFIS[idx % PERFIS.length];
  log(`[PERFIL] Executando Perfil ${perfil.id}: ${perfil.nome}`);

  // Avança índice para próxima execução (exceto dry run)
  if (!dry) await avancarPerfilIndex(PERFIS.length);

  const limite = settings.LIMITE_POR_EXECUCAO;
  const limiteCat = perfil.categorias_extra.length > 0
    ? Math.floor(limite * 0.4)  // 40% de categorias extra
    : 0;
  const limiteGE = limite - limiteCat;

  // 1. Coleta Ganhos Extras
  let brutos = [];
  log(`[COLETA] Buscando ${limiteGE} de Ganhos Extras...`);
  const ge = await coletarGanhosExtras(cookie, limiteGE * 3); // coleta mais para ter margem de filtro
  brutos.push(...ge);

  // 2. Coleta categorias extras do perfil
  if (perfil.categorias_extra.length > 0 && limiteCat > 0) {
    const porCat = Math.ceil(limiteCat / perfil.categorias_extra.length);
    for (const cat of perfil.categorias_extra) {
      log(`[COLETA] Buscando categoria: ${cat}`);
      const items = await coletarCategoria(cookie, cat, porCat * 2);
      brutos.push(...items);
    }
  }

  const totalBrutos = brutos.length;
  log(`[FILTRO] Brutos coletados: ${totalBrutos}`);

  // 3. Remove nulos e deduplicação interna por ID
  brutos = brutos.filter(p => p && p.ID && p.LINK_ORIGINAL);
  const seenIds = new Set();
  brutos = brutos.filter(p => {
    if (seenIds.has(p.ID)) return false;
    seenIds.add(p.ID);
    return true;
  });
  log(`[FILTRO] Após dedup interna: ${brutos.length}`);

  // 4. Filtros globais de qualidade
  brutos = brutos.filter(p => aplicarFiltrosGlobais(p));
  log(`[FILTRO] Após filtros globais: ${brutos.length}`);

  // 5. Filtros específicos do perfil
  brutos = brutos.filter(p => aplicarFiltrosPerfil(p, perfil.filtros));
  log(`[FILTRO] Após filtros perfil: ${brutos.length}`);

  // 6. Filtro Redis 24h (exceto dry)
  let aposRedis = brutos;
  if (!dry) {
    const checks = await Promise.all(brutos.map(p => jaPostado(p.ID)));
    aposRedis = brutos.filter((_, i) => !checks[i]);
    log(`[REDIS] Bloqueados (24h): ${brutos.length - aposRedis.length} | Disponíveis: ${aposRedis.length}`);
  }

  // 7. Limita ao máximo do perfil
  const validos = aposRedis.slice(0, limite);
  log(`[FINAL] Produtos válidos para retorno: ${validos.length}`);

  // 8. Gera links afiliado (shortlink meli.la)
  let finais = validos;
  if (gerarAfiliado && validos.length > 0 && !dry) {
    log(`[AFILIADO] Gerando ${validos.length} shortlinks meli.la...`);
    finais = await processarLoteAfiliado(validos);
  }

  // 9. Marca como postados no Redis (exceto dry)
  if (!dry && finais.length > 0) {
    await Promise.all(
      finais.map(p => marcarPostado(p.ID, settings.DEDUPE_TTL_HORAS))
    );
    log(`[REDIS] ${finais.length} produtos marcados (TTL ${settings.DEDUPE_TTL_HORAS}h)`);
  }

  return {
    ok: true,
    perfil: { id: perfil.id, nome: perfil.nome },
    brutos: totalBrutos,
    apos_dedup: brutos.length,
    apos_filtros: aposRedis.length,
    apos_redis: aposRedis.length,
    validos: finais.length,
    limite_execucao: limite,
    produtos: finais,
  };
}

function aplicarFiltrosGlobais(p) {
  if (FILTROS_GLOBAIS.EXIGE_IMAGEM && !p.LINK_IMAGEM) return false;
  if (p.PRECO_POR && p.PRECO_POR < FILTROS_GLOBAIS.PRECO_MIN) return false;
  if (p.DESCONTO_PCT !== null && p.DESCONTO_PCT < FILTROS_GLOBAIS.DESCONTO_MIN) return false;
  return true;
}

function aplicarFiltrosPerfil(p, filtros) {
  if (filtros.comissao_min > 0 && p.COMISSAO_PCT < filtros.comissao_min) return false;
  if (filtros.desconto_min > 0 && (p.DESCONTO_PCT === null || p.DESCONTO_PCT < filtros.desconto_min)) return false;
  return true;
}

module.exports = { executarColeta };