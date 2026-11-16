'use strict';
// Offline/integration checks. No Discord connection is made.
// Talks to the real public Lavalink nodes for search + failover; does NOT test voice playback.
const assert = require('assert');
const { LavalinkManager } = require('lavalink-client');
const { loadNodes } = require('../src/nodes');
const { searchAny, orderedNodes } = require('../src/music');
const { renderCard, fmt } = require('../src/card');
const A = require('../src/actions');

(async () => {
  // 1. formatting + card
  assert.strictEqual(fmt(65000), '1:05');
  assert.strictEqual(fmt(3_725_000), '1:02:05');
  const png = await renderCard({ title: 'T', author: 'A', position: 1000, duration: 60000, volume: 80, loop: 'off' });
  assert.ok(png.length > 5000 && png[0] === 0x89, 'card renders a PNG');
  console.log('ok  card + formatting');

  // 2. failover: first node is dead on purpose
  const nodes = [{ id: 'dead', host: 'dead.invalid', port: 443, authorization: 'x', secure: true, retryAmount: 1, retryDelay: 1000 }, ...loadNodes()];
  const m = new LavalinkManager({ nodes, sendToShard: () => {}, client: { id: '1', username: 'test' }, autoSkip: true });
  const connected = new Set();
  m.nodeManager.on('connect', (n) => connected.add(n.id));
  m.nodeManager.on('error', () => {});
  await m.init({ id: '1', username: 'test' });
  for (let i = 0; i < 40 && connected.size < 2; i++) await new Promise((r) => setTimeout(r, 500));
  console.log('connected nodes:', [...connected].join(', '));
  assert.ok(!connected.has('dead'), 'dead node must not connect');
  assert.ok(connected.size >= 1, 'at least one live node');
  assert.ok(orderedNodes(m).every((n) => n.id !== 'dead'), 'dead node is never used');
  console.log('ok  dead node skipped');

  const cases = [
    ['text search', 'daft punk one more time'],
    ['spotify link', 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8'],
    ['direct https', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
    ['youtube link', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ];
  for (const [label, q] of cases) {
    const { res, nodeId } = await searchAny(m, q, { id: '1', username: 'x' });
    assert.ok(res.tracks.length, `${label} returned tracks`);
    console.log(`ok  ${label} -> "${res.tracks[0].info.title}" via ${nodeId}`);
  }

  // 3. simulate a node dying mid-session: the next search must still work
  const first = orderedNodes(m)[0];
  first.destroy('test', false, false);
  await new Promise((r) => setTimeout(r, 500));
  const { res, nodeId } = await searchAny(m, 'daft punk around the world', { id: '1', username: 'x' });
  assert.ok(res.tracks.length && nodeId !== first.id, 'search continues on another node after one is destroyed');
  console.log(`ok  search after ${first.id} destroyed -> via ${nodeId}`);

  console.log('\nALL OFFLINE CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
