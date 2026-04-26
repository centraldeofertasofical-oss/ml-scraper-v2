// headers.js — Utilitários de cookie, CSRF e headers

function buildHeaders(cookie, csrfToken) {
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'content-type': 'application/json',
    'origin': 'https://www.mercadolivre.com.br',
    'referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-csrf-token': csrfToken || '',
    'cookie': cookie || '',
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

function extractCsrfFromCookie(cookieStr) {
  const m = (cookieStr || '').match(/_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function extractCsrfFromHtml(html) {
  const htmlStr = String(html || '');

  const meta =
    htmlStr.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i) ||
    htmlStr.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);

  if (meta?.[1]) return meta[1];

  const ctx =
    htmlStr.match(/"csrfToken"\s*:\s*"([^"]+)"/) ||
    htmlStr.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/);

  if (ctx?.[1]) return ctx[1];

  return '';
}

function maskToken(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 10) return `${s.slice(0, 3)}***`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

module.exports = {
  buildHeaders,
  parseCookies,
  extractCsrfFromCookie,
  extractCsrfFromHtml,
  maskToken,
};
