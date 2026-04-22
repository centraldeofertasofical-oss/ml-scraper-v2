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

      // Log completo na primeira página para diagnóstico
      if (pagina === 1) {
        const topKeys = Object.keys(data || {});
        log(`[${origem}] P1 keys: ${topKeys.join(', ')}`);

        if (data.polycard_client_model) {
          const pcKeys = Object.keys(data.polycard_client_model);
          log(`[${origem}] polycard_client_model keys: ${pcKeys.join(', ')}`);

          for (const k of pcKeys) {
            if (Array.isArray(data.polycard_client_model[k]) && data.polycard_client_model[k].length > 0) {
              log(`[${origem}] polycard_client_model.${k} → array com ${data.polycard_client_model[k].length} items`);
              const sample = data.polycard_client_model[k][0];
              log(`[${origem}] SAMPLE_KEYS: ${Object.keys(sample || {}).join(', ')}`);
              log(`[${origem}] SAMPLE_FULL: ${JSON.stringify(sample).substring(0, 1000)}`);
              break;
            }
          }
        }
      }

      // Extrai items usando todos os formatos conhecidos
      const items = extrairItems(data);

      if (!items || items.length === 0) {
        log(`[${origem}] Pág ${pagina} → sem items, parando`);
        break;
      }

      const parsed = items.map(i => parseItem(i, origem)).filter(Boolean);
      produtos.push(...parsed);
      log(`[${origem}] Pág ${pagina} → offset ${offset} → ${items.length} brutos / ${parsed.length} parsed (total: ${produtos.length})`);

      if (produtos.length >= limite) break;
      offset += settings.PAGE_SIZE;
      pagina++;
      await sleep(600);

    } catch (e) {
      err(`[${origem}] Erro pág ${pagina}:`, e.response?.status || e.message);
      break;
    }
  }

  return produtos.slice(0, limite);
}

function extrairItems(data) {
  if (!data) return [];

  // Formatos diretos na raiz
  if (Array.isArray(data.results))       return data.results;
  if (Array.isArray(data.polycard_list)) return data.polycard_list;
  if (Array.isArray(data.items))         return data.items;
  if (Array.isArray(data.data))          return data.data;
  if (Array.isArray(data.products))      return data.products;

  // Formato polycard_client_model (detectado nos logs)
  if (data.polycard_client_model) {
    const pcm = data.polycard_client_model;
    if (Array.isArray(pcm.polycard_list)) return pcm.polycard_list;
    if (Array.isArray(pcm.results))       return pcm.results;
    if (Array.isArray(pcm.items))         return pcm.items;
    if (Array.isArray(pcm.products))      return pcm.products;
    if (Array.isArray(pcm.components))    return pcm.components;
    if (Array.isArray(pcm.cards))         return pcm.cards;
    if (Array.isArray(pcm.offers))        return pcm.offers;

    // Busca qualquer array não vazio dentro do polycard_client_model
    for (const key of Object.keys(pcm)) {
      if (Array.isArray(pcm[key]) && pcm[key].length > 0) {
        log(`[HUB] Usando polycard_client_model.${key} como fonte de items`);
        return pcm[key];
      }
    }
  }

  // Busca genérica: qualquer chave que seja array não vazio na raiz
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key]) && data[key].length > 0) {
      return data[key];
    }
  }

  return [];
}

function parseItem(item, origem) {
  try {
    if (!item || typeof item !== 'object') return null;

    // === ID ===
    const id =
      item.wid || item.id || item.item_id || item.ID ||
      item?.polycard?.id ||
      item?.metadata?.id ||
      item?.tracking?.id ||
      '';
    if (!id) return null;

    // === TÍTULO ===
    const titulo =
      item.title || item.name || item.product_name ||
      item?.polycard?.components?.header?.title?.text ||
      item?.polycard?.components?.header?.text ||
      item?.header?.title?.text ||
      item?.header?.title ||
      item?.content?.title ||
      '';

    // === LINK ===
    const linkHub =
      item.url || item.permalink || item.link || item.product_url ||
      item?.polycard?.url ||
      item?.polycard?.metadata?.url ||
      item?.metadata?.url ||
      '';

    // === IMAGEM ===
    const imagem =
      item.thumbnail || item.image || item.picture || item.img ||
      item?.polycard?.components?.picture?.url ||
      item?.polycard?.components?.picture?.src ||
      item?.picture?.url ||
      item?.pictures?.[0]?.url ||
      item?.content?.picture?.url ||
      '';

    // === PREÇO DE (original) ===
    const precoDe = parseFloat(
      item.original_price ||
      item.price_original ||
      item.regular_price ||
      item?.polycard?.components?.price?.original_price ||
      item?.price?.original ||
      item?.pricing?.original_price ||
      0
    ) || null;

    // === PREÇO POR (atual) ===
    const precoPor = parseFloat(
      item.price ||
      item.sale_price ||
      item.current_price ||
      item.amount ||
      item?.polycard?.components?.price?.amount ||
      item?.polycard?.components?.price?.price ||
      item?.price?.amount ||
      item?.pricing?.price ||
      0
    ) || null;

    // === DESCONTO ===
    let desconto = Math.abs(parseInt(
      item.discount_percentage ||
      item.discount ||
      item?.polycard?.components?.price?.discount_percentage ||
      item?.price?.discount_percentage ||
      item?.pricing?.discount_percentage ||
      0
    ) || 0) || null;

    if (!desconto && precoDe && precoPor && precoDe > precoPor) {
      desconto = Math.round(((precoDe - precoPor) / precoDe) * 100);
    }

    // === COMISSÃO ===
    const comissao = parseFloat(
      item.extra_commission_percentage ||
      item.commission_percentage ||
      item.commission ||
      item?.affiliate?.commission ||
      item?.affiliate_data?.commission ||
      0
    ) || 0;

    // === DESTAQUE ===
    const destaque =
      item.badge_label || item.label || item.badge ||
      item?.polycard?.components?.header?.badge ||
      item?.badges?.[0]?.text ||
      null;

    const linkOriginal = linkHub ? linkHub.split('?')[0].split('#')[0] : '';

    // Valida campos mínimos
    if (!linkOriginal && !linkHub) return null;

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
      DESCONTO_PCT: desconto,
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
