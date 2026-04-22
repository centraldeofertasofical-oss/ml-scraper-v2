const axios = require('axios');
const { settings } = require('../config/settings');
const { getCookie, setCookie } = require('../utils/redis');
const { parseCookies, extractCsrf } = require('../utils/headers');
const { log, err } = require('../utils/logger');

async function atualizarCookies(cookieAtual) {
  try {
    const res = await axios.get('https://www.mercadolivre.com.br/afiliados/linkbuilder', {
      headers: {
        'cookie': cookieAtual,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      },
      maxRedirects: 5,
      timeout: 15000,
    });
    const setCookieArr = res.headers['set-cookie'] || [];
    const novoCookie = parseCookies(cookieAtual, setCookieArr);
    await setCookie(novoCookie);
    return novoCookie;
  } catch (e) {
    err('atualizarCookies:', e.message);
    return cookieAtual;
  }
}

async function gerarLinksAfiliado(urls, cookieAtual) {
  const csrf = extractCsrf(cookieAtual);
  try {
    const { data } = await axios.post(
      'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',
      { urls, tag: settings.AFILIADO_TAG },
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'pt-BR,pt;q=0.9',
          'content-type': 'application/json',
          'origin': 'https://www.mercadolivre.com.br',
          'referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': csrf,
          'cookie': cookieAtual,
        },
        timeout: 20000,
      }
    );

    // Retorna mapa { url_original: short_url }
    const mapa = {};
    if (Array.isArray(data?.urls)) {
      data.urls.forEach(u => {
        const origem = u.origin_url || u.original_url || '';
        const short = u.short_url || '';
        if (origem && short) mapa[origem] = short;
      });
    }
    return mapa;
  } catch (e) {
    err('gerarLinksAfiliado:', e.message);
    return {};
  }
}

async function processarLoteAfiliado(produtos) {
  let cookie = await getCookie();
  if (!cookie) {
    err('Cookie não encontrado no Redis');
    return produtos;
  }

  // Atualiza cookies antes de gerar links
  cookie = await atualizarCookies(cookie);

  const loteSize = settings.LOTE_AFILIADO;
  const resultado = [...produtos];

  for (let i = 0; i < resultado.length; i += loteSize) {
    const lote = resultado.slice(i, i + loteSize);
    const urls = lote
      .map(p => p.LINK_ORIGINAL)
      .filter(u => u && u.startsWith('http'));

    if (!urls.length) continue;

    const mapa = await gerarLinksAfiliado(urls, cookie);

    // Atualiza cookie após cada lote
    cookie = await getCookie();

    lote.forEach(p => {
      const short = mapa[p.LINK_ORIGINAL];
      if (short) p.LINK_AFILIADO = short;
    });

    log(`[AFILIADO] Lote ${Math.floor(i/loteSize)+1} → ${Object.keys(mapa).length}/${urls.length} links gerados`);

    if (i + loteSize < resultado.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return resultado;
}

module.exports = { processarLoteAfiliado };