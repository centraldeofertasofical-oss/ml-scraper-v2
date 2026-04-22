const axios = require('axios');
const { settings } = require('../config/settings');
const { log } = require('../utils/logger');

const HUB_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/hub/search';

async function coletarGanhosExtras(cookie, limite) {
  const produtos = [];
  let offset = 0;
  let pagina = 1;

  while (produtos.length < limite && pagina <= settings.MAX_PAGES_POR_FONTE) {
    try {
      const { data } = await axios.post(
        `${HUB_URL}?is_affiliate=true&device=desktop`,
        { search: '', sort: 'relevance', filters: [{ id: 'extra_commission', value: true }], offset },
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'cookie': cookie,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
            'origin': 'https://www.mercadolivre.com.br',
            'referer': 'https://www.mercadolivre.com.br/afiliados/hub',
          },
          timeout: 15000,
        }
      );

      const items = data?.results || data?.polycard_list || [];
      if (!items.length) break;

      const parsed = items.map(i => parseItem(i, 'GANHOS_EXTRAS'));
      produtos.push(...parsed);
      log(`[GANHOS_EXTRAS] Pág ${pagina} → offset ${offset} → ${items.length} produtos (total: ${produtos.length})`);

      if (produtos.length >= limite) break;
      offset += settings.PAGE_SIZE;
      pagina++;
      await sleep(800);
    } catch (e) {
      log(`[GANHOS_EXTRAS] Erro pág ${pagina}: ${e.message}`);
      break;
    }
  }

  return produtos.slice(0, limite);
}

async function coletarCategoria(cookie, categoria, limite) {
  const produtos = [];
  let offset = 0;
  let pagina = 1;

  while (produtos.length < limite && pagina <= 10) {
    try {
      const { data } = await axios.post(
        `${HUB_URL}?is_affiliate=true&device=desktop`,
        { search: '', sort: 'relevance', filters: [{ id: 'category', value: categoria }], offset },
        {
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'cookie': cookie,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
            'origin': 'https://www.mercadolivre.com.br',
            'referer': 'https://www.mercadolivre.com.br/afiliados/hub',
          },
          timeout: 15000,
        }
      );

      const items = data?.results || data?.polycard_list || [];
      if (!items.length) break;

      const parsed = items.map(i => parseItem(i, `CAT_${categoria.toUpperCase()}`));
      produtos.push(...parsed);

      if (produtos.length >= limite) break;
      offset += settings.PAGE_SIZE;
      pagina++;
      await sleep(600);
    } catch (e) {
      log(`[CAT_${categoria}] Erro pág ${pagina}: ${e.message}`);
      break;
    }
  }

  return produtos.slice(0, limite);
}

function parseItem(item, origem) {
  try {
    // Compatível com polycard JSON
    const pc = item?.polycard?.components || {};
    const price = pc?.price || item?.price || {};
    const header = pc?.header || item?.title || {};

    const id = item?.wid || item?.id || item?.item_id || '';
    const titulo = header?.title?.text || header?.text || item?.title || item?.name || '';
    const linkHub = item?.url || item?.permalink || item?.link || '';
    const imagem = pc?.picture?.url || item?.thumbnail || item?.pictures?.[0]?.url || '';
    const precoDe = parseFloat(price?.original_price || item?.original_price || 0) || null;
    const precoPor = parseFloat(price?.amount || price?.price || item?.price || 0) || null;
    const desconto = price?.discount_percentage || item?.discount_percentage || null;
    const comissao = item?.extra_commission_percentage || item?.commission_percentage || 0;
    const destaque = item?.badge_label || item?.label || null;

    const linkOriginal = extrairLinkOriginal(linkHub);

    return {
      ID: id,
      PLATAFORMA: 'Mercado Livre',
      ORIGEM: origem,
      PRODUTO: titulo,
      LINK_ORIGINAL: linkOriginal || linkHub,
      LINK_HUB: linkHub,
      LINK_AFILIADO: null,
      LINK_IMAGEM: imagem,
      PRECO_DE: precoDe,
      PRECO_POR: precoPor,
      DESCONTO_PCT: desconto ? Math.abs(parseInt(desconto)) : calcDesconto(precoDe, precoPor),
      COMISSAO_PCT: parseFloat(comissao) || 0,
      GANHO_EXTRA: origem === 'GANHOS_EXTRAS',
      DESTAQUE: destaque,
      DATA_COLETA: new Date().toISOString(),
      STATUS: 'NOVO',
    };
  } catch (e) {
    return null;
  }
}

function extrairLinkOriginal(linkHub) {
  if (!linkHub) return '';
  return linkHub.split('?')[0].split('#')[0];
}

function calcDesconto(de, por) {
  if (!de || !por || de <= 0) return null;
  return Math.round(((de - por) / de) * 100);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { coletarGanhosExtras, coletarCategoria };