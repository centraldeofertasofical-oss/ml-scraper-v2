/**
 * logger.js — Logger simples com timestamp
 */

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function err(...args) {
  console.error(`[${new Date().toISOString()}] ❌`, ...args);
}

module.exports = { log, err };
