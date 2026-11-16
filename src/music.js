'use strict';
const { LavalinkManager } = require('lavalink-client');
const { loadNodes } = require('./nodes');
const store = require('./store');
const { st } = require('./state');

const BAD_NODE_MS = 90_000;
const badUntil = new Map(); // nodeId -> timestamp until which we avoid it

function createManager(client) {
  const manager = new LavalinkManager({
    nodes: loadNodes(),
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    client: { id: process.env.CLIENT_ID || 'pending', username: 'Pulse' },
    autoSkip: true,
    autoSkipOnResolveError: true,
    autoMove: true, // move players to another node when their node goes down
    emitNewSongsOnly: false,
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      volumeDecrementer: 1,
      clientBasedPositionUpdateInterval: 100,
      onDisconnect: { autoReconnect: false, autoReconnectOnlyWithTracks: false },
      maxErrorsPerTime: { threshold: 35_000, maxAmount: 6 },
      onEmptyQueue: {
        autoPlayFunction: (player, last) => autoplayNext(player, last),
        // no destroyAfterMs: idle leave / 24/7 is handled in index.js
      },
    },
    queueOptions: { maxPreviousTracks: 25 },
  });
  return manager;
}

/** Connected nodes, healthy ones first, then least loaded. */
function orderedNodes(manager, preferId) {
  const now = Date.now();
  const nodes = [...manager.nodeManager.nodes.values()].filter((n) => n.connected);
  return nodes.sort((a, b) => {
    const ab = (badUntil.get(a.id) || 0) > now ? 1 : 0;
    const bb = (badUntil.get(b.id) || 0) > now ? 1 : 0;
    if (ab !== bb) return ab - bb;
    if (preferId) {
      if (a.id === preferId && b.id !== preferId) return -1;
      if (b.id === preferId && a.id !== preferId) return 1;
    }
    // otherwise follow the configured priority order
    return order(manager, a.id) - order(manager, b.id);
  });
}

const _order = new Map();
function order(manager, id) {
  if (!_order.size) loadNodes().forEach((n, i) => _order.set(n.id, i));
  return _order.get(id) ?? 99;
}

function markBad(nodeId) { badUntil.set(nodeId, Date.now() + BAD_NODE_MS); }

const isUrl = (q) => /^https?:\/\//i.test(q.trim());
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

/**
 * Search/resolve a query, trying each connected node in turn.
 * Returns { res, nodeId } where res.loadType is not 'error'/'empty', or the last
 * result if nothing worked.
 */
async function searchAny(manager, query, requester, preferId) {
  const q = query.trim();
  const nodes = orderedNodes(manager, preferId);
  if (!nodes.length) throw new Error('No audio server is connected right now. Try again in a moment.');
  const attempts = isUrl(q) ? [undefined] : ['ytsearch', 'ytmsearch', 'scsearch'];
  let last = null;
  let lastErr = null;
  for (const node of nodes) {
    for (const source of attempts) {
      try {
        const res = await withTimeout(node.search(source ? { query: q, source } : { query: q }, requester), 14_000);
        if (res && res.loadType !== 'error' && res.loadType !== 'empty' && res.tracks?.length) return { res, nodeId: node.id };
        last = res;
        if (res?.loadType === 'error') { markBad(node.id); break; } // node-level problem: next node
      } catch (e) {
        lastErr = e;
        markBad(node.id);
        break;
      }
    }
  }
  if (last) return { res: last, nodeId: null };
  throw lastErr || new Error('Search failed on every audio server.');
}


/**
 * Public Lavalink nodes sometimes return only part of a large Spotify/Apple/Deezer playlist or album
 * (seen for real: one node 100/100, two nodes 98/100, one node 50/100 for the same album).
 * Load a playlist from every connected node, keep the longest list, append any track only another node
 * returned, and report the expected size so a gap is never silent.
 */
async function completePlaylist(manager, query, requester, first) {
  const total = (r) => Number(r?.playlist?.pluginInfo?.totalTracks ?? r?.pluginInfo?.totalTracks) || 0;
  const key = (t) => t.info.uri || t.info.identifier || `${t.info.author}|${t.info.title}`;
  const lists = [first.res.tracks];
  let expected = Math.max(total(first.res), first.res.tracks.length);
  const others = orderedNodes(manager).filter((n) => n.id !== first.nodeId);
  const got = await Promise.all(others.map((n) => withTimeout(n.search({ query: query.trim() }, requester), 30_000).catch(() => null)));
  for (const r of got) {
    if (r?.loadType === 'playlist' && r.tracks?.length) { lists.push(r.tracks); expected = Math.max(expected, total(r), r.tracks.length); }
  }
  lists.sort((a, b) => b.length - a.length);
  // lists[0] (longest) keeps its own order and any repeated entries. A track that only another server
  // returned goes right after the track that preceded it in that server's list, so album/playlist order holds.
  const merged = [...lists[0]];
  const seen = new Set(merged.map(key));
  for (const l of lists.slice(1)) {
    let prev = null;
    for (const t of l) {
      const k = key(t);
      if (!seen.has(k)) {
        const at = prev ? merged.findIndex((m) => key(m) === prev) : -1;
        merged.splice(at + 1, 0, t);
        seen.add(k);
      }
      prev = k;
    }
  }
  expected = Math.max(expected, merged.length);
  return { tracks: merged, expected, missing: expected - merged.length, reported: Math.max(total(first.res), ...got.map((r) => total(r))) };
}

async function autoplayNext(player,last){return require('./autoplay').next(player,last,searchAny);}

function remember(guildId, track) {
  const h = st(guildId).history;
  h.push(track.info.identifier);
  if (h.length > 60) h.shift();
}

module.exports = { completePlaylist, createManager, orderedNodes, searchAny, markBad, autoplayNext, remember };
