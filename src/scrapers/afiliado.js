/**
 * afiliado.js — Geração de shortlinks meli.la com CSRF dinâmico
 * CSRF nunca hardcoded — sempre extraído do cookie atualizado
 */

const axios = require('axios');
const { settings } = require('../config/settings');
const { getCookie, setCookie } = require('../utils/redis');
const { parseCookies, extractCsrf } = require('../utils/headers');
const { log, err } = require('../utils/logger');

// ─── Atualiza cookies via linkbuilder e persiste no Redis ─────────────────────

async function atualizarCookies(cookieAtual) {
  try {
    const res = await axios.get('https://www.mercadolivre.com.br/afiliados/linkbuilder', {
      headers: {
        'cookie':          cookieAtual,
        'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'pt-BR,pt;q=0.9',
      },
      maxRedirects: 5,
      timeout: 15000,
    });
    const setCookieArr = res.headers['set-cookie'] || [];
    const novoCookie   = parseCookies(cookieAtual, setCookieArr);
    await setCookie(novoCookie);
    log('[CSRF] Cookies atualizados via linkbuilder');
    return novoCookie;
  } catch (e) {
    err('[CSRF] Erro ao atualizar cookies:', e.message);
    return cookieAtual;
  }
}

// ─── Gera shortlinks para um lote de URLs ────────────────────────────────────

async function gerarLinksAfiliado(urls, cookieAtual) {
  // CSRF sempre extraído dinamicamente do cookie — nunca hardcoded
  const csrf = extractCsrf(cookieAtual);

  if (!csrf) {
    err('[CSRF] ⚠️ Token CSRF não encontrado no cookie — links serão gerados sem afiliado');
  }

  // Valida que todas as URLs estão no domínio correto antes de enviar
  const urlsValidas = urls.filter(u => u && u.startsWith('https://www.mercadolivre.com.br'));
  if (urlsValidas.length !== urls.length) {
    err(`[AFILIADO] ${urls.length - urlsValidas.length} URLs com domínio inválido descartadas`);
  }

  if (!urlsValidas.length) return {};

  try {
    const { data } = await axios.post(
      'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',
      { urls: urlsValidas, tag: settings.AFILIADO_TAG },
      {
        headers: {
          'accept':           'application/json, text/plain, */*',
          'accept-language':  'pt-BR,pt;q=0.9',
          'content-type':     'application/json',
          'origin':           'https://www.mercadolivre.com.br',
          'referer':          'https://www.mercadolivre.com.br/afiliados/linkbuilder',
          'user-agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'sec-ch-ua':        '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest':   'empty',
          'sec-fetch-mode':   'cors',
          'sec-fetch-site':   'same-origin',
          'x-csrf-token':     csrf,  // ✅ sempre dinâmico
          'cookie':           cookieAtual,
        },
        timeout: 20000,
      }
    );

    const mapa = {};
    if (Array.isArray(data?.urls)) {
      data.urls.forEach(u => {
        const origem = u.origin_url || u.original_url || '';
        const short  = u.short_url  || '';
        if (origem && short) mapa[origem] = short;
      });
    }
    return mapa;

  } catch (e) {
    const status = e.response?.status;
    const body   = JSON.stringify(e.response?.data || {});
    err(`[AFILIADO] Erro createLink: HTTP ${status} — ${body} — ${e.message}`);
    return {};
  }
}

// ─── Processa todos os produtos em lotes ─────────────────────────────────────

async function processarLoteAfiliado(produtos) {
  let cookie = await getCookie();
  if (!cookie) {
    err('[AFILIADO] Cookie não encontrado no Redis — abortando geração de links');
    return produtos;
  }

  // Atualiza cookies ANTES do primeiro lote para garantir CSRF fresco
  cookie = await atualizarCookies(cookie);

  const loteSize    = settings.LOTE_AFILIADO;
  const resultado   = [...produtos];
  let totalGerados  = 0;
  let totalFalhos   = 0;

  for (let i = 0; i < resultado.length; i += loteSize) {
    const lote = resultado.slice(i, i + loteSize);
    const urls = lote
      .map(p => p.LINK_ORIGINAL)
      .filter(u => u && u.startsWith('https://www.mercadolivre.com.br'));

    if (!urls.length) {
      err(`[AFILIADO] Lote ${Math.floor(i/loteSize)+1} — ATENÇÃO: nenhuma URL válida`);
      continue;
    }

    let mapa = await gerarLinksAfiliado(urls, cookie);

    // Retry automático: se retornou vazio, renova cookie e tenta 1x mais
    if (Object.keys(mapa).length === 0) {
      err(`[AFILIADO] Lote ${Math.floor(i/loteSize)+1} retornou vazio — renovando cookie e retentando...`);
      cookie = await atualizarCookies(cookie);
      await sleep(2000);
      mapa = await gerarLinksAfiliado(urls, cookie);
    }

    lote.forEach(p => {
      const short = mapa[p.LINK_ORIGINAL];
      if (short) {
        p.LINK_AFILIADO = short;
        totalGerados++;
      } else {
        err(`[AFILIADO] ⚠️ SEM SHORTLINK: ${p.ID} — ${(p.PRODUTO || '').substring(0, 50)}`);
        totalFalhos++;
      }
    });

    const geradosLote = Object.keys(mapa).length;
    log(`[AFILIADO] Lote ${Math.floor(i/loteSize)+1} → ${geradosLote}/${urls.length} links gerados`);

    if (i + loteSize < resultado.length) {
      cookie = await getCookie();
      await sleep(1000);
    }
  }

  const taxaFalha = resultado.length > 0 ? (totalFalhos / resultado.length) * 100 : 0;
  log(`[AFILIADO] RESUMO: ${totalGerados} gerados / ${totalFalhos} falhos (${taxaFalha.toFixed(1)}% falha)`);

  if (taxaFalha > 30) {
    err(`[AFILIADO] 🚨 ALERTA: ${taxaFalha.toFixed(0)}% dos links falharam — verifique cookie e CSRF`);
  }

  return resultado;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { processarLoteAfiliado };
