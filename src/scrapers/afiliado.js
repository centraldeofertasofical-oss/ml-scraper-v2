// afiliado.js — Geração de shortlinks meli.la com cookie e CSRF dinâmicos

const axios = require('axios');
const { settings } = require('../config/settings');
const { getCookie, setCookie } = require('../utils/redis');
const {
  parseCookies,
  extractCsrfFromCookie,
  extractCsrfFromHtml,
  buildHeaders,
  maskToken,
} = require('../utils/headers');
const { log, err } = require('../utils/logger');

const LINKBUILDER_URL = 'https://www.mercadolivre.com.br/afiliados/linkbuilder';
const CREATE_LINK_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizarUrlMercadoLivre(url) {
  let u = String(url || '').trim();

  if (!u) return '';

  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('www.mercadolivre.com.br')) u = `https://${u}`;
  if (u.startsWith('produto.mercadolivre.com.br')) u = `https://${u}`;

  try {
    const parsed = new URL(u);

    const hostValido = [
      'www.mercadolivre.com.br',
      'produto.mercadolivre.com.br',
    ].includes(parsed.hostname);

    if (!hostValido) return '';

    if (parsed.hostname.includes('click1.mercadolivre.com.br')) return '';
    if (parsed.pathname.includes('/mclics/clicks/external/')) return '';

    parsed.hash = '';

    return parsed.toString();
  } catch {
    return '';
  }
}

function filtrarUrlsValidas(urls) {
  const seen = new Set();
  const validas = [];
  const invalidas = [];

  for (const raw of urls || []) {
    const url = normalizarUrlMercadoLivre(raw);

    if (!url) {
      invalidas.push(raw);
      continue;
    }

    if (seen.has(url)) continue;
    seen.add(url);
    validas.push(url);
  }

  return { validas, invalidas };
}

async function atualizarCookiesECsrf(cookieAtual) {
  try {
    const res = await axios.get(LINKBUILDER_URL, {
      headers: {
        cookie: cookieAtual,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      maxRedirects: 5,
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 400,
    });

    const setCookieArr = res.headers['set-cookie'] || [];
    const cookieNovo = parseCookies(cookieAtual, setCookieArr);

    const csrfHtml = extractCsrfFromHtml(res.data);
    const csrfCookie = extractCsrfFromCookie(cookieNovo);
    const csrf = csrfHtml || csrfCookie;

    await setCookie(cookieNovo);

    log(`[CSRF] Cookies atualizados via linkbuilder | csrf=${maskToken(csrf)} | set-cookie=${setCookieArr.length}`);

    return {
      cookie: cookieNovo,
      csrf,
    };
  } catch (e) {
    err('[CSRF] Erro ao atualizar cookies/linkbuilder:', e.response?.status || e.message);

    return {
      cookie: cookieAtual,
      csrf: extractCsrfFromCookie(cookieAtual),
    };
  }
}

async function gerarLinksAfiliado(urls, cookieAtual, csrfAtual) {
  const { validas: urlsValidas, invalidas } = filtrarUrlsValidas(urls);

  if (invalidas.length) {
    err(`[AFILIADO] ${invalidas.length} URLs inválidas descartadas`);
  }

  if (!urlsValidas.length) return {};

  const csrf = csrfAtual || extractCsrfFromCookie(cookieAtual);

  if (!csrf) {
    err('[CSRF] Token CSRF vazio antes do createLink');
  }

  try {
    const body = {
      urls: urlsValidas,
      tag: settings.AFILIADO_TAG,
    };

    const { data } = await axios.post(
      CREATE_LINK_URL,
      body,
      {
        headers: buildHeaders(cookieAtual, csrf),
        timeout: 25000,
        validateStatus: s => s >= 200 && s < 500,
      }
    );

    if (!data || !Array.isArray(data.urls)) {
      err(`[AFILIADO] Retorno inesperado createLink | body=${JSON.stringify(data || {})}`);
      return {};
    }

    const mapa = {};

    for (const u of data.urls) {
      const origem = normalizarUrlMercadoLivre(u.origin_url || u.original_url || '');
      const short = String(u.short_url || '').trim();

      if (origem && short) {
        mapa[origem] = short;
      } else {
        err(`[AFILIADO] Item sem short_url | origem=${origem} | erro=${u.message || u.error || ''} | code=${u.error_code || ''}`);
      }
    }

    return mapa;
  } catch (e) {
    const status = e.response?.status;
    const body = JSON.stringify(e.response?.data || {});

    err(`[AFILIADO] Erro createLink: HTTP ${status} — ${body} — ${e.message}`);
    err(`[AFILIADO] Debug lote | urls=${urlsValidas.length} | csrf=${maskToken(csrf)} | cookie=${cookieAtual ? 'sim' : 'não'}`);
    err(`[AFILIADO] URLs lote: ${JSON.stringify(urlsValidas.slice(0, 5))}`);

    return {};
  }
}

async function processarLoteAfiliado(produtos) {
  let cookie = await getCookie();

  if (!cookie) {
    err('[AFILIADO] Cookie não encontrado no Redis — abortando geração de links');
    return produtos;
  }

  let sessao = await atualizarCookiesECsrf(cookie);
  cookie = sessao.cookie;
  let csrf = sessao.csrf;

  const loteSize = settings.LOTE_AFILIADO || 30;
  const resultado = produtos.map(p => ({ ...p }));
  let totalGerados = 0;
  let totalFalhos = 0;

  for (let i = 0; i < resultado.length; i += loteSize) {
    const lote = resultado.slice(i, i + loteSize);

    const urls = lote
      .map(p => p.LINK_ORIGINAL)
      .map(normalizarUrlMercadoLivre)
      .filter(Boolean);

    if (!urls.length) {
      err(`[AFILIADO] Lote ${Math.floor(i / loteSize) + 1} — nenhuma URL válida`);
      totalFalhos += lote.length;
      continue;
    }

    let mapa = await gerarLinksAfiliado(urls, cookie, csrf);

    if (Object.keys(mapa).length === 0) {
      err(`[AFILIADO] Lote ${Math.floor(i / loteSize) + 1} retornou vazio — renovando cookie/CSRF e tentando mais 1x...`);

      sessao = await atualizarCookiesECsrf(cookie);
      cookie = sessao.cookie;
      csrf = sessao.csrf;

      await sleep(2000);
      mapa = await gerarLinksAfiliado(urls, cookie, csrf);
    }

    lote.forEach(p => {
      const origemNormalizada = normalizarUrlMercadoLivre(p.LINK_ORIGINAL);
      const short = mapa[origemNormalizada];

      if (short) {
        p.LINK_ORIGINAL = origemNormalizada;
        p.LINK_AFILIADO = short;
        totalGerados++;
      } else {
        p.LINK_AFILIADO = p.LINK_AFILIADO || null;
        err(`[AFILIADO] ⚠️ SEM SHORTLINK: ${p.ID} — ${(p.PRODUTO || '').substring(0, 60)}`);
        totalFalhos++;
      }
    });

    const geradosLote = Object.keys(mapa).length;
    log(`[AFILIADO] Lote ${Math.floor(i / loteSize) + 1} → ${geradosLote}/${urls.length} links gerados`);

    if (i + loteSize < resultado.length) {
      await sleep(1200);
    }
  }

  const taxaFalha = resultado.length > 0 ? (totalFalhos / resultado.length) * 100 : 0;

  log(`[AFILIADO] RESUMO: ${totalGerados} gerados / ${totalFalhos} falhos (${taxaFalha.toFixed(1)}% falha)`);

  if (taxaFalha > 30) {
    err(`[AFILIADO] 🚨 ALERTA: ${taxaFalha.toFixed(0)}% dos links falharam — verifique cookie, CSRF e resposta do createLink`);
  }

  return resultado;
}

module.exports = {
  processarLoteAfiliado,
  atualizarCookiesECsrf,
  gerarLinksAfiliado,
  normalizarUrlMercadoLivre,
};
