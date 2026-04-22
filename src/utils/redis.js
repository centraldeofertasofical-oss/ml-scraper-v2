// src/utils/redis.js
import Redis from 'ioredis';
import { settings } from '../config/settings.js';

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Redis(settings.redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      lazyConnect: true,
    });

    _client.on('error', (err) => {
      console.error('[Redis] Erro de conexão:', err.message);
    });
  }
  return _client;
}

// ─── Cookies ────────────────────────────────────────────────────────────────

export async function getCookie() {
  const client = getClient();
  const cookie = await client.get(settings.cookieKey);
  if (!cookie) throw new Error(`Cookie "${settings.cookieKey}" não encontrado no Redis`);
  return cookie;
}

export async function setCookie(cookieString) {
  const client = getClient();
  await client.set(settings.cookieKey, cookieString);
}

// ─── Deduplicação 24h ────────────────────────────────────────────────────────

export async function jaPostado(mlbId) {
  if (!mlbId) return false;
  const client = getClient();
  const key = `${settings.dedupePrefix}${mlbId}`;
  const val = await client.get(key);
  return val !== null;
}

export async function marcarPostado(mlbId) {
  if (!mlbId) return;
  const client = getClient();
  const key = `${settings.dedupePrefix}${mlbId}`;
  await client.set(key, '1', 'EX', settings.dedupeTTL);
}

export async function marcarPostadoLote(mlbIds = []) {
  if (!mlbIds.length) return;
  const client = getClient();
  const pipeline = client.pipeline();
  for (const id of mlbIds) {
    if (!id) continue;
    const key = `${settings.dedupePrefix}${id}`;
    pipeline.set(key, '1', 'EX', settings.dedupeTTL);
  }
  await pipeline.exec();
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function pingRedis() {
  try {
    const client = getClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

export async function closeRedis() {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
