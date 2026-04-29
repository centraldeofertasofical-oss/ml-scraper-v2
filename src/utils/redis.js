/**
 * redis.js — Cliente Redis + funções de estado
 * V4:
 * - Cookie ML
 * - Deduplicação de produto
 * - Rotação de perfis
 * - Score de categorias
 * - Score de keywords
 * - Bloqueio temporário por família de produto
 */

const { createClient } = require('redis');
const { settings } = require('../config/settings');

let client = null;

async function getClient() {
  if (client && client.isOpen) return client;

  client = createClient({ url: settings.REDIS_URL });
  client.on('error', (e) => console.error('[Redis]', e.message));

  await client.connect();
  return client;
}

// ─── Cookie ML ───────────────────────────────────────────────────────────────

async function getCookie() {
  const r = await getClient();
  return await r.get('cookies-mercadolivre') || null;
}

async function setCookie(val) {
  const r = await getClient();
  await r.set('cookies-mercadolivre', val);
}

// ─── Deduplicação de produtos ────────────────────────────────────────────────

async function jaPostado(id) {
  const r = await getClient();
  return !!(await r.get(`ml:postado:${id}`));
}

async function marcarPostado(id, ttlHoras) {
  const r = await getClient();
  await r.set(`ml:postado:${id}`, '1', { EX: ttlHoras * 3600 });
}

// ─── Bloqueio temporário por família ─────────────────────────────────────────

async function jaPostouFamilia(familia) {
  const r = await getClient();
  return !!(await r.get(`ml:familia_postada:${familia}`));
}

async function marcarFamiliaPostada(familia, ttlHoras = 6) {
  const r = await getClient();
  await r.set(`ml:familia_postada:${familia}`, '1', { EX: ttlHoras * 3600 });
}

async function getFamiliasPostadasRecentes() {
  const r = await getClient();
  const keys = await r.keys('ml:familia_postada:*');

  return keys.map(k => k.replace('ml:familia_postada:', ''));
}

// ─── Rotação de perfis ───────────────────────────────────────────────────────

async function getPerfilIndex() {
  const r = await getClient();
  const v = await r.get('ml:perfil_index');
  return v !== null ? parseInt(v) : 0;
}

async function avancarPerfilIndex(total) {
  const r = await getClient();
  const atual = await getPerfilIndex();
  const proximo = (atual + 1) % total;

  await r.set('ml:perfil_index', String(proximo));
  return proximo;
}

// ─── Score de categorias ─────────────────────────────────────────────────────

async function getScoreCategoria(categoriaId) {
  const r = await getClient();
  const v = await r.get(`ml:score_cat:${categoriaId}`);
  return v !== null ? parseFloat(v) : 0;
}

async function atualizarScoreCategoria(categoriaId, novoScore) {
  const r = await getClient();
  const atual = await getScoreCategoria(categoriaId);

  const atualizado = atual === 0
    ? novoScore
    : (atual * 0.7) + (novoScore * 0.3);

  await r.set(
    `ml:score_cat:${categoriaId}`,
    String(atualizado.toFixed(2)),
    { EX: 7 * 24 * 3600 }
  );

  return atualizado;
}

async function getTodosScoresCategorias() {
  const r = await getClient();
  const keys = await r.keys('ml:score_cat:*');
  const scores = {};

  for (const key of keys) {
    const cat = key.replace('ml:score_cat:', '');
    scores[cat] = parseFloat(await r.get(key) || '0');
  }

  return scores;
}

// ─── Score de keywords — V4 aprendizado ──────────────────────────────────────

function normalizarKeywordKey(keyword) {
  return String(keyword || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

async function getScoreKeyword(keyword) {
  const r = await getClient();
  const key = normalizarKeywordKey(keyword);
  const v = await r.get(`ml:score_kw:${key}`);
  return v !== null ? parseFloat(v) : 0;
}

async function atualizarScoreKeyword(keyword, novoScore) {
  const r = await getClient();
  const key = normalizarKeywordKey(keyword);

  if (!key) return 0;

  const atual = await getScoreKeyword(keyword);

  const atualizado = atual === 0
    ? novoScore
    : (atual * 0.65) + (novoScore * 0.35);

  await r.set(
    `ml:score_kw:${key}`,
    String(atualizado.toFixed(2)),
    { EX: 10 * 24 * 3600 }
  );

  return atualizado;
}

async function getTodosScoresKeywords() {
  const r = await getClient();
  const keys = await r.keys('ml:score_kw:*');
  const scores = {};

  for (const key of keys) {
    const kw = key.replace('ml:score_kw:', '');
    scores[kw] = parseFloat(await r.get(key) || '0');
  }

  return scores;
}

module.exports = {
  getCookie,
  setCookie,

  jaPostado,
  marcarPostado,

  jaPostouFamilia,
  marcarFamiliaPostada,
  getFamiliasPostadasRecentes,

  getPerfilIndex,
  avancarPerfilIndex,

  getScoreCategoria,
  atualizarScoreCategoria,
  getTodosScoresCategorias,

  getScoreKeyword,
  atualizarScoreKeyword,
  getTodosScoresKeywords,
};
