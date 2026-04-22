const axios = require('axios');
const { settings } = require('../config/settings');
const { log, err } = require('../utils/logger');

const HUB_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/hub/search';

// IDs reais de categorias do hub ML (confirmados nos filtros da API)
const CATEGORIA_IDS = {
  'MLB1430': 'Calçados, Roupas e Bolsas',
  'MLB1246': 'Beleza e Cuidado Pessoal',
  'MLB1000': 'Eletrônicos, Áudio e Vídeo',
  'MLB1051': 'Celulares e Telefones',
  'MLB1648': 'Informática',
  'MLB5726': 'Eletrodomésticos',
  'MLB1574': 'Casa, Móveis e Decoração',
  'MLB1276': 'Esportes e Fitness',
  'MLB1071': 'Pet Shop',
  'MLB1384': 'Bebês',
  'MLB264586': 'Saúde',
  'MLB263532': 'Ferramentas',
  'MLB5672': 'Acessórios para Veículos',
  'MLB1132': 'Brinquedos e Hobbies',
};

const PICTURE_TEMPLATE = 'https://http2.mlstatic.com/D_Q_NP_2X_{id}-O.webp';

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
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9',
            'content-type': 'application/json',
            'origin': 'https://www.mercadolivre.com.br',
            'referer': 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
            'cookie': cookie,
          },
          timeout: 20000,
        }
      );

      // Extrai o array polycards do formato real da API
      const polycards = data?.polycard_client_model?.polycards;
      if (!polycards || polycards.length === 0) {
        log(`[${origem}] Pág ${pagina} → sem polycards, parando`);
        break;
      }

      const parsed = polycards.map(card => parsePolycard(card, origem, data?.polycard_client_model?.polycard_context)).filter(Boolean);
      produtos.push(...parsed);
      log(`[${origem}] Pág ${pagina} → offset ${offset} → ${polycards.length} brutos / ${parsed.length} parsed (total: ${produtos.length})`);

      if (produtos.length >= limite) break;
      offset += polycards.length; // usa length real, não PAGE_SIZE fixo
      pagina++;
      await sleep(600);

    } catch (e) {
      err(`[${origem}] Erro pág ${pagina}:`, e.response?.status || e.message);
      break;
    }
  }

  return produtos.slice(0, limite);
}

function parsePolycard(card, origem, context) {
  try {
    if (!card || !card.metadata) return null;

    const meta = card.metadata;

    // ID
    const id = meta.id || meta.wid || '';
    if (!id) return null;

    // Link — monta URL completa a partir de metadata
    const urlBase = meta.url || '';
    const urlFragments = meta.url_fragments || '';
    const urlParams = meta.url_params || '';
    const urlPrefix = context?.url_prefix || 'https://';
    const linkCompleto = urlBase ? `${urlPrefix}${urlBase}${urlParams}${urlFragments}` : '';
    const linkOriginal = urlBase ? `${urlPrefix}${urlBase}` : '';

    // Imagem — usa template do context + id da foto
    const picId = card?.pictures?.pictures?.[0]?.id || '';
    const picTemplate = context?.picture_template || PICTURE_TEMPLATE;
    const square = card?.pictures?.square || context?.picture_square_default || 'Q';
    const imagem = picId
      ? picTemplate
          .replace('{square}', square)
          .replace('{2x}', '2X')
          .replace('{id}', picId)
          .replace('{size}', 'O')
          .replace('{sanitized_title}', card?.pictures?.sanitized_title || '')
      : '';

    // Extrai componentes por type
    const components = card.components || [];
    const compByType = {};
    for (const c of components) {
      compByType[c.id || c.type] = c;
    }

    // Título
    const titulo = compByType['title']?.title?.text || '';

    // Preço
    const priceComp = compByType['price']?.price || {};
    const precoPor = parseFloat(priceComp?.current_price?.value || 0) || null;
    const precoDe = parseFloat(priceComp?.previous_price?.value || 0) || null;
    const desconto = parseInt(priceComp?.discount?.value || 0) || null;

    // Comissão — chip label contém "17%" ou "GANHOS EXTRAS" com label separado
    const chipComp = compByType['affiliates_commission_chip']?.chip;
    let comissaoStr = chipComp?.label?.text || '';
    // Extrai número da string "17%" ou "GANHOS 17%"
    const comissaoMatch = comissaoStr.match(/(\d+)\s*%/);
    const comissao = comissaoMatch ? parseFloat(comissaoMatch[1]) : 0;

    // Ganho extra — presença de pill com "EXTRAS"
    const temGanhoExtra = meta.extra_commission === 'true' || meta.extra_commission === true;

    // Destaque (highlight component)
    const destaque = compByType['highlight']?.highlight?.text || null;

    if (!titulo || !linkOriginal) return null;

    return {
      ID: String(id),
      PLATAFORMA: 'Mercado Livre',
      ORIGEM: origem,
      PRODUTO: titulo,
      LINK_ORIGINAL: linkOriginal,
      LINK_AFILIADO: null,
      LINK_IMAGEM: imagem,
      PRECO_DE: precoDe,
      PRECO_POR: precoPor,
      DESCONTO_PCT: desconto,
      COMISSAO_PCT: comissao,
      GANHO_EXTRA: temGanhoExtra,
      DESTAQUE: destaque,
      DATA_COLETA: new Date().toISOString(),
      STATUS: 'NOVO',
    };
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { coletarGanhosExtras, coletarCategoria, CATEGORIA_IDS };