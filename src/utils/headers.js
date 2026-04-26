/**
 * headers.js — Utilitários de cookie e CSRF
 */

function buildHeaders(cookie, csrfToken) {
  return {
    'accept':             'application/json, text/plain, */*',
    'accept-language':    'pt-BR,pt;q=0.9',
    'content-type':       'application/json',
    'origin':             'https://www.mercadolivre.com.br',
    'referer':            'https://www.mercadolivre.com.br/afiliados/linkbuilder',
    'user-agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'sec-ch-ua':          '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'same-origin',
    'x-csrf-token':       csrfToken || '',
    'cookie':             cookie    || '',
  };
}

function parseCookies(oldStr, setCookieArr) {
  const map = {};
  if (oldStr) {
    oldStr.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      if (k) map[k.trim()] = v.join('=');
    });
  }
  (setCookieArr || []).forEach(c => {
    const [k, ...v] = c.split(';')[0].trim().split('=');
    if (k) map[k.trim()] = v.join('=');
  });
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractCsrf(cookieStr) {
  const m = (cookieStr || '').match(/_csrf=([^;]+)/);
  return m ? m[1] : '';
}

module.exports = { buildHeaders, parseCookies, extractCsrf };
