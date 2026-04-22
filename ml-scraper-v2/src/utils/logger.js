// src/utils/logger.js
export function logInfo(msg, data = null) {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] INFO  ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] INFO  ${msg}`);
  }
}

export function logError(msg, err = null) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR ${msg}`, err || '');
}

export function logWarn(msg, data = null) {
  const ts = new Date().toISOString();
  if (data) {
    console.warn(`[${ts}] WARN  ${msg}`, JSON.stringify(data));
  } else {
    console.warn(`[${ts}] WARN  ${msg}`);
  }
}
