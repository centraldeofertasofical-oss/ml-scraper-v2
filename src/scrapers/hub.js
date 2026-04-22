const axios = require('axios');
const { settings } = require('../config/settings');
const { log, err } = require('../utils/logger');

const HUB_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/hub/search';

async function coletarGanhosExtras(cookie, limite) {
  return coletarHub(cookie, limite, [{ id: 'extra_commission', value: true }], 'GANHOS_EXTRAS');
}

async function coletarCategoria(cookie, categoria, limite) {
  return coletarHub(cookie, limite, [{ id: 'category', value: categoria }], `CAT_${categoria.toUpperCase()}`);
}

async function coletarHub(cookie, limite, filters, origem) {
  const produtos = [];
  let offset = 0;
  let pagina = 1;
  const maxPags = origem === 'GANHOS_EXTRAS' ? settings.MAX_PAGES_POR_FONTE : 10;

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
            'referer': 'https://www.mercadolivre.com.br/afiliados/hub',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
            'cookie': cookie,
          },
          timeout: 20000,
        }
      );

      // Log estrutura na primeira página para debug
      if (pagina === 1) {
        const topKeys = Object.keys(data || {});
        log(`[${origem}] P1 response keys: ${topKeys.join(',')}`);
      }

      // Suporta múltiplos formatos de resposta do hub ML
      const items = extrairItems(data);

      if (!items || items.length === 0) {
        log(`[${origem}] Pág ${pagina} → array vazio, parando`);
        break;
      }

      const parsed = items
        .map(i => parseItem(i, origem))
        .filter(Boolean);

      produtos.push(...parsed);
      log(`[${origem}] Pág ${pagina} → offset ${offset} → ${items.length} brutos / ${parsed.length} parsed (total: ${produtos.length})`);

      if (produtos.length >= limite) break;
      offset += settings.PAGE_SIZE;
      pagina++;
      await sleep(600);

    } catch (e) {
      err(`[${origem}] Erro pág ${pagina}:`, e.response?.status || e.message);
      if (e.response?.status === 401 || e.response?.status === 403) break;
      break;
    }
  }

  return produtos.slice(0, limite);
}

function extrairItems(data) {
  if (!data) return [];
  // Tenta todas as chaves conhecidas
  if (Array.isArray(data.results))       return data.results;
  if (Array.isArray(data.polycard_list)) return data.polycard_list;
  if (Array.isArray(data.items))         return data.items;
  if (Array.isArray(data.data))          return data.data;
  if (Array.isArray(data.products))      return data.products;
  // Procura qualquer chave que seja array não vazio
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
  }
  return [];
}

function parseItem(item, origem) {
  try {
    if (!item) return null;

    // Extrai ID
    const id = item.wid || item.id || item.item_id || item.ID || '';
    if (!id) return null;

    // Extrai título
    const titulo =
      item.title ||
      item.name ||
      item.product_name ||
      item?.polycard?.components?.header?.title?.text ||
      item?.polycard?.components?.header?.text ||
      '';

    // Extrai link
    const linkHub =
      item.url ||
      item.permalink ||
      item.link ||
      item.product_url ||
      '';

    // Extrai imagem
    const imagem =
      item.thumbnail ||
      item.image ||
      item.picture ||
      item?.polycard?.components?.picture?.url ||
      item?.pictures?.[0]?.url ||
      '';

    // Extrai preços
    const precoDe = parseFloat(
      item.original_price ||
      item.price_de ||
      item?.polycard?.components?.price?.original_price ||
      0
    ) || null;

    const precoPor = parseFloat(
      item.price ||
      item.sale_price ||
      item.current_price ||
      item?.polycard?.components?.price?.amount ||
      0
    ) || null;

    // Calcula desconto
    let desconto = parseInt(
      item.discount_percentage ||
      item.discount ||
      item?.polycard?.components?.price?.discount_percentage ||
      0
    ) || null;

    if (!desconto && precoDe && precoPor && precoDe > precoPor) {
      desconto = Math.round(((precoDe - precoPor) / precoDe) * 100);
    }

    // Comissão
    const comissao = parseFloat(
      item.extra_commission_percentage ||
      item.commission_percentage ||
      item.commission ||
      0
    ) || 0;

    // Destaque
    const destaque = item.badge_label || item.label || item.badge || null;

    // Link original (sem query params)
    const linkOriginal = linkHub ? linkHub.split('?')[0].split('#')[0] : '';

    return {
      ID: String(id),
      PLATAFORMA: 'Mercado Livre',
      ORIGEM: origem,
      PRODUTO: String(titulo),
      LINK_ORIGINAL: linkOriginal || linkHub,
      LINK_HUB: linkHub,
      LINK_AFILIADO: null,
      LINK_IMAGEM: String(imagem),
      PRECO_DE: precoDe,
      PRECO_POR: precoPor,
      DESCONTO_PCT: desconto ? Math.abs(desconto) : null,
      COMISSAO_PCT: comissao,
      GANHO_EXTRA: origem === 'GANHOS_EXTRAS',
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

module.exports = { coletarGanhosExtras, coletarCategoria };