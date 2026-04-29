/**
 * orquestrador.js — Coleta completa integrada
 *
 * Fontes:
 *   1. Hub ML — Keywords por intenção de comprador
 *   2. Hub ML — Ganhos Extras
 *   3. Hub ML — Categorias priorizadas por tendências do Pelando
 *   4. Ofertas Relâmpago
 *   5. Ofertas do Dia
 *
 * Correções importantes:
 *   - Busca como comprador por keywords.
 *   - Reduz aleatoriedade de categorias amplas.
 *   - Mantém geração obrigatória de LINK_AFILIADO.
 *   - Só marca no Redis produtos com LINK_AFILIADO válido.
 *   - Não retorna como final produto sem shortlink quando gerarAfiliado=true.
 *   - Mantém deduplicação por ID.
 *   - Adiciona controle de variedade por família.
 */

const {
  settings,
  FILTROS_GLOBAIS,
  PERFIS,
  KEYWORDS_POR_PERFIL,
} = require('../config/settings');

const {
  coletarGanhosExtras,
  coletarCategoria,
  coletarKeyword,
  getCategoriasPriorizadas,
} = require('./hub');

const { scraparTodasOfertas } = require('./ofertas');
const { processarLoteAfiliado } = require('./afiliado');

const {
  getCookie,
  jaPostado,
  marcarPostado,
  getPerfilIndex,
  avancarPerfilIndex,
  getScoreCategoria,
  atualizarScoreCategoria,
} = require('../utils/redis');

const { log, err } = require('../utils/logger');

function calcularScore(produto, scoresCategorias) {
  let score = 0;

  score += (produto.DESCONTO_PCT || 0) * 1;
  score += (produto.COMISSAO_PCT || 0) * 2;

  if (produto.GANHO_EXTRA) score += 30;
  if (produto.FONTE === 'OFERTAS') score += 15;
  if (produto.ORIGEM && String(produto.ORIGEM).startsWith('KEYWORD_')) score += 22;

  if (produto.DESTAQUE === 'MAIS VENDIDO') score += 25;
  if (produto.DESTAQUE === 'OFERTA DO DIA') score += 20;
  if (produto.DESTAQUE === 'RECOMENDADO') score += 10;

  if (produto.PRECO_POR && produto.PRECO_POR <= 60) score += 8;
  if (produto.PRECO_POR && produto.PRECO_POR <= 120) score += 5;

  const catScore = scoresCategorias[produto.ORIGEM] || 0;
  score += catScore * 0.5;

  return score;
}

function linkAfiliadoValido(p) {
  const link = String(p?.LINK_AFILIADO || '').trim();
  return link.startsWith('https://') || link.startsWith('http://');
}

async function executarColeta(opcoes = {}) {
  const {
    gerarAfiliado = true,
    dry = false,
    perfilForçado = null,
    incluirOfertas = true,
  } = opcoes;

  const cookie = await getCookie();

  if (!cookie) throw new Error('Cookie ML não encontrado no Redis');

  log(`[COOKIE] Cookie lido: ${cookie.substring(0, 40)}...`);

  const idx = perfilForçado !== null ? perfilForçado : await getPerfilIndex();
  const perfil = PERFIS[idx % PERFIS.length];

  log(`[PERFIL] Perfil ${perfil.id}: ${perfil.nome} (idx=${idx})`);

  if (!dry && perfilForçado === null) {
    await avancarPerfilIndex(PERFIS.length);
  }

  const limite = settings.LIMITE_POR_EXECUCAO;
  const keywordsPerfil = KEYWORDS_POR_PERFIL[perfil.id] || [];

  const temKeywords = keywordsPerfil.length > 0;
  const temCatsExtra = perfil.categorias_extra.length > 0;

  const limiteKeyword = temKeywords ? Math.floor(limite * 0.55) : 0;
  const limiteCat = temCatsExtra ? Math.floor(limite * 0.15) : 0;
  const limiteOfertas = incluirOfertas ? Math.floor(limite * 0.10) : 0;
  const limiteGE = limite - limiteKeyword - limiteCat - limiteOfertas;

  log(
    `[LIMITES] Keywords:${limiteKeyword} | GE:${limiteGE} | Categorias:${limiteCat} | Ofertas:${limiteOfertas} | Total:${limite}`
  );

  const scoresCategorias = {};

  try {
    for (const cat of perfil.categorias_extra) {
      scoresCategorias[`CAT_${cat}`] = await getScoreCategoria(cat);
    }

    scoresCategorias.OFERTA_LIGHTNING = await getScoreCategoria('OFERTA_LIGHTNING');
    scoresCategorias.OFERTA_DEAL_OF_THE_DAY = await getScoreCategoria('OFERTA_DEAL_OF_THE_DAY');

    log('[SCORE] Scores históricos carregados:', JSON.stringify(scoresCategorias));
  } catch (e) {
    err('[SCORE] Erro ao carregar scores:', e.message);
  }

  let brutos = [];

  // 1. Busca por intenção de comprador
  if (temKeywords && limiteKeyword > 0) {
    const keywordsRodada = selecionarKeywordsRodada(keywordsPerfil, 10);
    const porKeyword = Math.max(3, Math.ceil((limiteKeyword * 3) / keywordsRodada.length));

    log(`[KEYWORDS] Buscando ${keywordsRodada.length} keywords | limite por keyword: ${porKeyword}`);

    for (const kw of keywordsRodada) {
      try {
        log(`[KEYWORD] Buscando: "${kw}"`);
        const items = await coletarKeyword(cookie, kw, porKeyword);
        brutos.push(...items);
        log(`[KEYWORD] "${kw}": ${items.length} produtos`);
      } catch (e) {
        err(`[KEYWORD] Erro "${kw}":`, e.message);
      }
    }
  }

  // 2. Ganhos Extras
  if (limiteGE > 0) {
    log(`[COLETA] Buscando Ganhos Extras (limite bruto: ${limiteGE * 3})...`);

    try {
      const ge = await coletarGanhosExtras(cookie, limiteGE * 3);
      brutos.push(...ge);
      log(`[COLETA] Ganhos Extras: ${ge.length} produtos`);
    } catch (e) {
      err('[COLETA] Erro Ganhos Extras:', e.message);
    }
  }

  // 3. Categorias de apoio
  if (temCatsExtra && limiteCat > 0) {
    let categoriasOrdenadas = perfil.categorias_extra;

    try {
      categoriasOrdenadas = await getCategoriasPriorizadas(perfil.categorias_extra);
      log(`[TENDENCIAS] Ordem: ${categoriasOrdenadas.join(', ')}`);
    } catch (e) {
      err('[TENDENCIAS] Falha ao priorizar — usando ordem padrão:', e.message);
    }

    const porCat = Math.max(3, Math.ceil((limiteCat * 3) / categoriasOrdenadas.length));

    for (const cat of categoriasOrdenadas) {
      try {
        log(`[COLETA] Categoria: ${cat} (limite: ${porCat})`);
        const items = await coletarCategoria(cookie, cat, porCat);
        brutos.push(...items);
        log(`[COLETA] ${cat}: ${items.length} produtos`);
      } catch (e) {
        err(`[COLETA] Erro categoria ${cat}:`, e.message);
      }
    }
  }

  // 4. Ofertas Relâmpago e Ofertas do Dia
  if (incluirOfertas && limiteOfertas > 0) {
    try {
      log('[COLETA] Buscando Ofertas Relâmpago e Ofertas do Dia...');

      const resultadoOfertas = await scraparTodasOfertas(cookie, {
        pagina: 1,
        maxPaginas: 1,
        apenasOrganicos: true,
      });

      const itensOfertas = [
        ...(resultadoOfertas.lightning?.items || []),
        ...(resultadoOfertas.deal_of_the_day?.items || []),
      ];

      log(`[COLETA] Ofertas coletadas: ${itensOfertas.length} (relâmpago + do dia)`);
      brutos.push(...itensOfertas);
    } catch (e) {
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
      brutos: 0,
      apos_dedup: 0,
      apos_filtros: 0,
      apos_variedade: 0,
      apos_redis: 0,
      validos: 0,
      limite_execucao: limite,
      produtos: [],
    };
  }

  let validos = brutos.filter(p => {
    if (!p || !p.ID || !p.LINK_ORIGINAL) return false;

    const link = String(p.LINK_ORIGINAL || '').trim();

    const dominioOk =
      link.startsWith('https://www.mercadolivre.com.br') ||
      link.startsWith('https://produto.mercadolivre.com.br');

    if (!dominioOk) {
      err(`[FILTRO] Link inválido descartado: ${p.LINK_ORIGINAL}`);
      return false;
    }

    if (link.includes('click1.mercadolivre.com.br') || link.includes('/mclics/clicks/external/')) {
      err(`[FILTRO] Link patrocinado/click descartado: ${p.LINK_ORIGINAL}`);
      return false;
    }

    return true;
  });

  log(`[FILTRO] Após validação de link: ${validos.length}`);

  const seenIds = new Set();

  validos = validos.filter(p => {
    if (seenIds.has(p.ID)) return false;
    seenIds.add(p.ID);
    return true;
  });

  const aposDedup = validos.length;

  log(`[FILTRO] Após dedup interna: ${aposDedup}`);

  validos = validos.filter(p => aplicarFiltrosGlobais(p));

  log(`[FILTRO] Após filtros globais: ${validos.length}`);

  validos = validos.filter(p => aplicarFiltrosPerfil(p, perfil.filtros));

  const aposFiltros = validos.length;

  log(`[FILTRO] Após filtros perfil (${perfil.nome}): ${aposFiltros}`);

  validos = aplicarVariedadePorFamilia(validos, {
    maxPorFamilia: 4,
  });

  const aposVariedade = validos.length;

  log(`[VARIEDADE] Após limite por família: ${aposVariedade}`);

  let aposRedis = validos;

  if (!dry) {
    const checks = await Promise.all(validos.map(p => jaPostado(p.ID)));
    aposRedis = validos.filter((_, i) => !checks[i]);
    log(`[REDIS] Bloqueados: ${validos.length - aposRedis.length} | Disponíveis: ${aposRedis.length}`);
  }

  aposRedis.sort((a, b) => calcularScore(b, scoresCategorias) - calcularScore(a, scoresCategorias));

  log('[SCORE] Produtos ordenados por relevância');

  const finaisSemAfiliado = aposRedis.slice(0, limite);

  log(`[FINAL] Produtos para retorno antes do afiliado: ${finaisSemAfiliado.length}`);

  let finais = finaisSemAfiliado;
  let produtosSemAfiliado = [];

  if (gerarAfiliado && finaisSemAfiliado.length > 0 && !dry) {
    log(`[AFILIADO] Gerando ${finaisSemAfiliado.length} shortlinks...`);

    const processados = await processarLoteAfiliado(finaisSemAfiliado);

    const produtosComAfiliado = processados.filter(linkAfiliadoValido);

    produtosSemAfiliado = processados.filter(p => !linkAfiliadoValido(p));

    log(`[AFILIADO] ${produtosComAfiliado.length}/${processados.length} shortlinks gerados`);

    if (produtosSemAfiliado.length > 0) {
      err(`[AFILIADO] ⚠️ ${produtosSemAfiliado.length} produtos SEM shortlink — não serão marcados como postados`);
    }

    finais = produtosComAfiliado;
  }

  if (!dry && finais.length > 0) {
    await Promise.all(finais.map(p => marcarPostado(p.ID, settings.DEDUPE_TTL_HORAS)));
    log(`[REDIS] ${finais.length} produtos com afiliado marcados (TTL: ${settings.DEDUPE_TTL_HORAS}h)`);
  }

  if (!dry) {
    try {
      const scoresPorCat = {};

      for (const p of finais) {
        if (!p.ORIGEM) continue;

        const catKey = p.ORIGEM.startsWith('CAT_')
          ? p.ORIGEM.replace('CAT_', '')
          : p.ORIGEM;

        scoresPorCat[catKey] = (scoresPorCat[catKey] || 0) + calcularScore(p, scoresCategorias);
      }

      for (const [cat, s] of Object.entries(scoresPorCat)) {
        await atualizarScoreCategoria(cat, s);
      }

      log('[SCORE] Scores atualizados:', JSON.stringify(scoresPorCat));
    } catch (e) {
      err('[SCORE] Erro ao atualizar scores:', e.message);
    }
  }

  return {
    ok: true,
    perfil: { id: perfil.id, nome: perfil.nome },
    brutos: totalBrutos,
    apos_dedup: aposDedup,
    apos_filtros: aposFiltros,
    apos_variedade: aposVariedade,
    apos_redis: aposRedis.length,
    validos: finais.length,
    sem_afiliado: produtosSemAfiliado.length,
    limite_execucao: limite,
    keywords_usadas: keywordsPerfil.length,
    produtos: finais,
  };
}

function aplicarFiltrosGlobais(p) {
  if (FILTROS_GLOBAIS.EXIGE_IMAGEM && !p.LINK_IMAGEM) return false;

  if (
    p.PRECO_POR !== null &&
    p.PRECO_POR !== undefined &&
    p.PRECO_POR < FILTROS_GLOBAIS.PRECO_MIN
  ) {
    return false;
  }

  if (
    p.DESCONTO_PCT !== null &&
    p.DESCONTO_PCT !== undefined &&
    p.DESCONTO_PCT < FILTROS_GLOBAIS.DESCONTO_MIN
  ) {
    return false;
  }

  return true;
}

function aplicarFiltrosPerfil(p, filtros) {
  if (!filtros) return true;

  if (
    filtros.comissao_min > 0 &&
    (p.COMISSAO_PCT === null || p.COMISSAO_PCT < filtros.comissao_min)
  ) {
    return false;
  }

  if (filtros.desconto_min > 0) {
    const desc = p.DESCONTO_PCT;

    if (desc === null || desc === undefined || desc < filtros.desconto_min) {
      return false;
    }
  }

  return true;
}

function selecionarKeywordsRodada(keywords, limite = 10) {
  const lista = [...new Set(keywords || [])];

  if (lista.length <= limite) return lista;

  const dia = new Date().getDate();
  const inicio = dia % lista.length;

  const rotacionadas = [
    ...lista.slice(inicio),
    ...lista.slice(0, inicio),
  ];

  return rotacionadas.slice(0, limite);
}

function aplicarVariedadePorFamilia(produtos, opcoes = {}) {
  const maxPorFamilia = opcoes.maxPorFamilia || 4;
  const contador = {};
  const resultado = [];

  for (const p of produtos) {
    const familia = detectarFamiliaProduto(p.PRODUTO || p.KEYWORD_BUSCA || p.ORIGEM || 'geral');

    p.FAMILIA_OFERTA = familia;

    contador[familia] = contador[familia] || 0;

    if (contador[familia] >= maxPorFamilia) continue;

    contador[familia]++;
    resultado.push(p);
  }

  return resultado;
}

function detectarFamiliaProduto(texto) {
  const t = normalizarTexto(texto);

  const regras = [
    { familia: 'iphone', termos: ['iphone'] },
    { familia: 'celular', termos: ['celular', 'smartphone', 'samsung', 'motorola', 'xiaomi', 'redmi', 'poco'] },
    { familia: 'tenis', termos: ['tenis', 'tênis'] },
    { familia: 'sapato', termos: ['sapato', 'bota', 'sandalia', 'sandália', 'chinelo'] },
    { familia: 'camiseta', termos: ['camiseta', 'camisa', 'polo'] },
    { familia: 'calca', termos: ['calca', 'calça', 'jeans'] },
    { familia: 'moda_intima', termos: ['cueca', 'calcinha', 'meia', 'lingerie'] },
    { familia: 'bolsa_mochila', termos: ['bolsa', 'mochila', 'carteira'] },
    { familia: 'fitness', termos: ['academia', 'fitness', 'dry fit', 'legging', 'short academia'] },
    { familia: 'suplemento', termos: ['creatina', 'whey', 'pre treino', 'pré treino', 'suplemento'] },
    { familia: 'fone', termos: ['fone', 'headphone', 'bluetooth'] },
    { familia: 'smartwatch', termos: ['smartwatch', 'relogio inteligente', 'relógio inteligente'] },
    { familia: 'organizador', termos: ['organizador', 'organizacao', 'organização'] },
    { familia: 'tapete', termos: ['tapete'] },
    { familia: 'cozinha', termos: ['cozinha', 'panela', 'pote', 'escorredor'] },
    { familia: 'cama_banho', termos: ['jogo de cama', 'edredom', 'toalha', 'banheiro'] },
    { familia: 'beleza', termos: ['perfume', 'shampoo', 'hidratante', 'maquiagem', 'skincare'] },
    { familia: 'cabelo', termos: ['secador', 'chapinha', 'escova secadora', 'prancha'] },
    { familia: 'ferramenta', termos: ['furadeira', 'parafusadeira', 'ferramenta', 'trena'] },
    { familia: 'auto', termos: ['carro', 'automotivo', 'pneu', 'calibrador'] },
  ];

  for (const regra of regras) {
    if (regra.termos.some(termo => t.includes(normalizarTexto(termo)))) {
      return regra.familia;
    }
  }

  const primeiraPalavra = t.split(' ').filter(Boolean)[0];

  return primeiraPalavra || 'geral';
}

function normalizarTexto(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { executarColeta };
