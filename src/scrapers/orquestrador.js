/**
 * orquestrador.js — ML Scraper V4
 *
 * Melhorias V4:
 * - Keywords são a fonte principal.
 * - Aprendizado automático por keyword no Redis.
 * - Keywords com melhor histórico sobem na prioridade.
 * - Categorias ficam só como apoio.
 * - Bloqueio temporário por família de produto.
 * - Filtro contra produtos 110V/127V puro.
 * - Mantém geração de afiliado, Redis, dedupe e score.
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
  jaPostouFamilia,
  marcarFamiliaPostada,
  getPerfilIndex,
  avancarPerfilIndex,
  getScoreCategoria,
  atualizarScoreCategoria,
  getScoreKeyword,
  atualizarScoreKeyword,
  getTodosScoresKeywords,
} = require('../utils/redis');

const { log, err } = require('../utils/logger');

function calcularScore(produto, scoresCategorias = {}, scoresKeywords = {}) {
  let score = 0;

  score += (produto.DESCONTO_PCT || 0) * 1;
  score += (produto.COMISSAO_PCT || 0) * 2;

  if (produto.GANHO_EXTRA) score += 30;
  if (produto.FONTE === 'OFERTAS') score += 15;

  if (produto.ORIGEM && String(produto.ORIGEM).startsWith('KEYWORD_')) score += 35;
  if (produto.KEYWORD_BUSCA) score += 15;

  if (produto.DESTAQUE === 'MAIS VENDIDO') score += 25;
  if (produto.DESTAQUE === 'OFERTA DO DIA') score += 20;
  if (produto.DESTAQUE === 'RECOMENDADO') score += 10;

  if (produto.PRECO_POR && produto.PRECO_POR <= 60) score += 10;
  else if (produto.PRECO_POR && produto.PRECO_POR <= 120) score += 7;
  else if (produto.PRECO_POR && produto.PRECO_POR <= 250) score += 4;

  const catScore = scoresCategorias[produto.ORIGEM] || 0;
  score += catScore * 0.5;

  if (produto.KEYWORD_BUSCA) {
    const kwKey = normalizarKeywordScoreKey(produto.KEYWORD_BUSCA);
    const kwScore = scoresKeywords[kwKey] || 0;
    score += kwScore * 0.25;
  }

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

  const limiteKeyword = temKeywords ? Math.floor(limite * 0.78) : 0;
  const limiteCat = temCatsExtra ? Math.floor(limite * 0.05) : 0;
  const limiteOfertas = incluirOfertas ? Math.floor(limite * 0.07) : 0;
  const limiteGE = Math.max(0, limite - limiteKeyword - limiteCat - limiteOfertas);

  log(
    `[LIMITES V4] Keywords:${limiteKeyword} | GE:${limiteGE} | Categorias:${limiteCat} | Ofertas:${limiteOfertas} | Total:${limite}`
  );

  const scoresCategorias = {};
  let scoresKeywords = {};

  try {
    for (const cat of perfil.categorias_extra) {
      scoresCategorias[`CAT_${cat}`] = await getScoreCategoria(cat);
    }

    scoresCategorias.OFERTA_LIGHTNING = await getScoreCategoria('OFERTA_LIGHTNING');
    scoresCategorias.OFERTA_DEAL_OF_THE_DAY = await getScoreCategoria('OFERTA_DEAL_OF_THE_DAY');

    scoresKeywords = await getTodosScoresKeywords();

    log('[SCORE] Scores categorias carregados:', JSON.stringify(scoresCategorias));
    log('[SCORE] Scores keywords carregados:', JSON.stringify(scoresKeywords));
  } catch (e) {
    err('[SCORE] Erro ao carregar scores:', e.message);
  }

  let brutos = [];

  // 1. Keywords — fonte principal V4
  if (temKeywords && limiteKeyword > 0) {
    const keywordsRodada = selecionarKeywordsRodadaV4(keywordsPerfil, scoresKeywords, 14);
    const porKeyword = Math.max(5, Math.ceil(limiteKeyword / keywordsRodada.length));

    log(`[KEYWORDS V4] Buscando ${keywordsRodada.length} keywords | limite por keyword: ${porKeyword}`);
    log(`[KEYWORDS V4] Rodada: ${keywordsRodada.join(' | ')}`);

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

  // 2. Ganhos Extras — apoio
  if (limiteGE > 0) {
    log(`[COLETA] Buscando Ganhos Extras (limite bruto: ${limiteGE})...`);

    try {
      const ge = await coletarGanhosExtras(cookie, limiteGE);
      brutos.push(...ge);
      log(`[COLETA] Ganhos Extras: ${ge.length} produtos`);
    } catch (e) {
      err('[COLETA] Erro Ganhos Extras:', e.message);
    }
  }

  // 3. Categorias — apoio mínimo
  if (temCatsExtra && limiteCat > 0) {
    let categoriasOrdenadas = perfil.categorias_extra;

    try {
      categoriasOrdenadas = await getCategoriasPriorizadas(perfil.categorias_extra);
      log(`[TENDENCIAS] Ordem: ${categoriasOrdenadas.join(', ')}`);
    } catch (e) {
      err('[TENDENCIAS] Falha ao priorizar — usando ordem padrão:', e.message);
    }

    const porCat = Math.max(2, Math.ceil(limiteCat / categoriasOrdenadas.length));

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

  // 4. Ofertas
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
      brutos.push(...itensOfertas.slice(0, limiteOfertas));
    } catch (e) {
      err('[COLETA] Erro ao coletar ofertas:', e.message);
    }
  }

  const totalBrutos = brutos.length;

  log(`[FILTRO] Total brutos: ${totalBrutos}`);

  if (totalBrutos === 0) {
    return {
      ok: true,
      perfil: { id: perfil.id, nome: perfil.nome },
      brutos: 0,
      apos_dedup: 0,
      apos_filtros: 0,
      apos_variedade: 0,
      apos_redis: 0,
      validos: 0,
      sem_afiliado: 0,
      limite_execucao: limite,
      keywords_usadas: keywordsPerfil.length,
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

  log(`[FILTRO] Após filtros globais + voltagem: ${validos.length}`);

  validos = validos.filter(p => aplicarFiltrosPerfil(p, perfil.filtros));

  const aposFiltros = validos.length;

  log(`[FILTRO] Após filtros perfil (${perfil.nome}): ${aposFiltros}`);

  validos = aplicarVariedadePorFamilia(validos, {
    maxPorFamilia: 3,
  });

  const aposVariedade = validos.length;

  log(`[VARIEDADE] Após limite por família na rodada: ${aposVariedade}`);

  let aposRedis = validos;

  if (!dry) {
    const checksProduto = await Promise.all(validos.map(p => jaPostado(p.ID)));

    aposRedis = validos.filter((p, i) => {
      if (checksProduto[i]) return false;
      return true;
    });

    const antesFamilia = aposRedis.length;

    aposRedis = await filtrarFamiliasRecentes(aposRedis, {
      maxPermitidosFamiliaRecente: 1,
    });

    log(`[REDIS] Bloqueados por produto: ${validos.length - aposRedis.length}`);
    log(`[REDIS] Filtro família recente aplicado: ${antesFamilia} → ${aposRedis.length}`);
  }

  aposRedis.sort((a, b) => calcularScore(b, scoresCategorias, scoresKeywords) - calcularScore(a, scoresCategorias, scoresKeywords));

  log('[SCORE] Produtos ordenados por relevância V4');

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

    const familias = [...new Set(finais.map(p => p.FAMILIA_OFERTA).filter(Boolean))];

    await Promise.all(familias.map(f => marcarFamiliaPostada(f, 6)));

    log(`[REDIS] ${finais.length} produtos marcados (TTL produto: ${settings.DEDUPE_TTL_HORAS}h)`);
    log(`[REDIS] Famílias marcadas por 6h: ${familias.join(', ')}`);
  }

  if (!dry) {
    await atualizarAprendizadoV4(finais, scoresCategorias, scoresKeywords);
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

  if (!produtoVoltagemValida(p)) return false;

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

function produtoVoltagemValida(p) {
  const nome = normalizarTexto(p.PRODUTO || '');

  const temBivolt =
    nome.includes('bivolt') ||
    nome.includes('127 220') ||
    nome.includes('110 220') ||
    nome.includes('127v 220v') ||
    nome.includes('110v 220v') ||
    nome.includes('127 220v') ||
    nome.includes('110 220v');

  if (temBivolt) return true;

  const tem220 = /\b220\s*v\b/.test(nome);
  if (tem220) return true;

  const tem110ou127 =
    /\b110\s*v\b/.test(nome) ||
    /\b127\s*v\b/.test(nome);

  if (tem110ou127) return false;

  return true;
}

function selecionarKeywordsRodadaV4(keywords, scoresKeywords, limite = 14) {
  const lista = [...new Set(keywords || [])];

  if (lista.length <= limite) return lista;

  const comScore = lista.map(kw => {
    const key = normalizarKeywordScoreKey(kw);
    return {
      kw,
      score: scoresKeywords[key] || 0,
    };
  });

  const topAprendidas = comScore
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(i => i.kw);

  const restantes = lista.filter(kw => !topAprendidas.includes(kw));

  const agora = new Date();
  const dia = agora.getDate();
  const hora = agora.getHours();
  const inicio = restantes.length ? (dia + hora) % restantes.length : 0;

  const rotacionadas = [
    ...restantes.slice(inicio),
    ...restantes.slice(0, inicio),
  ];

  return [...topAprendidas, ...rotacionadas].slice(0, limite);
}

function aplicarVariedadePorFamilia(produtos, opcoes = {}) {
  const maxPorFamilia = opcoes.maxPorFamilia || 3;
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

async function filtrarFamiliasRecentes(produtos, opcoes = {}) {
  const maxPermitidosFamiliaRecente = opcoes.maxPermitidosFamiliaRecente || 1;
  const contadorFamiliaRecente = {};
  const resultado = [];

  for (const p of produtos) {
    const familia = p.FAMILIA_OFERTA || detectarFamiliaProduto(p.PRODUTO || '');
    p.FAMILIA_OFERTA = familia;

    const recente = await jaPostouFamilia(familia);

    if (!recente) {
      resultado.push(p);
      continue;
    }

    contadorFamiliaRecente[familia] = contadorFamiliaRecente[familia] || 0;

    if (contadorFamiliaRecente[familia] < maxPermitidosFamiliaRecente) {
      contadorFamiliaRecente[familia]++;
      resultado.push(p);
    }
  }

  return resultado;
}

async function atualizarAprendizadoV4(finais, scoresCategorias, scoresKeywords) {
  try {
    const scoresPorCat = {};
    const scoresPorKeyword = {};

    for (const p of finais) {
      const scoreProduto = calcularScore(p, scoresCategorias, scoresKeywords);

      if (p.ORIGEM) {
        const catKey = p.ORIGEM.startsWith('CAT_')
          ? p.ORIGEM.replace('CAT_', '')
          : p.ORIGEM;

        scoresPorCat[catKey] = (scoresPorCat[catKey] || 0) + scoreProduto;
      }

      if (p.KEYWORD_BUSCA) {
        scoresPorKeyword[p.KEYWORD_BUSCA] = (scoresPorKeyword[p.KEYWORD_BUSCA] || 0) + scoreProduto;
      }
    }

    for (const [cat, s] of Object.entries(scoresPorCat)) {
      await atualizarScoreCategoria(cat, s);
    }

    for (const [kw, s] of Object.entries(scoresPorKeyword)) {
      await atualizarScoreKeyword(kw, s);
    }

    log('[SCORE V4] Categorias atualizadas:', JSON.stringify(scoresPorCat));
    log('[SCORE V4] Keywords atualizadas:', JSON.stringify(scoresPorKeyword));
  } catch (e) {
    err('[SCORE V4] Erro ao atualizar aprendizado:', e.message);
  }
}

function detectarFamiliaProduto(texto) {
  const t = normalizarTexto(texto);

  const regras = [
    { familia: 'iphone', termos: ['iphone'] },
    { familia: 'celular', termos: ['celular', 'smartphone', 'samsung', 'motorola', 'xiaomi', 'redmi', 'poco'] },
    { familia: 'tenis', termos: ['tenis', 'tênis'] },
    { familia: 'sapato', termos: ['sapato', 'bota', 'sandalia', 'sandália', 'chinelo', 'sapateira'] },
    { familia: 'camiseta', termos: ['camiseta', 'camisa', 'polo'] },
    { familia: 'calca', termos: ['calca', 'calça', 'jeans'] },
    { familia: 'moda_intima', termos: ['cueca', 'calcinha', 'meia', 'lingerie', 'sutia', 'sutiã'] },
    { familia: 'bolsa_mochila', termos: ['bolsa', 'mochila', 'carteira'] },
    { familia: 'fitness', termos: ['academia', 'fitness', 'dry fit', 'legging', 'short academia'] },
    { familia: 'suplemento', termos: ['creatina', 'whey', 'pre treino', 'pré treino', 'suplemento'] },
    { familia: 'fone', termos: ['fone', 'headphone', 'bluetooth', 'caixa de som'] },
    { familia: 'smartwatch', termos: ['smartwatch', 'relogio inteligente', 'relógio inteligente'] },
    { familia: 'organizador', termos: ['organizador', 'organizacao', 'organização'] },
    { familia: 'tapete', termos: ['tapete'] },
    { familia: 'garrafa_copo', termos: ['garrafa', 'copo termico', 'copo térmico', 'squeeze', 'cuia'] },
    { familia: 'cozinha', termos: ['cozinha', 'panela', 'pote', 'escorredor', 'air fryer', 'fritadeira', 'torradeira', 'sanduicheira', 'processador', 'chaleira', 'espremedor'] },
    { familia: 'cama_banho', termos: ['jogo de cama', 'edredom', 'coberdrom', 'coberta', 'toalha', 'banheiro', 'lencol', 'lençol'] },
    { familia: 'beleza', termos: ['perfume', 'body splash', 'shampoo', 'hidratante', 'maquiagem', 'skincare'] },
    { familia: 'cabelo', termos: ['secador', 'chapinha', 'escova secadora', 'prancha'] },
    { familia: 'ferramenta', termos: ['furadeira', 'parafusadeira', 'ferramenta', 'trena', 'esmerilhadeira', 'solda'] },
    { familia: 'auto', termos: ['carro', 'automotivo', 'pneu', 'calibrador'] },
    { familia: 'ventilador', termos: ['ventilador'] },
    { familia: 'eletro_220v', termos: ['220v', '127 220v', '110 220v', 'bivolt'] },
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

function normalizarKeywordScoreKey(keyword) {
  return String(keyword || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

module.exports = { executarColeta };
