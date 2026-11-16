'use strict';
// Lyrics from LRCLIB (https://lrclib.net): free, no API key. Plain text only.
const UA = 'Pulse-Discord-Bot (private project)';

function clean(s = '') {
  return s
    .replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali[sz]er|remaster|hd|4k|mv|live)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*topic$/i, '').replace(/\s*(ft\.|feat\.).*$/i, '').replace(/\s+/g, ' ').trim();
}

async function api(path) {
  const r = await fetch(`https://lrclib.net/api/${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`LRCLIB ${r.status}`);
  return r.json();
}

/** Find plain lyrics. Returns { title, artist, text } | null. */
async function find({ title, artist, durationSec }) {
  const t = clean(title); const a = clean(artist);
  const q = new URLSearchParams({ track_name: t, artist_name: a });
  if (durationSec) q.set('duration', String(Math.round(durationSec)));
  let hit = null;
  try { hit = await api(`get?${q}`); } catch { /* fall through to search */ }
  if (!hit || !hit.plainLyrics) {
    const list = await api(`search?q=${encodeURIComponent(`${a} ${t}`.trim())}`);
    hit = (list || []).find((x) => x.plainLyrics) || null;
    if (!hit) { const l2 = await api(`search?q=${encodeURIComponent(t)}`); hit = (l2 || []).find((x) => x.plainLyrics) || null; }
  }
  if (!hit || !hit.plainLyrics) return null;
  return { title: hit.trackName, artist: hit.artistName, text: hit.plainLyrics.trim() };
}

module.exports = { find, clean };
