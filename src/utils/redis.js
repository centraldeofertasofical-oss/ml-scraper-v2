/**
 * redis.js — Cliente Redis + funções de estado
 * Inclui sistema de scoring de categorias para aprendizado por execução
 */

const { createClient } = require('redis');
const { settings }     = require('../config/settings');

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

// ─── Deduplicação de produtos ─────────────────────────────────────────────────

async function jaPostado(id) {
  const r = await getClient();
  return !!(await r.get(`ml:postado:${id}`));
}

async function marcarPostado(id, ttlHoras) {
  const r = await getClient();
  await r.set(`ml:postado:${id}`, '1', { EX: ttlHoras * 3600 });
}

// ─── Rotação de perfis ────────────────────────────────────────────────────────

async function getPerfilIndex() {
  const r = await getClient();
  const v = await r.get('ml:perfil_index');
  return v !== null ? parseInt(v) : 0;
}

async function avancarPerfilIndex(total) {
  const r      = await getClient();
  const atual  = await getPerfilIndex();
  const proximo = (atual + 1) % total;
  await r.set('ml:perfil_index', String(proximo));
  return proximo;
}

// ─── Score de categorias (sistema de aprendizado) ─────────────────────────────
//
// A cada execução, cada categoria/origem recebe um score baseado nos
// produtos que ela trouxe (desconto + comissão + destaques).
// O score é acumulado via média móvel exponencial (70% histórico + 30% novo).
// TTL de 7 dias: categorias inativas perdem relevância automaticamente.
//
// Chaves: ml:score_cat:{categoriaId}
// Exemplos: ml:score_cat:MLB1430, ml:score_cat:OFERTA_LIGHTNING

async function getScoreCategoria(categoriaId) {
  const r = await getClient();
  const v = await r.get(`ml:score_cat:${categoriaId}`);
  return v !== null ? parseFloat(v) : 0;
}

async function atualizarScoreCategoria(categoriaId, novoScore) {
  const r      = await getClient();
  const atual  = await getScoreCategoria(categoriaId);

  // Média móvel exponencial: histórico pesa 70%, novo ciclo pesa 30%
  // Evolução gradual — evita oscilação brusca por execuções atípicas
  const atualizado = atual === 0
    ? novoScore
    : (atual * 0.7) + (novoScore * 0.3);

  // TTL 7 dias: categorias que param de trazer resultado somem da memória
  await r.set(
    `ml:score_cat:${categoriaId}`,
    String(atualizado.toFixed(2)),
    { EX: 7 * 24 * 3600 }
  );

  return atualizado;
}

async function getTodosScoresCategorias() {
  const r    = await getClient();
  const keys = await r.keys('ml:score_cat:*');
  const scores = {};
  for (const key of keys) {
    const cat      = key.replace('ml:score_cat:', '');
    scores[cat]    = parseFloat(await r.get(key) || '0');
  }
  return scores;
}

module.exports = {
  getCookie,
  setCookie,
  jaPostado,
  marcarPostado,
  getPerfilIndex,
  avancarPerfilIndex,
  getScoreCategoria,
  atualizarScoreCategoria,
  getTodosScoresCategorias,
};
