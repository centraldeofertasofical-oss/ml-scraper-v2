// src/scrapers/afiliado.js
// Baseado no workflow n8n atual da Central de Ofertas
// Reutiliza a mesma lógica: cookie Redis → GET linkbuilder → POST createLink

import axios from 'axios';
import { settings } from '../config/settings.js';
import { getCookie, setCookie } from '../utils/redis.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function mergeCookies(oldCookieStr = '', setCookieArray = []) {
  const map = {};
  if (oldCookieStr) {
    oldCookieStr.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      if (k) map[k.trim()] = v.join('=');
    });
  }
  for (const raw of setCookieArray) {
    const part = raw.split(';')[0];
    const [k, ...v] = part.trim().split('=');
    if (k) map[k.trim()] = v.join('=');
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractCsrf(cookieStr = '') {
  const match = cookieStr.match(/_csrf=([^;]+)/);
  return match ? match[1] : '';
}

// GET no linkbuilder para atualizar cookies (igual ao nó get-setcookies1)
async function refreshCookieViaLinkbuilder(cookie) {
  try {
    const resp = await axios.get(settings.linkbuilderUrl, {
      headers: {
        'cookie': cookie,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'pt-BR,pt;q=0.9',
        'referer': 'https://www.mercadolivre.com.br',
      },
      timeout: 15000,
      maxRedirects: 5,
    });

    const setCookieArr = resp.headers['set-cookie'] || [];
    const newCookie = mergeCookies(cookie, setCookieArr);
    await setCookie(newCookie);
    logInfo('Cookie atualizado via linkbuilder');
    return newCookie;
  } catch (err) {
    logWarn('Falha ao atualizar cookie via linkbuilder', err?.message);
    return cookie;
  }
}

// POST para /createLink com até 30 URLs (igual ao nó HTTP Request do n8n)
async function criarLinksLote(urls, cookie) {
  const csrf = extractCsrf(cookie);

  const body = {
    urls: urls.filter(u => u && (u.startsWith('http://') || u.startsWith('https://'))),
    tag: settings.afiliadoTag,
  };

  if (!body.urls.length) return [];

  const resp = await axios.post(settings.createLinkUrl, body, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': cookie,
      'origin': 'https://www.mercadolivre.com.br',
      'referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'x-csrf-token': csrf,
      'x-custom-origin': 'https://www.mercadolivre.com.br',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'device-memory': '8',
      'downlink': '10',
      'dpr': '0.8',
      'ect': '4g',
      'rtt': '50',
      'priority': 'u=1, i',
    },
    timeout: 30000,
  });

  // Atualiza cookie se vier no retorno
  const setCookieArr = resp.headers?.['set-cookie'] || [];
  if (setCookieArr.length) {
    const updated = mergeCookies(cookie, setCookieArr);
    await setCookie(updated);
  }

  return resp.data?.urls || [];
}

// Gera links para uma lista de produtos
// Retorna os produtos com LINK_AFILIADO preenchido
export async function gerarLinksAfiliado(produtos = []) {
  if (!produtos.length) return [];

  logInfo(`Gerando links de afiliado para ${produtos.length} produtos`);

  // Pega e atualiza cookie
  let cookie = await getCookie();
  cookie = await refreshCookieViaLinkbuilder(cookie);

  // Divide em lotes de 30
  const lotes = [];
  for (let i = 0; i < produtos.length; i += settings.afiliadoLoteSize) {
    lotes.push(produtos.slice(i, i + settings.afiliadoLoteSize));
  }

  // Mapa de URL → produto para cruzar depois
  const urlMap = new Map();
  for (const p of produtos) {
    if (p.LINK_ORIGINAL) {
      urlMap.set(p.LINK_ORIGINAL, p);
    }
  }

  const produtosComLink = [...produtos]; // cópia para não mutar o original
  let totalOk = 0;
  let totalErro = 0;

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];
    const urls = lote.map(p => p.LINK_ORIGINAL).filter(Boolean);

    logInfo(`Lote ${i + 1}/${lotes.length}: ${urls.length} URLs`);

    try {
      const retorno = await criarLinksLote(urls, cookie);

      // Atualiza cookie para o próximo lote
      cookie = await getCookie();

      // Cruza resultado com produto pelo LINK_ORIGINAL
      for (const r of retorno) {
        const urlOriginal = r.origin_url || r.original_url || '';
        const shortUrl = r.short_url || '';
        const ok = !!shortUrl;

        if (ok) {
          // Busca produto pelo link
          for (const p of produtosComLink) {
            if (p.LINK_ORIGINAL && urlOriginal.includes(p.ID)) {
              p.LINK_AFILIADO = shortUrl;
              p.AFILIADO_OK = true;
              totalOk++;
              break;
            }
          }
        } else {
          totalErro++;
          logWarn(`Link não gerado para ${urlOriginal}`, r.message || r.error);
        }
      }

    } catch (err) {
      logError(`Erro no lote ${i + 1}`, err?.message);
      totalErro += urls.length;
    }

    if (i < lotes.length - 1) {
      await sleep(settings.afiliadoDelay);
      // Atualiza cookie entre lotes
      cookie = await getCookie();
    }
  }

  logInfo('Geração de links concluída', { totalOk, totalErro, total: produtos.length });
  return produtosComLink;
}
