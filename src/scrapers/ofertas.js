/**
 * ofertas.js — Scraper de Ofertas Relâmpago e Ofertas do Dia do Mercado Livre
 * Extrai dados do JSON injetado no HTML (_n.ctx.r.appProps.pageProps.data)
 * Não depende de seletores CSS — muito mais estável
 */

const https = require('https');
const { log, err } = require('../utils/logger');

// ─── Extração do JSON do HTML ─────────────────────────────────────────────────

function extrairDadosDoHTML(html) {
  // ML injeta todos os dados em _n.ctx.r = {...} no HTML
  const match = html.match(/_n\.ctx\.r\s*=\s*(\{[\s\S]*?\});\s*(?:_n\.|window\.)/);
  if (!match) {
    // Fallback: tentar variação diferente do padrão
    const match2 = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*</);
    if (!match2) throw new Error('JSON de dados não encontrado no HTML');
    return JSON.parse(match2[1]);
  }
  return JSON.parse(match[1]);
}

// ─── Construção do LINK_ORIGINAL canônico ────────────────────────────────────

function construirLinkOriginal(metadata) {
  // Prioridade 1: product_id (MLB + número) → /p/MLBXXXXXXX
  if (metadata.product_id) {
    return `https://www.mercadolivre.com.br/p/${metadata.product_id}`;
  }

  // Prioridade 2: URL que já vem com domínio www
  if (metadata.url && metadata.url.startsWith('www.mercadolivre.com.br')) {
    return `https://${metadata.url.split('#')[0].split('?')[0]}`;
  }

  // Fallback: montar pelo ID
  const mlbId = String(metadata.id || '').trim();
  return `https://www.mercadolivre.com.br/p/${mlbId}`;
}

// ─── Parser de card de oferta ─────────────────────────────────────────────────

function parsearCard(item, promotionType) {
  const card       = item.card;
  const metadata   = card.metadata || {};
  const components = card.components || [];

  const resultado = {
    ID:            metadata.id || metadata.product_id || '',
    PLATAFORMA:    'Mercado Livre',
    ORIGEM:        `OFERTA_${(promotionType || 'DESCONHECIDO').toUpperCase()}`,
    FONTE:         'OFERTAS',
    PRODUTO:       null,
    LINK_ORIGINAL: construirLinkOriginal(metadata),
    LINK_AFILIADO: null,
    LINK_IMAGEM:   null,
    PRECO_DE:      null,
    PRECO_POR:     null,
    DESCONTO_PCT:  null,
    DESCONTO_PIX:  false,
    COMISSAO_PCT:  0,
    GANHO_EXTRA:   false,
    DESTAQUE:      null,
    TIPO_OFERTA:   promotionType || null,
    COUNTDOWN_FIM: null,
    FRETE_GRATIS:  false,
    AVALIACAO:     null,
    CUPOM_VALOR:   null,
    PATROCINADO:   item.type !== 'ORGANIC_ITEM',
    DATA_COLETA:   new Date().toISOString(),
    STATUS:        'NOVO',
  };

  for (const comp of components) {
    switch (comp.type) {
      case 'title':
        resultado.PRODUTO = comp.title?.text || null;
        break;

      case 'price': {
        const price = comp.price || {};
        resultado.PRECO_DE    = price.previous_price?.value || null;
        resultado.PRECO_POR   = price.current_price?.value  || null;
        const discLabel       = price.discount_label?.text  || '';
        resultado.DESCONTO_PCT = parseInt(discLabel.match(/(\d+)%/)?.[1] || '0') || null;
        resultado.DESCONTO_PIX = discLabel.includes('Pix');
        break;
      }

      case 'shipping':
        resultado.FRETE_GRATIS = !!(
          (comp.shipping?.text || '').toLowerCase().includes('grátis') ||
          (comp.shipping?.text || '').toLowerCase().includes('gratuito')
        );
        break;

      case 'reviews':
        resultado.AVALIACAO = comp.reviews?.rating_average || null;
        break;

      case 'highlight_countdown': {
        const cd = comp.highlight_countdown || {};
        resultado.COUNTDOWN_FIM = cd.countdown?.period_end || null;
        const texto = (cd.text || '').toLowerCase();
        if (texto.includes('relâmpago') || texto.includes('relampago')) resultado.TIPO_OFERTA = 'lightning';
        else if (texto.includes('dia')) resultado.TIPO_OFERTA = 'deal_of_the_day';
        break;
      }

      case 'highlight':
        resultado.DESTAQUE = comp.highlight?.text || null;
        break;

      case 'promotions': {
        const promos = comp.promotions || [];
        for (const promo of promos) {
          if (promo.type === 'coupon') {
            for (const v of (promo.values || [])) {
              if (v.type === 'price' && v.key === 'amount') {
                resultado.CUPOM_VALOR = v.price?.value || null;
                break;
              }
            }
          }
        }
        break;
      }

      case 'picture':
      case 'thumbnail': {
        const img = comp.picture?.pictures?.[0] || comp.thumbnail;
        if (img) resultado.LINK_IMAGEM = img.url || img.src || null;
        break;
      }
    }
  }

  return resultado;
}

// ─── Fetch do HTML de ofertas ─────────────────────────────────────────────────

function fetchOfertasHTML(promotionType, cookies, pagina) {
  return new Promise((resolve, reject) => {
    const urlStr = `https://www.mercadolivre.com.br/ofertas?container_id=MLB779362-1&promotion_type=${promotionType}&page=${pagina}`;
    const urlObj = new URL(urlStr);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers: {
        'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language':           'pt-BR,pt;q=0.9',
        'cookie':                    cookies,
        'user-agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'sec-fetch-dest':            'document',
        'sec-fetch-mode':            'navigate',
        'sec-fetch-site':            'same-origin',
        'sec-ch-ua':                 '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-platform':        '"Windows"',
        'upgrade-insecure-requests': '1',
        'referer':                   'https://www.mercadolivre.com.br/ofertas?container_id=MLB779362-1',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ao buscar ofertas ${promotionType}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end',  ()    => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout ofertas ML')); });
    req.end();
  });
}

// ─── Scraper principal ────────────────────────────────────────────────────────

/**
 * Scrapa um tipo de oferta do ML
 * @param {string} promotionType - 'lightning' | 'deal_of_the_day'
 * @param {string} cookies - string de cookies do Redis
 * @param {object} opcoes - { pagina, maxPaginas, apenasOrganicos }
 */
async function scraparOfertas(promotionType, cookies, opcoes = {}) {
  const {
    pagina        = 1,
    maxPaginas    = 1,
    apenasOrganicos = true,
  } = opcoes;

  const todosItems = [];
  let pagingInfo   = null;

  for (let p = pagina; p <= pagina + maxPaginas - 1; p++) {
    log(`[Ofertas] Buscando ${promotionType} página ${p}...`);

    let html;
    try {
      html = await fetchOfertasHTML(promotionType, cookies, p);
    } catch (e) {
      err(`[Ofertas] Erro na página ${p}:`, e.message);
      break;
    }

    let ctx;
    try {
      ctx = extrairDadosDoHTML(html);
    } catch (e) {
      err(`[Ofertas] Erro ao extrair dados página ${p}:`, e.message);
      break;
    }

    const data = ctx?.appProps?.pageProps?.data;
    if (!data) {
      err(`[Ofertas] Estrutura de dados não encontrada na página ${p}`);
      break;
    }

    if (p === pagina) pagingInfo = data.paging;

    const rawItems = data.items || [];

    for (const item of rawItems) {
      if (apenasOrganicos && item.type !== 'ORGANIC_ITEM') continue;
      try {
        const parsed = parsearCard(item, promotionType);
        if (parsed.ID && parsed.PRODUTO && parsed.LINK_ORIGINAL) {
          todosItems.push(parsed);
        }
      } catch (e) {
        err(`[Ofertas] Erro ao parsear item:`, e.message);
      }
    }

    log(`[Ofertas] ${promotionType} pág ${p} → ${rawItems.length} brutos / ${todosItems.length} válidos`);

    if (!pagingInfo) break;
    const totalPaginas = Math.ceil((pagingInfo.primaryResults || 0) / (pagingInfo.limit || 48));
    if (p >= totalPaginas) break;

    if (p < pagina + maxPaginas - 1) await sleep(2000);
  }

  return {
    items:         todosItems,
    paging:        pagingInfo,
    promotionType,
    coletadoEm:    new Date().toISOString(),
  };
}

/**
 * Scrapa ambos os tipos (relâmpago + do dia) em paralelo
 */
async function scraparTodasOfertas(cookies, opcoes = {}) {
  const [relampago, doDia] = await Promise.allSettled([
    scraparOfertas('lightning',       cookies, opcoes),
    scraparOfertas('deal_of_the_day', cookies, opcoes),
  ]);

  const resultado = {
    lightning:       relampago.status === 'fulfilled' ? relampago.value : { items: [], erro: relampago.reason?.message },
    deal_of_the_day: doDia.status    === 'fulfilled' ? doDia.value     : { items: [], erro: doDia.reason?.message    },
    coletadoEm:      new Date().toISOString(),
  };

  const total = (resultado.lightning.items?.length || 0) + (resultado.deal_of_the_day.items?.length || 0);
  log(`[Ofertas] Total: ${total} produtos (${resultado.lightning.items?.length || 0} relâmpago + ${resultado.deal_of_the_day.items?.length || 0} do dia)`);

  return resultado;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  scraparOfertas,
  scraparTodasOfertas,
  parsearCard,
  extrairDadosDoHTML,
};
