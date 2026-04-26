/**
 * hub.js — Coleta do Hub ML (Ganhos Extras + Categorias)
 * + Integração Pelando para priorizar categorias em alta nos grupos de achadinhos
 */

const axios = require('axios');
const { settings } = require('../config/settings');
const { log, err } = require('../utils/logger');

const HUB_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/hub/search';

const CATEGORIA_IDS = {
  'MLB1430':  'Calçados, Roupas e Bolsas',
  'MLB1246':  'Beleza e Cuidado Pessoal',
  'MLB1000':  'Eletrônicos, Áudio e Vídeo',
  'MLB1051':  'Celulares e Telefones',
  'MLB1648':  'Informática',
  'MLB5726':  'Eletrodomésticos',
  'MLB1574':  'Casa, Móveis e Decoração',
  'MLB1276':  'Esportes e Fitness',
  'MLB1071':  'Pet Shop',
  'MLB1384':  'Bebês',
  'MLB264586':'Saúde',
  'MLB263532':'Ferramentas',
  'MLB5672':  'Acessórios para Veículos',
  'MLB1132':  'Brinquedos e Hobbies',
};

// Mapa de keywords → categoria ML (para cruzar com títulos do Pelando)
const KEYWORDS_CATEGORIA = {
  'MLB1430':  ['tênis','tenis','sapato','bota','botina','calça','calca','jeans','camiseta','camisa','mochila','bolsa','roupa','vestuário','kit roupa','conjunto'],
  'MLB1246':  ['perfume','desodorante','shampoo','condicionador','creme','hidratante','maquiagem','batom','base','secador','prancha','chapinha','escova'],
  'MLB1051':  ['celular','smartphone','iphone','samsung','motorola','xiaomi','redmi','poco'],
  'MLB1000':  ['smart tv','smarttv','televisão','televisao','monitor','headphone','fone','caixa de som','bluetooth','soundbar'],
  'MLB1648':  ['notebook','pc','computador','ssd','memória','memoria','teclado','mouse','webcam','hd externo'],
  'MLB5726':  ['geladeira','fogão','fogao','microondas','lavadora','máquina de lavar','ventilador','ar condicionado','purificador','fritadeira','airfryer'],
  'MLB1574':  ['cadeira','mesa','sofá','sofa','tapete','organização','organizacao','panela','cozinha','utensílio','utensilios','jogo de cama','edredom'],
  'MLB1276':  ['bicicleta','ergométrica','ergometrica','esteira','haltere','academia','suplemento','proteína','proteina','whey','creatina'],
  'MLB264586':['termômetro','termometro','oxímetro','oximetro','medidor','pressão','pressao','vitamina'],
  'MLB1071':  ['ração','racao','pet','cachorro','gato','coleira','casinha'],
};

const PICTURE_TEMPLATE = 'https://http2.mlstatic.com/D_Q_NP_2X_{id}-O.webp';

// ─── Pelando: busca o que está em alta nos grupos de achadinhos ──────────────

async function buscarTendenciasPelando() {
  try {
    const { data } = await axios.get(
      'https://www.pelando.com.br/api/graphql?operationName=ThreadFeedQuery',
      {
        params: {
          variables:  JSON.stringify({ page: 1, pageSize: 40, orderBy: 'HOTTEST' }),
          extensions: JSON.stringify({
            persistedQuery: {
              version: 1,
              sha256Hash: 'b9cc52b88b3f0eecc62b27e9e4e9e9f574ee3dbcf0c38b84fee83d8efb0e64e7',
            },
          }),
        },
        headers: {
          'accept': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'referer': 'https://www.pelando.com.br/',
        },
        timeout: 10000,
      }
    );

    const threads = data?.data?.threadFeed?.threads || [];

    const tendencias = threads
      .filter(t => t.title && (t.temperature || 0) > 100)
      .map(t => {
        const titulo = (t.title || '').toLowerCase();
        let categoriaML = null;
        for (const [cat, keywords] of Object.entries(KEYWORDS_CATEGORIA)) {
          if (keywords.some(kw => titulo.includes(kw))) {
            categoriaML = cat;
            break;
          }
        }
        return {
          titulo:      t.title,
          temperatura: t.temperature || 0,
          categoriaML,
        };
      });

    log(`[PELANDO] ${tendencias.length} tendências encontradas (temp > 100°)`);
    return tendencias;
  } catch (e) {
    err('[PELANDO] Falha ao buscar tendências:', e.message);
    return [];
  }
}

// Retorna categorias do perfil reordenadas por temperatura do Pelando
// + até 2 categorias bônus que estejam em alta mas fora do perfil
async function getCategoriasPriorizadas(categoriasPadrao) {
  const tendencias = await buscarTendenciasPelando();

  if (!tendencias.length) {
    log('[TENDENCIAS] Sem dados do Pelando — usando categorias padrão');
    return categoriasPadrao;
  }

  const score = {};
  for (const t of tendencias) {
    if (t.categoriaML) {
      score[t.categoriaML] = (score[t.categoriaML] || 0) + t.temperatura;
    }
  }
  log('[TENDENCIAS] Score por categoria:', JSON.stringify(score));

  const ordenadas = [...categoriasPadrao].sort((a, b) => (score[b] || 0) - (score[a] || 0));

  const bonus = Object.keys(score)
    .filter(cat => !categoriasPadrao.includes(cat) && score[cat] > 200)
    .sort((a, b) => score[b] - score[a])
    .slice(0, 2);

  if (bonus.length) log(`[TENDENCIAS] Categorias bônus: ${bonus.join(', ')}`);

  return [...ordenadas, ...bonus];
}

// ─── Coleta do Hub ───────────────────────────────────────────────────────────

async function coletarGanhosExtras(cookie, limite) {
  return coletarHub(cookie, limite, [{ id: 'extra_commission', value: true }], 'GANHOS_EXTRAS');
}

async function coletarCategoria(cookie, categoriaId, limite) {
  return coletarHub(cookie, limite, [{ id: 'category', value: categoriaId }], `CAT_${categoriaId}`);
}

async function coletarHub(cookie, limite, filters, origem) {
  const produtos = [];
  let offset = 0;
  let pagina = 1;
  const maxPags = settings.MAX_PAGES_POR_FONTE;

  while (produtos.length < limite && pagina <= maxPags) {
    try {
      const { data } = await axios.post(
        `${HUB_URL}?is_affiliate=true&device=desktop`,
        { search: '', sort: 'relevance', filters, offset },
        {
          headers: {
            'accept':          'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9',
            'content-type':    'application/json',
            'origin':          'https://www.mercadolivre.com.br',
            'referer':         'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
            'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
            'cookie':          cookie,
          },
          timeout: 20000,
        }
      );

      const polycards = data?.polycard_client_model?.polycards;
      if (!polycards || polycards.length === 0) {
        log(`[${origem}] Pág ${pagina} → sem polycards, parando`);
        break;
      }

      const ctx    = data?.polycard_client_model?.polycard_context;
      const parsed = polycards.map(card => parsePolycard(card, origem, ctx)).filter(Boolean);

      produtos.push(...parsed);
      log(`[${origem}] Pág ${pagina} → offset ${offset} → ${polycards.length} brutos / ${parsed.length} parsed (total: ${produtos.length})`);

      if (produtos.length >= limite) break;
      offset += polycards.length;
      pagina++;
      await sleep(600);

    } catch (e) {
      err(`[${origem}] Erro pág ${pagina}:`, e.response?.status || e.message);
      break;
    }
  }

  return produtos.slice(0, limite);
}

// ─── Parser de polycard ──────────────────────────────────────────────────────

function parsePolycard(card, origem, context) {
  try {
    if (!card || !card.metadata) return null;

    const meta = card.metadata;
    const id   = meta.id || meta.wid || '';
    if (!id) return null;

    // ✅ Link canônico confirmado — ÚNICO formato aceito pelo programa de afiliados
    const idLimpo      = String(id).trim();
    const linkOriginal = `https://www.mercadolivre.com.br/p/${idLimpo}`;

    // Imagem
    const picId      = card?.pictures?.pictures?.[0]?.id || '';
    const picTemplate = context?.picture_template || PICTURE_TEMPLATE;
    const square     = card?.pictures?.square || context?.picture_square_default || 'Q';
    const imagem     = picId
      ? picTemplate
          .replace('{square}', square)
          .replace('{2x}', '2X')
          .replace('{id}', picId)
          .replace('{size}', 'O')
          .replace('{sanitized_title}', card?.pictures?.sanitized_title || '')
      : '';

    // Componentes
    const components = card.components || [];
    const compByType = {};
    for (const c of components) compByType[c.id || c.type] = c;

    const titulo    = compByType['title']?.title?.text || '';
    const priceComp = compByType['price']?.price || {};
    const precoPor  = parseFloat(priceComp?.current_price?.value  || 0) || null;
    const precoDe   = parseFloat(priceComp?.previous_price?.value || 0) || null;
    const desconto  = parseInt(priceComp?.discount?.value || 0)         || null;

    const chipComp     = compByType['affiliates_commission_chip']?.chip;
    const comissaoStr  = chipComp?.label?.text || '';
    const comissaoMatch = comissaoStr.match(/(\d+)\s*%/);
    const comissao     = comissaoMatch ? parseFloat(comissaoMatch[1]) : 0;

    const temGanhoExtra = meta.extra_commission === 'true' || meta.extra_commission === true;
    const destaque      = compByType['highlight']?.highlight?.text || null;

    if (!titulo || !linkOriginal) return null;

    return {
      ID:            String(id),
      PLATAFORMA:    'Mercado Livre',
      ORIGEM:        origem,
      FONTE:         'HUB',
      PRODUTO:       titulo,
      LINK_ORIGINAL: linkOriginal,
      LINK_AFILIADO: null,
      LINK_IMAGEM:   imagem,
      PRECO_DE:      precoDe,
      PRECO_POR:     precoPor,
      DESCONTO_PCT:  desconto,
      COMISSAO_PCT:  comissao,
      GANHO_EXTRA:   temGanhoExtra,
      DESTAQUE:      destaque,
      TIPO_OFERTA:   null,
      COUNTDOWN_FIM: null,
      DATA_COLETA:   new Date().toISOString(),
      STATUS:        'NOVO',
    };
  } catch (e) {
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  coletarGanhosExtras,
  coletarCategoria,
  getCategoriasPriorizadas,
  buscarTendenciasPelando,
  CATEGORIA_IDS,
};
