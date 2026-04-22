// src/scrapers/hub.js
import axios from 'axios';
import { settings } from '../config/settings.js';
import { getCookie, setCookie } from '../utils/redis.js';
import { parseHubResponse } from '../utils/parser.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Mescla cookies: antigos + novos do set-cookie
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

// Atualiza cookie via GET no linkbuilder (igual ao seu workflow n8n)
async function refreshCookie(oldCookie) {
  try {
    const resp = await axios.get(settings.linkbuilderUrl, {
      headers: {
        'cookie': oldCookie,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'pt-BR,pt;q=0.9',
      },
      timeout: 15000,
      maxRedirects: 5,
    });

    const setCookieHeader = resp.headers['set-cookie'] || [];
    const newCookie = mergeCookies(oldCookie, setCookieHeader);
    await setCookie(newCookie);
    return newCookie;
  } catch (err) {
    logWarn('Falha ao atualizar cookie via linkbuilder, usando cookie atual', err?.message);
    return oldCookie;
  }
}

// Monta headers para a chamada ao hub
function buildHubHeaders(cookie, csrfToken) {
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'content-type': 'application/json',
    'cookie': cookie,
    'origin': 'https://www.mercadolivre.com.br',
    'referer': 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'x-csrf-token': csrfToken || '',
    'x-custom-origin': 'https://www.mercadolivre.com.br',
  };
}

// Extrai csrf token do cookie string
function extractCsrf(cookieStr = '') {
  const match = cookieStr.match(/_csrf=([^;]+)/);
  return match ? match[1] : '';
}

// Uma página do hub
async function fetchHubPage(cookie, body) {
  const csrf = extractCsrf(cookie);
  const headers = buildHubHeaders(cookie, csrf);

  const resp = await axios.post(settings.hubUrl, body, {
    headers,
    timeout: 20000,
  });

  // Atualiza cookie se vier set-cookie
  const setCookieArr = resp.headers['set-cookie'] || [];
  if (setCookieArr.length) {
    const updated = mergeCookies(cookie, setCookieArr);
    await setCookie(updated);
    return { data: resp.data, cookie: updated };
  }

  return { data: resp.data, cookie };
}

// Coleta paginada de uma fonte (ganhos_extras ou categoria)
async function coletarFonte({ filters = [], fonte = 'HUB', maxPages = null }) {
  const limite = maxPages || settings.maxPagesPerFonte;
  const todos = [];
  let offset = 0;
  let pagina = 0;
  let cookie = await getCookie();

  // Atualiza cookie antes de começar
  cookie = await refreshCookie(cookie);

  while (pagina < limite) {
    const body = {
      search: '',
      sort: 'relevance',
      filters,
      offset,
    };

    try {
      const { data, cookie: newCookie } = await fetchHubPage(cookie, body);
      cookie = newCookie;

      const produtos = parseHubResponse(data, fonte);

      if (!produtos.length) {
        logInfo(`[${fonte}] Fim da paginação no offset ${offset} (página ${pagina + 1})`);
        break;
      }

      todos.push(...produtos);
      logInfo(`[${fonte}] Página ${pagina + 1} → offset ${offset} → ${produtos.length} produtos (total: ${todos.length})`);

      offset += settings.pageSize;
      pagina++;

      if (pagina < limite) {
        await sleep(settings.delayBetweenPages);
      }

    } catch (err) {
      logError(`[${fonte}] Erro na página ${pagina + 1} offset ${offset}`, err?.message);
      // Tenta mais uma vez com delay maior
      await sleep(3000);
      pagina++;
    }
  }

  return todos;
}

// ─── Fontes públicas ──────────────────────────────────────────────────────────

export async function coletarGanhosExtras() {
  logInfo('Iniciando coleta: Ganhos Extras');
  return coletarFonte({
    filters: [{ id: 'extra_commission', value: true }],
    fonte: 'GANHOS_EXTRAS',
  });
}

export async function coletarMaisVendidos() {
  logInfo('Iniciando coleta: Mais Vendidos');
  return coletarFonte({
    filters: [{ id: 'best_seller', value: true }],
    fonte: 'MAIS_VENDIDOS',
  });
}

export async function coletarPorCategoria(categoriaId, categoriaNome) {
  logInfo(`Iniciando coleta: Categoria ${categoriaNome} (${categoriaId})`);
  return coletarFonte({
    filters: [{ id: 'category', value: categoriaId }],
    fonte: `CAT_${categoriaId}`,
    maxPages: 10, // limita por categoria para não demorar demais
  });
}

// ─── Coleta completa ──────────────────────────────────────────────────────────

export async function coletarTudo({ incluirCategorias = true } = {}) {
  const resultado = {
    fontes: [],
    produtos_brutos: [],
  };

  // 1. Ganhos Extras (prioridade máxima)
  try {
    const ganhos = await coletarGanhosExtras();
    resultado.fontes.push({ fonte: 'GANHOS_EXTRAS', total: ganhos.length, ok: true });
    resultado.produtos_brutos.push(...ganhos);
    logInfo('Ganhos Extras concluído', { total: ganhos.length });
  } catch (err) {
    logError('Falha na coleta de Ganhos Extras', err?.message);
    resultado.fontes.push({ fonte: 'GANHOS_EXTRAS', total: 0, ok: false, erro: err?.message });
  }

  await sleep(settings.delayBetweenFontes);

  // 2. Categorias como complemento
  if (incluirCategorias) {
    for (const cat of settings.categorias) {
      try {
        const prods = await coletarPorCategoria(cat.id, cat.nome);
        resultado.fontes.push({ fonte: cat.nome, total: prods.length, ok: true });
        resultado.produtos_brutos.push(...prods);
        logInfo(`Categoria ${cat.nome} concluída`, { total: prods.length });
      } catch (err) {
        logError(`Falha na categoria ${cat.nome}`, err?.message);
        resultado.fontes.push({ fonte: cat.nome, total: 0, ok: false, erro: err?.message });
      }
      await sleep(settings.delayBetweenFontes);
    }
  }

  return resultado;
}
