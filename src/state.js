'use strict';
// Per-guild runtime state that is not persisted (panel message, timers, history).
const map = new Map();
function st(guildId) {
  let s = map.get(guildId);
  if (!s) {
    s = { panel: null, ticker: null, idleTimer: null, emptyTimer: null, history: [], errors: new Map(), autoplay: undefined };
    map.set(guildId, s);
  }
  return s;
}
function clear(guildId) {
  const s = map.get(guildId);
  if (!s) return;
  clearInterval(s.ticker);
  clearTimeout(s.idleTimer);
  clearTimeout(s.emptyTimer);
  map.delete(guildId);
}
module.exports = { st, clear };
