'use strict';
// Probes every configured Lavalink node: version, source managers, and whether
// sample links/searches RESOLVE to tracks. Resolving is not the same as playing audio
// in Discord (that only fails at playback time, e.g. when a mirrored YouTube stream is blocked).
const { loadNodes } = require('../src/nodes');

const SAMPLES = [
  ['YouTube link', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['YouTube search', 'ytsearch:daft punk one more time'],
  ['YouTube Music search', 'ytmsearch:daft punk one more time'],
  ['Spotify track', 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8'],
  ['Spotify playlist', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
  ['Apple Music track', 'https://music.apple.com/us/song/never-gonna-give-you-up/1559523359'],
  ['SoundCloud link', 'https://soundcloud.com/forss/flickermood'],
  ['SoundCloud search', 'scsearch:flickermood forss'],
  ['Deezer track', 'https://www.deezer.com/track/3135556'],
  ['Deezer search', 'dzsearch:daft punk one more time'],
  ['Qobuz search', 'qbsearch:daft punk one more time'],
  ['Bandcamp search', 'bcsearch:daft punk'],
  ['JioSaavn search', 'jssearch:kesariya'],
  ['Tidal search', 'tdsearch:daft punk one more time'],
  ['Direct https mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
];

async function get(n, path, ms = 15000) {
  const url = `http${n.secure ? 's' : ''}://${n.host}:${n.port}${path}`;
  const r = await fetch(url, { headers: { Authorization: n.authorization }, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 80), status: r.status }; }
}

(async () => {
  const only = process.argv[2];
  for (const n of loadNodes()) {
    if (only && n.id !== only) continue;
    console.log(`\n== ${n.id} (${n.host}:${n.port})`);
    try {
      const info = await get(n, '/v4/info');
      if (!info.sourceManagers) { console.log('  unreachable or unauthorised:', JSON.stringify(info).slice(0, 120)); continue; }
      console.log('  version:', info.version?.semver || '?', '| plugins:', (info.plugins || []).map((p) => p.name).join(', ') || 'none');
      console.log('  sources:', info.sourceManagers.join(', '));
    } catch (e) { console.log('  unreachable:', e.message); continue; }
    for (const [label, id] of SAMPLES) {
      try {
        const r = await get(n, `/v4/loadtracks?identifier=${encodeURIComponent(id)}`);
        const count = Array.isArray(r.data) ? r.data.length : r.data?.tracks ? r.data.tracks.length : r.loadType === 'track' ? 1 : 0;
        const msg = r.loadType === 'error' ? ` (${(r.data?.message || '').slice(0, 60)})` : '';
        console.log(`  ${r.loadType === 'track' || r.loadType === 'playlist' || (r.loadType === 'search' && count) ? 'OK  ' : 'FAIL'} ${label}: ${r.loadType} ${count}${msg}`);
      } catch (e) { console.log(`  FAIL ${label}: ${e.message}`); }
    }
  }
})();
