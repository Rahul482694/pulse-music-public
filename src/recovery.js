'use strict';
// Small, host-only queue journal. No audio bytes, tokens or transient stream URLs.
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'queues.json');
let cache;
const busy = new Set();
const suppressed = new Set();
const interrupted = new Set();
function all() {
  if (cache) return cache;
  try { const x = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { cache = {}; }
  return cache;
}
function flush() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(all())); fs.renameSync(FILE + '.tmp', FILE); }
  catch (e) { console.warn('[recovery] save failed:', e.code || 'write error'); }
}
function ref(t) {
  if (!t?.info) return null;
  const uri = t.info.uri;
  if (!/^https?:\/\//i.test(uri || '')) return null;
  return { uri: uri.slice(0, 2048), title: String(t.info.title || 'Untitled').slice(0, 200), author: String(t.info.author || '').slice(0, 100) };
}
function capture(p) {
  if (!p || busy.has(p.guildId) || suppressed.has(p.guildId) || interrupted.has(p.guildId)) return;
  const current = ref(p.queue.current);
  const tracks = p.queue.tracks.slice(0, 200).map(ref).filter(Boolean);
  if (!current && !tracks.length) return; // an empty startup 24/7 rejoin must not erase recovery
  const old = all()[p.guildId];
  const signature = JSON.stringify([current?.uri, tracks.map(t => t.uri)]);
  const revision = old?.signature === signature ? old.revision : require('crypto').randomBytes(8).toString('hex');
  all()[p.guildId] = { revision, signature, savedAt: Date.now(), voiceChannelId: p.voiceChannelId, textChannelId: p.textChannelId || old?.textChannelId, prompt: old?.revision === revision ? old.prompt : null, current, tracks, position: Math.max(0, Math.round(p.position || 0)), paused: !!p.paused };
  flush();
}
function get(gid) { return all()[gid] || null; }
function discard(gid) { suppressed.add(gid); delete all()[gid]; flush(); }
function activate(p) { interrupted.delete(p.guildId); suppressed.delete(p.guildId); capture(p); }
function interrupt(p) { capture(p); if (get(p.guildId) && !suppressed.has(p.guildId)) interrupted.add(p.guildId); }
function setPrompt(gid, revision, prompt) { const s=get(gid); if(s?.revision!==revision)return; s.prompt=prompt; flush(); }
function start(gid) { if (busy.has(gid)) return false; busy.add(gid); return true; }
function finish(gid) { busy.delete(gid); }
module.exports = { interrupted, interrupt, setPrompt, ids: () => Object.keys(all()), activate, capture, get, discard, start, finish, ref, flush };
