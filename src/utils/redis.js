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

async function getCookie() {
  const r = await getClient();
  return await r.get('cookies-mercadolivre') || null;
}

async function setCookie(val) {
  const r = await getClient();
  await r.set('cookies-mercadolivre', val);
}

async function jaPostado(id) {
  const r = await getClient();
  return !!(await r.get(`ml:postado:${id}`));
}

async function marcarPostado(id, ttlHoras) {
  const r = await getClient();
  await r.set(`ml:postado:${id}`, '1', { EX: ttlHoras * 3600 });
}

// Rotação de perfis (0-6)
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

module.exports = { getCookie, setCookie, jaPostado, marcarPostado, getPerfilIndex, avancarPerfilIndex };