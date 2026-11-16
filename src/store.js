'use strict';
const fs = require('fs');
const path = require('path');

// Tiny JSON store for per-guild settings (24/7 channel, autoplay, volume).
const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'guilds.json');
let cache = null;
let timer = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}
function get(guildId) { return load()[guildId] || {}; }
function set(guildId, patch) {
  const all = load();
  all[guildId] = { ...(all[guildId] || {}), ...patch };
  clearTimeout(timer);
  timer = setTimeout(flush, 500);
  return all[guildId];
}
function flush() {
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.warn('[store] write failed:', e.message); }
}
function all() { return load(); }
process.on('exit', flush);

module.exports = { get, set, all, flush };
