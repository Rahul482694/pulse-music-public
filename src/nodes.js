'use strict';
// Lavalink v4 nodes tried in order. Node order matters only for the first pick;
// the manager then moves players to the least-loaded healthy node on failure.
// Public free nodes: passwords are the ones those operators publish openly.
// Source lists: https://lavalink.darrennathanael.com/SSL/Lavalink-SSL/
// Override everything with LAVALINK_NODES in .env (JSON array) to use your own.
const DEFAULT_NODES = [
  { id: 'serenetia', host: 'lavalinkv4.serenetia.com', port: 443, authorization: 'https://seretia.link/discord', secure: true },
  { id: 'nazha', host: 'lavalink.nazha.online', port: 443, authorization: 'nazhafreelava', secure: true },
  { id: 'millohost', host: 'lava-v4.millohost.my.id', port: 443, authorization: 'https://discord.gg/mjS5J2K3ep', secure: true },
  { id: 'jirayu', host: 'lavalink.jirayu.net', port: 443, authorization: 'youshallnotpass', secure: true },
  // Added 2026-11-16 (host-verified REST + WebSocket): resolves YouTube/Spotify/Apple/Deezer/JioSaavn/Tidal/direct; no SoundCloud/Qobuz/Bandcamp.
  // TLS-only policy: plain-HTTP nodes expose the Discord voice session token the client forwards over the socket.
  { id: 'vinster', host: 'freelavalinkvinster.in', port: 443, authorization: 'youshallnotpass', secure: true },
];

function loadNodes() {
  let nodes = DEFAULT_NODES;
  if (process.env.LAVALINK_NODES) {
    try {
      const parsed = JSON.parse(process.env.LAVALINK_NODES);
      if (Array.isArray(parsed) && parsed.length) nodes = parsed;
    } catch (e) {
      console.warn('[nodes] LAVALINK_NODES is not valid JSON, using defaults');
    }
  }
  return nodes.map((n) => ({
    secure: true,
    retryAmount: 5,
    retryDelay: 10_000,
    heartBeatInterval: 30_000,
    enablePingOnStatsCheck: true,
    requestSignalTimeoutMS: 12_000,
    closeOnError: true,
    ...n,
  }));
}

module.exports = { DEFAULT_NODES, loadNodes };
