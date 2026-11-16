'use strict';
require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType, REST, Routes,
} = require('discord.js');
const { defs } = require('./commands');
const { completePlaylist, createManager, orderedNodes, searchAny, markBad, remember } = require('./music');
const A = require('./actions');
const lyrics = require('./lyrics');
const esc = A.esc;
const panel = require('./panel');
const theme = require('./theme');
const suggestions=require('./autoplay');
const store = require('./store');
const routing = require('./routing');
const { st, clear } = require('./state');
const { fmt } = require('./card');

const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
if (!TOKEN) { console.error('DISCORD_TOKEN (or BOT_TOKEN) is missing. Copy .env.example to .env and fill it in.'); process.exit(1); }

const IDLE_LEAVE_MS = 120_000; // leave after queue ends (unless 24/7)
const EMPTY_LEAVE_MS = 60_000; // leave when alone in VC (unless 24/7)

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.lavalink = createManager(client);
const lava = client.lavalink;

client.on('raw', (d) => lava.sendRawData(d).catch(() => {}));

const queueui = require('./queueui');
const profile = require('./profile');
const vcstatus = require('./vcstatus');
const extras = require('./extras');
const recovery = extras.recovery;
const note = (text, kind='music') => theme.message(text,kind);
const err = (text) => ({ ...theme.message(text,'error'), flags: MessageFlags.Ephemeral });
const ephemeral = (text,kind='music') => ({ ...note(text,kind), flags: MessageFlags.Ephemeral, _pulseShared:true });

/* ---------- lifecycle ---------- */
client.once('clientReady', async () => {
  console.log(`[bot] logged in as ${client.user.tag} (${client.user.id}), ${client.guilds.cache.size} server(s)`);
  await require('./icons').init(client);
  await panel.sweepStale(client).catch((e) => console.warn('[panel] cleanup failed:', e.message));
  await lava.init({ id: client.user.id, username: client.user.username });
  for(const gid of client.guilds.cache.keys())await panel.syncGuild(client,gid);
  try {
    const app = await client.application.fetch();
    const o = app.owner; const id = o?.ownerId || o?.id; // Team has ownerId, User has id
    if (id) { ownerIds.add(id); console.log(`[bot] owner controls enabled for ${ownerIds.size} user id(s)`); }
  } catch (e) { console.error('[bot] could not read application owner:', e.message); }
  try {
    const rest = new REST().setToken(TOKEN);
    const route = process.env.DEV_GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, process.env.DEV_GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: defs });
    console.log(`[bot] registered ${defs.length} slash commands${process.env.DEV_GUILD_ID ? ' (dev guild)' : ' (global)'}`);
  } catch (e) { console.error('[bot] command registration failed:', e.message); }
  vcstatus.sweep(client).catch(() => {});
  profile.applyPresence(client); // owner-saved status/activity, default Listening to /play
});

lava.nodeManager.on('connect', (n) => console.log(`[node] ${n.id} connected`));
// On node loss, snapshot every player that was on it, then log what happened after the move,
// so a real failover can be judged from the console (track kept? position kept? queue intact?).
const snap = (p) => ({ guild: p.guildId, node: p.node?.id, track: p.queue.current?.info.title || null, pos: Math.round(p.position / 1000), playing: p.playing, paused: p.paused, queued: p.queue.tracks.length });
lava.nodeManager.on('disconnect', (n, reason) => {
  markBad(n.id);
  console.warn(`[node] ${n.id} disconnected (${reason?.reason || reason?.code || 'unknown'})`);
  const before = [...lava.players.values()].filter((p) => p.node?.id === n.id).map(snap);
  if (!before.length) return;
  console.warn('[failover] before:', JSON.stringify(before));
  for (const ms of [5_000, 20_000]) {
    setTimeout(() => console.warn(`[failover] +${ms / 1000}s after:`, JSON.stringify(before.map((b) => { const p = lava.getPlayer(b.guild); return p ? snap(p) : { guild: b.guild, gone: true }; }))), ms).unref?.();
  }
});
lava.nodeManager.on('error', (n, e) => { markBad(n.id); console.warn(`[node] ${n.id} error: ${e?.message || e}`); });
lava.nodeManager.on('reconnecting', (n) => console.log(`[node] ${n.id} reconnecting`));

// Restore 24/7 players once the first node is up.
let restored = false;
lava.nodeManager.on('connect', async () => {
  if (restored) return;
  restored = true;
  for (const [gid, s] of Object.entries(store.all())) {
    if (!s.twentyFourSeven || !s.voiceChannelId) continue;
    try {
      const guild = await client.guilds.fetch(gid);
      const ch = await guild.channels.fetch(s.voiceChannelId);
      if (!ch) continue;
      const p = lava.createPlayer({ guildId: gid, voiceChannelId: ch.id, textChannelId: s.textChannelId, selfDeaf: false, volume: s.volume ?? 80 });
      await p.connect();
      await panel.syncGuild(client,gid,ch.id);
      console.log(`[24/7] rejoined ${guild.name} / ${ch.name}`);
    } catch (e) { console.warn(`[24/7] could not rejoin ${gid}: ${e.message}`); }
  }
  for (const gid of recovery.ids()) await extras.offerRecovery(gid, extraContext);
});

lava.on('playerPaused', (p) => vcstatus.sync(p));
lava.on('playerResumed', (p) => vcstatus.sync(p));
lava.on('playerMove', (p) => vcstatus.sync(p));
lava.on('trackStart', (player, track) => {
  const saved = recovery.get(player.guildId);
  extras.closeRecoveryPrompt(player.guildId, extraContext, saved).catch(() => {});
  recovery.activate(player);
  vcstatus.sync(player);
  const gs = st(player.guildId);
  clearTimeout(gs.idleTimer);
  remember(player.guildId, track);
  panel.postPanel(client, player);
  suggestions.prepare(player,track,searchAny).then(()=>{if(lava.getPlayer(player.guildId)===player&&player.queue.current)panel.requestRefresh(client,player);}).catch(()=>{});
});
lava.on('trackEnd', (player) => { if (player.repeatMode === 'off') panel.refreshPanel(client, player).catch(() => {}); });
lava.on('queueEnd', async (player) => {
  if (recovery.interrupted.has(player.guildId)) return;
  const saved = recovery.get(player.guildId);
  recovery.discard(player.guildId);
  extras.closeRecoveryPrompt(player.guildId, extraContext, saved).catch(() => {});
  const gs = st(player.guildId);
  await panel.removePanel(player,client);
  const ch = await routing.channel(client, player.guildId, player.voiceChannelId);
  if (store.get(player.guildId).autoplay) { /* autoplay found nothing */ }
  ch?.send?.(note(store.get(player.guildId).twentyFourSeven ? 'Queue finished. Staying in the channel (24/7 is on).' : 'Queue finished. I will leave in 2 minutes if nothing is added.','idle')).then((m) => setTimeout(() => m.delete().catch(() => {}), 30_000)).catch(() => {});
  clearTimeout(gs.idleTimer);
  if (!store.get(player.guildId).twentyFourSeven) {
    gs.idleTimer = setTimeout(() => {
      const p = lava.getPlayer(player.guildId);
      if (p && !p.playing && !p.queue.tracks.length) p.destroy('idle').then(() => clear(player.guildId)).catch(() => {});
    }, IDLE_LEAVE_MS);
  }
});
lava.on('playerDestroy', (player) => { suggestions.clear(player.guildId); clear(player.guildId); panel.syncGuild(client,player.guildId,player.voiceChannelId).catch(() => {}); setTimeout(() => extras.offerRecovery(player.guildId, extraContext), 2000).unref?.(); });

// A real VC disconnect is a lost session, unlike a healthy node failover.
// Disable the library's automatic audio resume (music.js) and rejoin silently.
lava.on('playerDisconnect', (player) => {
  recovery.interrupt(player);
  setTimeout(async () => {
    const gid=player.guildId;
    try {
      if(lava.getPlayer(gid)===player && player.voiceChannelId) { recovery.interrupted.delete(gid); recovery.capture(player); return; } // it already reconnected; do not tear down a healthy session
      if(lava.getPlayer(gid)===player) await player.destroy('recovery-disconnect');
      const saved=recovery.get(gid),settings=store.get(gid);
      if(settings.twentyFourSeven && settings.voiceChannelId && !lava.getPlayer(gid)){
        const p=lava.createPlayer({guildId:gid,voiceChannelId:settings.voiceChannelId,textChannelId:saved?.textChannelId||settings.textChannelId,selfDeaf:false,volume:settings.volume??80});
        await p.connect();console.log('[24/7] quietly rejoined after disconnect:',gid);
      }
    } catch(e){console.warn('[recovery] quiet rejoin failed:',gid,e.message);}
    await extras.offerRecovery(gid,extraContext);
  },1500).unref?.();
});

async function onTrackProblem(player, track, payload, kind) {
  extras.recordError(player, track, kind);
  const nodeId = player.node?.id;
  console.warn(`[track] ${kind} on ${nodeId}: ${track?.info?.title || '?'} ${payload?.exception?.message || ''}`);
  const gs = st(player.guildId);
  const now = Date.now();
  const list = (gs.errors.get(nodeId) || []).filter((t) => now - t < 35_000);
  list.push(now);
  gs.errors.set(nodeId, list);
  if (list.length >= 2) {
    // node keeps failing for this guild: move the player to the best other node
    const other = orderedNodes(lava).find((n) => n.id !== nodeId);
    if (other) {
      markBad(nodeId);
      try { await player.changeNode(other.id); console.log(`[failover] ${player.guildId}: ${nodeId} -> ${other.id}`); } catch (e) { console.warn('[failover] move failed:', e.message); }
    }
  }
  const ch = await routing.channel(client, player.guildId, player.voiceChannelId);
  ch?.send?.(note(`Could not play **${A.esc(track?.info?.title || 'that track')}**. Skipping.`,'warning')).then((m) => setTimeout(() => m.delete().catch(() => {}), 12_000)).catch(() => {});
}
lava.on('trackError', (p, t, pl) => onTrackProblem(p, t, pl, 'error'));
lava.on('trackStuck', (p, t, pl) => onTrackProblem(p, t, pl, 'stuck'));

// Bot moved to another channel or disconnected: drop the old panel (replace it if still playing).
client.on('voiceStateUpdate', (oldS, newS) => {
  if (newS.id !== client.user.id) return;
  const p = lava.getPlayer(newS.guild.id);
  if (!p) return;
  if(oldS.channelId!==newS.channelId)panel.syncGuild(client,newS.guild.id,newS.channelId||oldS.channelId).catch(()=>{});
});

client.on('voiceStateUpdate', (oldS, newS) => {
  const player = lava.getPlayer(oldS.guild.id);
  if (!player) return;
  const chan = oldS.guild.channels.cache.get(player.voiceChannelId);
  if (!chan) return;
  const humans = chan.members.filter((m) => !m.user.bot).size;
  const gs = st(player.guildId);
  clearTimeout(gs.emptyTimer);
  if (humans === 0 && !store.get(player.guildId).twentyFourSeven && !webRemoteActive(player.guildId)) {
    gs.emptyTimer = setTimeout(() => {
      const p = lava.getPlayer(player.guildId);
      const c = p && oldS.guild.channels.cache.get(p.voiceChannelId);
      if (p && c && c.members.filter((m) => !m.user.bot).size === 0 && !webRemoteActive(player.guildId)) p.destroy('empty').then(() => clear(player.guildId)).catch(() => {});
    }, EMPTY_LEAVE_MS);
  }
});

/* ---------- helpers ---------- */
function voiceOf(i) { return i.member?.voice?.channel || null; }

// Owner-only remote control: the Discord application owner (or OWNER_ID / OWNER_IDS env) can use every
// control without sitting in the voice channel. Everyone else still has to be in the bot's channel.
const ownerIds = new Set((process.env.OWNER_IDS || process.env.OWNER_ID || '').split(',').map((x) => x.trim()).filter(Boolean));
const isOwner = (i) => ownerIds.has(i.user?.id);


async function ensurePlayer(i, { create }) {
  const vc = voiceOf(i);
  let player = lava.getPlayer(i.guildId);
  if (player && isOwner(i)) { if (create) player.textChannelId = (await routing.channel(client,i.guildId,player.voiceChannelId))?.id; return { player }; }
  if (!vc) return { error: 'Join a voice channel first.' };
  if (player && player.voiceChannelId !== vc.id) return { error: `I'm already in <#${player.voiceChannelId}>. Join that channel to control me.` };
  if (!player && !create) return { error: 'Nothing is playing. Use `/play` to start.' };
  if (!player) {
    if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(vc.type)) return { error: 'I can only join voice channels.' };
    const perms = vc.permissionsFor(i.guild.members.me);
    if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) return { error: `I need View Channel, Connect and Speak in ${vc}.` };
    if (vc.full && !perms.has(PermissionFlagsBits.MoveMembers)) return { error: 'That voice channel is full.' };
    if (!orderedNodes(lava).length) return { error: 'No audio server is connected right now. Try again in a few seconds.' };
    const destination=await routing.channel(client,i.guildId,vc.id);
    if(!destination || !destination.permissionsFor(i.member)?.has('ViewChannel'))return {error:'Pulse needs an accessible text chat in its VC, or an admin-configured /controlchannel with message permissions.'};
    player = lava.createPlayer({ guildId: i.guildId, voiceChannelId: vc.id, textChannelId: destination.id, selfDeaf: false, volume: store.get(i.guildId).volume ?? 80 });
    await player.connect();
  } else if (create) {
    player.textChannelId = (await routing.channel(client,i.guildId,player.voiceChannelId))?.id;
  }
  return { player };
}

const requesterOf = (i) => ({ id: i.user.id, username: i.member?.displayName || i.user.username });

/* ---------- slash commands ---------- */
async function playCommand(i) {
  const file = i.options.getAttachment('file');
  let query = i.options.getString('query')?.trim();
  if (!query && !file) return i.reply(err('Give me a song name, a link, or upload a file.'));
  if (file) {
    const ok = /^(audio|video)\//.test(file.contentType || '') || /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4|mkv|mov)$/i.test(file.name || '');
    if (!ok) return i.reply(err('That file does not look like audio or video.'));
    query = file.url;
  }
  const r = await ensurePlayer(i, { create: true });
  if (r.error) return i.reply(err(r.error));
  const textSearch = !file && !/^https?:\/\//i.test(query);
  await i.deferReply(textSearch ? { flags: MessageFlags.Ephemeral } : {});
  const player = r.player;
  let out;
  try {
    out = await searchAny(lava, query, requesterOf(i), player.node?.id);
  } catch (e) {
    return i.editReply(err(e.message));
  }
  const { res } = out;
  // A track resolved on another node (plugin sources) should be played by that node.
  if (out.nodeId && player.node?.id !== out.nodeId && !player.playing && !player.queue.tracks.length) {
    await player.changeNode(out.nodeId).catch((e) => console.warn('[play] node switch failed:', e.message));
  }
  if (!res.tracks?.length) {
    if (!player.playing && !player.queue.tracks.length) await player.destroy('noresults').catch(() => {});
    const why = res.loadType === 'error' ? (res.exception?.message || 'The audio server could not load that.') : 'No results. For links, the source may not be supported by the connected audio servers (see `/sources`).';
    return i.editReply(err(why));
  }
  const next = i.options.getBoolean('next');
  if (textSearch && res.loadType !== 'playlist') return extras.picker(i, out, player, next);
  let msg;
  if (res.loadType === 'playlist') {
    let all = res.tracks, expected = res.tracks.length, missing = 0, reported = 0;
    try { ({ tracks: all, expected, missing, reported } = await completePlaylist(lava, query, requesterOf(i), out)); } catch (e) { console.warn('[play] playlist completion failed:', e.message); }
    const tracks = all.slice(0, 200);
    suggestions.manual(player);
    await player.queue.add(tracks, next ? 0 : undefined);
    console.log(`[play] playlist "${res.playlist?.title}" first node ${out.nodeId}: ${res.tracks.length}, merged ${all.length}, expected ${expected} (server-reported total: ${reported || 'none'})`);
    msg = `Added **${tracks.length}** tracks from **${A.esc(res.playlist?.title || 'playlist')}**`;
    if (missing > 0) msg += `\n${missing} of ${expected} tracks could not be loaded by the audio servers. Run /play on the same link again, or add the missing ones by name.`;
    if (all.length > 200) msg += `\nQueue limit is 200, so only the first 200 of ${all.length} were added.`;
  } else {
    const t = res.tracks[0];
    suggestions.manual(player);
    await player.queue.add(t, next ? 0 : undefined);
    msg = player.playing || player.queue.tracks.length > 1 ? `Queued **${A.esc(t.info.title)}** by ${A.esc(t.info.author)}` : `Starting **${A.esc(t.info.title)}**`;
  }
  const wasActive = !!player.queue.current;
  if (!player.playing && !player.paused) await player.play({ paused: false }).catch(async (e) => { await i.editReply(err(`Playback failed: ${e.message}`)); });
  if (wasActive) panel.postPanel(client, player); // queue changed: replace the panel (the old one is deleted)
  await i.editReply({...note(msg,'success'),_pulseShared:true}).catch(() => {});
  recovery.capture(player);
  // The direction note stays private, with no bot deletion timer.
}

async function enqueue(player, track, next, nodeId) {
  suggestions.manual(player);
  if (nodeId && player.node?.id !== nodeId && !player.queue.current && !player.queue.tracks.length) await player.changeNode(nodeId);
  await player.queue.add(track, next ? 0 : undefined);
  if (!player.playing && !player.paused) await player.play({ paused: false });
  recovery.capture(player);
  panel.requestRefresh(client, player);
}
const extraContext = { lava, client, panel, isOwner, ensurePlayer, enqueue };
client.on('shardResume', () => { for(const gid of recovery.ids()) extras.offerRecovery(gid,extraContext).catch(() => {}); });
// Detect an audio node that stays connected while its remote playback clock is frozen.
require('./audio-diagnostics').install({client,lava,recovery,searchAny,panel,store,orderedNodes,markBad});
const checkpoint = setInterval(() => { for (const p of lava.players.values()) recovery.capture(p); }, 15000);
checkpoint.unref?.();

const web = require('./web').createWeb({ client, lava, ownerIds, A, panel, recovery, store, st, searchAny, orderedNodes, enqueue, profile, offerRecovery:gid=>extras.offerRecovery(gid,extraContext) });
function webRemoteActive(guildId) { return (web.remoteUntil.get(guildId) || 0) > Date.now(); }
web.start();

const handlers = {
  async controlchannel(i) {
    const sub=i.options.getSubcommand();
    if(sub!=='view'){
      await i.deferReply({flags:64});
      try{await routing.configure(client,i.guild,i.member,isOwner(i),sub==='reset'?null:i.options.getChannel('channel',true).id);}catch(e){return i.editReply(err(e.message));}
      await panel.syncGuild(client,i.guildId);
      await extras.offerRecovery(i.guildId,extraContext);
    }
    const id=store.get(i.guildId).controlChannelId;
    return (i.deferred?i.editReply.bind(i):i.reply.bind(i))({content:(id?`Music messages will appear in <#${id}>.`:'Music messages will appear in the current VC text chat.'),flags:64});
  },
  async web(i) { return web.loginCommand(i); },
  async dashboard(i) { return web.loginCommand(i); },
  async resumequeue(i) { return extras.resumeQueue(i, extraContext); },
  async health(i) { return extras.health(i, extraContext); },
  play: playCommand,
  async join(i) {
    const r = await ensurePlayer(i, { create: true });
    if (r.error) return i.reply(err(r.error));
    extras.offerRecovery(i.guildId, extraContext).catch(() => {});
    return i.reply(ephemeral(`Joined <#${r.player.voiceChannelId}>. Use \`/play\` to start music.`));
  },
  async leave(i) {
    const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error));
    await A.leave(client, r.player); return i.reply({...note('Left the voice channel.','idle'),_pulseShared:true});
  },
  async pause(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); await r.player.pause(); await panel.refreshPanel(client, r.player); return i.reply(ephemeral('Paused.','paused')); },
  async resume(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); await r.player.resume(); await panel.refreshPanel(client, r.player); return i.reply(ephemeral('Resumed.','success')); },
  async skip(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); await A.skip(r.player); return i.reply(ephemeral('Skipped.')); },
  async previous(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); await A.previous(r.player); return i.reply(ephemeral('Going back.')); },
  async forward(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); const s = i.options.getInteger('seconds') || A.STEP / 1000; const ok = await A.seekBy(r.player, s * 1000); await panel.refreshPanel(client, r.player); return i.reply(ok ? ephemeral(`Forwarded ${s}s.`) : err('Cannot seek in this track.')); },
  async rewind(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); const s = i.options.getInteger('seconds') || A.STEP / 1000; const ok = await A.seekBy(r.player, -s * 1000); await panel.refreshPanel(client, r.player); return i.reply(ok ? ephemeral(`Rewound ${s}s.`) : err('Cannot seek in this track.')); },
  async seek(i) {
    const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error));
    const raw = i.options.getString('time').trim();
    const parts = raw.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0) || parts.length > 3) return i.reply(err('Use a time like `1:30` or `90`.'));
    const sec = parts.reduce((a, n) => a * 60 + n, 0);
    const t = r.player.queue.current;
    if (!t || t.info.isStream || sec * 1000 >= t.info.duration) return i.reply(err('That time is outside this track.'));
    await r.player.seek(sec * 1000); await panel.refreshPanel(client, r.player);
    return i.reply(ephemeral(`Jumped to ${fmt(sec * 1000)}.`));
  },
  async queue(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); return i.reply(queueui.listView(r.player, i.options.getInteger('page') || 1)); },
  async lyrics(i) { return lyricsReply(i, i.options.getString('song')); },
  async nowplaying(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); if (!r.player.queue.current) return i.reply(err('Nothing is playing.')); r.player.textChannelId = (await routing.channel(client,i.guildId,r.player.voiceChannelId))?.id; await i.reply(ephemeral('Here you go.')); return panel.postPanel(client, r.player); },
  async volume(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); const v = await A.setVolume(r.player, i.options.getInteger('percent')); await panel.refreshPanel(client, r.player); return i.reply(ephemeral(`Volume ${v}%.`,'settings')); },
  async loop(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); const m = i.options.getString('mode'); await r.player.setRepeatMode(m); await panel.refreshPanel(client, r.player); return i.reply(ephemeral(`Loop: ${m}.`,'settings')); },
  async shuffle(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); if (r.player.queue.tracks.length < 2) return i.reply(err('Need at least 2 queued tracks.')); await r.player.queue.shuffle(); await panel.postPanel(client, r.player); return i.reply(ephemeral('Shuffled the queue.','queue')); },
  async autoplay(i) { const on = A.toggleAutoplay(i.guildId); const p = lava.getPlayer(i.guildId); if (p) { suggestions.prepare(p,p.queue.current,searchAny).then(()=>panel.requestRefresh(client,p)).catch(()=>{});await panel.refreshPanel(client, p); } return i.reply(ephemeral(`Autoplay is ${on ? 'on' : 'off'}.${on ? ' When the queue ends I will add similar tracks.' : ''}`,'settings')); },
  async '247'(i) {
    const r = await ensurePlayer(i, { create: true }); if (r.error) return i.reply(err(r.error));
    const on = A.toggle247(r.player); await panel.refreshPanel(client, r.player);
    return i.reply(ephemeral(on ? `24/7 is on. I will stay in <#${r.player.voiceChannelId}> and rejoin after restarts.` : '24/7 is off. I leave when idle or alone.','settings'));
  },
  async stop(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); await A.stop(client, r.player); return i.reply(ephemeral('Stopped and cleared the queue.','idle')); },
  async clear(i) { const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error)); suggestions.suspend(r.player);await r.player.queue.splice(0, r.player.queue.tracks.length); await panel.postPanel(client, r.player); return i.reply(ephemeral('Queue cleared.','queue')); },
  async remove(i) {
    const r = await ensurePlayer(i, {}); if (r.error) return i.reply(err(r.error));
    const n = i.options.getInteger('position'); const t = r.player.queue.tracks[n - 1];
    if (!t) return i.reply(err('No track at that position.'));
    await r.player.queue.splice(n - 1, 1); await panel.postPanel(client, r.player);
    return i.reply(ephemeral(`Removed **${A.esc(t.info.title)}**.`,'queue'));
  },
  async sources(i) {
    const nodes = orderedNodes(lava);
    if (!nodes.length) return i.reply(err('No audio server is connected right now.'));
    const all = new Set();
    for (const n of nodes) for (const s of n.info?.sourceManagers || []) all.add(s);
    const list = [...all].filter((s) => !['local'].includes(s)).sort().join(', ');
    return i.reply({ _pulseShared:true, ...theme.message(`**${nodes.length}** audio server${nodes.length === 1 ? '' : 's'} connected. Sources offered by at least one: ${list || 'unknown'}.\n\nSpotify, Apple Music, Deezer and similar links are matched to playable audio from another provider; they are not streamed from those services. Which sources work depends on the connected servers.`,'signal','Audio sources'), flags: MessageFlags.Ephemeral });
  },
  async serverprofile(i) { return profile.serverProfile(i, client); },
  async botprofile(i) { return profile.botProfileView(i, client); },
  async botsettings(i) { return profile.botSettings(i, client, isOwner); },
  async vcstatus(i) {
    const mode = i.options.getString('mode');
    const p = lava.getPlayer(i.guildId);
    if (mode) {
      const allowed = isOwner(i) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || (p && voiceOf(i)?.id === p.voiceChannelId);
      if (!allowed) return i.reply(err(`Join the bot's voice channel or have Manage Server permission to change this.`));
      store.set(i.guildId, { vcStatus: mode === 'on' });
      if (p) { if (mode === 'on') vcstatus.sync(p); else vcstatus.clear(i.guildId); }
      if (p?.queue.current) panel.refreshPanel(client, p);
    }
    const d = vcstatus.describe(i.guildId, p);
    return i.reply(ephemeral([`**Voice channel status:** ${d.on ? 'on' : 'off'} (this server)`, `Bot can set it: ${d.perm}`, '', 'When on, the voice channel status shows only the music title, without a Now playing prefix. `/vcstatus mode:off` turns it off.'].join('\n'),'settings'));
  },
  async ping(i) {
    const t0 = Date.now();
    await i.reply({ embeds: [theme.embed('signal','Measuring latency').setDescription('Measuring...')], flags: MessageFlags.Ephemeral });
    const api = Date.now() - t0;
    const ms = (n) => (Number.isFinite(n) && n >= 0 ? `\`${Math.round(n)} ms\`` : '`n/a`');
    const p = lava.getPlayer(i.guildId);
    const node = p?.node;
    const e = theme.embed('signal','Pulse latency').addFields(
      { name: 'Discord gateway', value: ms(client.ws.ping), inline: true },
      { name: 'Bot response', value: ms(api), inline: true },
      { name: 'Audio server', value: node ? `${node.id}  ${ms(node.heartBeatPing)}` : 'No active player', inline: true },
    );
    if (p?.ping) e.addFields({ name: 'Voice connection', value: `Discord voice ${ms(p.ping.ws)}  ·  server link ${ms(p.ping.lavalink)}` });
    e.setFooter({ text: 'Measured from the bot host, not your own connection' });
    return i.editReply({ _pulseShared:true, embeds: [e] });
  },
  async help(i) {
    const e = theme.embed('discovery','Your Pulse guide')
      .setDescription([
        '`/play` a name to choose from up to 5 results; links and uploads load directly. Controls appear on the player panel.',
        'After an interrupted session, the shared Continue listening? button opens a private recovery review; confirm before it plays. `/resumequeue` is a fallback. `/health` shows audio-node status and the last playback problem.',
        '`/join` `/leave` `/pause` `/resume` `/skip` `/previous` `/forward` `/rewind` `/seek`',
        '`/queue` `/shuffle` `/loop` `/volume` `/autoplay` `/247` `/stop` `/clear` `/remove`',
        '`/lyrics`, `/health`, `/sources`, `/play next:true`, and `/queue` cover the recent shared music tools, also available in the web panel.',
        '`/controlchannel set channel:<channel>` routes shared music results and lyrics there. `/controlchannel reset` follows the current VC text chat. Manage Server or bot-owner permission is required. The same setting is in the web panel.',
        '`/ping` shows latency. `/serverprofile` sets the bot nickname, photo, banner and bio for this server; `/botprofile view` shows the profile for anyone; `/dashboard` opens the web panel, with global edits for the owner and server photo controls for members. `/botsettings view` remains read-only. `/sources` shows what the connected audio servers can play.',
      ].join('\n'));
    return i.reply({ _pulseShared:true, embeds: [e], flags: MessageFlags.Ephemeral });
  },
};


/* ---------- lyrics ---------- */
async function lyricsReply(i, song) {
  const cur = lava.getPlayer(i.guildId)?.queue?.current;
  const q = song ? { title: song, artist: '' } : cur ? { title: cur.info.title, artist: cur.info.author, durationSec: cur.info.isStream ? 0 : cur.info.duration / 1000 } : null;
  const send = (payload) => (i.replied ? i.followUp({ ...payload, flags: MessageFlags.Ephemeral }) : i.editReply(payload));
  if (!q) return i.replied ? send(err('Nothing is playing. Use /lyrics song:<name>.')) : i.reply(err('Nothing is playing. Use /lyrics song:<name>.'));
  if (!i.replied && !i.deferred) await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const r = await lyrics.find(q);
    if (!r) return send({ embeds: [theme.embed('warning','Lyrics unavailable').setDescription(`No lyrics found for **${esc(lyrics.clean(q.title))}**.`)] });
    const body = r.text.length > 3800 ? `${r.text.slice(0, 3800).trimEnd()}\n...` : r.text;
    return send({ _pulseShared:true, embeds: [theme.embed('lyrics',`${r.title} - ${r.artist}`.slice(0, 220)).setDescription(body).setFooter({ text: 'Lyrics via LRCLIB' })] });
  } catch (e) {
    console.error('[lyrics]', e.message);
    return send({ embeds: [theme.embed('warning','Lyrics unavailable').setDescription('Lyrics service is unavailable right now. Try again in a moment.')] });
  }
}

/* ---------- buttons / menu ---------- */
async function control(i, action) {
  const player = lava.getPlayer(i.guildId);
  if(!player?.queue.current){
    if(!['volup','voldown','autoplay'].includes(action))return i.reply(err('Nothing is playing.\nUse /play to play music.'));
    const target=await routing.channel(client,i.guildId,player?.voiceChannelId);
    if(!target||!target.permissionsFor(i.member)?.has('ViewChannel'))return i.reply(err('You cannot access the music-message channel.'));
    if(player&&!isOwner(i)&&voiceOf(i)?.id!==player.voiceChannelId)return i.reply(err(`Join <#${player.voiceChannelId}> to use the controls.`));
    await i.deferUpdate();
    if(action==='autoplay')A.toggleAutoplay(i.guildId);
    else{const current=player?.volume??store.get(i.guildId).volume??80;const volume=Math.min(100,Math.max(0,current+(action==='volup'?10:-10)));if(player)await A.setVolume(player,volume);else store.set(i.guildId,{volume});}
    await panel.syncGuild(client,i.guildId);return;
  }
  // A string-select keeps its tick on the client until the message is updated with fresh components.
  // Acknowledge menu picks by re-sending the panel (no selected option), so any option can be used again at once.
  const viaMenu = i.isStringSelectMenu();
  const reply = (o) => (i.replied || i.deferred ? i.followUp({ ...o, flags: (o.flags || 0) | MessageFlags.Ephemeral }) : i.reply(o));
  const ack = () => (viaMenu ? null : i.deferUpdate());
  if (viaMenu) await i.deferUpdate();
  const vc = voiceOf(i);
  if (action !== 'queue' && action !== 'lyrics' && !isOwner(i) && vc?.id !== player.voiceChannelId) return reply(err(`Join <#${player.voiceChannelId}> to use the controls.`));
  switch (action) {
    case 'lyrics': routing.bind(i,client,lava);return lyricsReply(i);
    case 'queue': return reply(queueui.listView(player, 1));
    case 'pause': await A.pauseToggle(player); break;
    case 'skip': await A.skip(player); break;
    case 'prev': await A.previous(player); break;
    case 'stop': await ack(); return A.stop(client, player);
    case 'loop': await A.loopCycle(player); break;
    case 'shuffle': if (player.queue.tracks.length > 1) await player.queue.shuffle(); break;
    case 'autoplay': A.toggleAutoplay(i.guildId); suggestions.prepare(player,player.queue.current,searchAny).then(()=>panel.requestRefresh(client,player)).catch(()=>{}); break;
    case 'voldown': await A.setVolume(player, player.volume - 10); break;
    case 'volup': await A.setVolume(player, player.volume + 10); break;
    case 'rewind': await A.seekBy(player, -A.STEP); break;
    case 'forward': await A.seekBy(player, A.STEP); break;
    case 'back30': await A.seekBy(player, -30_000); break;
    case 'fwd30': await A.seekBy(player, 30_000); break;
    case 'restart': await player.seek(0); break;
    case 'tfs': A.toggle247(player); break;
    case 'vcs': vcstatus.setEnabled(player, !vcstatus.enabled(i.guildId)); break;
    case 'clear': suggestions.suspend(player);await player.queue.splice(0, player.queue.tracks.length); break;
    case 'leave': await ack(); return A.leave(client, player);
    default: return ack();
  }
  await ack();
  if (player.queue.current) await (action === 'shuffle' || action === 'clear' ? panel.postPanel(client, player) : panel.refreshPanel(client, player));
}

client.on('interactionCreate', async (i) => {
  try {
    if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('px:')) {
      await extras.handle(i, extraContext);
    } else if ((i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('qu:')) {
      await queueui.handle(i, { lava, panel, client, canControl: (x, p) => isOwner(x) || voiceOf(x)?.id === p.voiceChannelId });
    } else if (i.isChatInputCommand()) {
      const h = handlers[i.commandName];
      if (h) {
        if(!['web','dashboard','resumequeue','health','serverprofile','botprofile','botsettings','controlchannel','queue'].includes(i.commandName))routing.bind(i,client,lava);
        await h(i);
      }
    } else if (i.isButton() && i.customId.startsWith('pl:')) {
      await control(i, i.customId.slice(3));
    } else if (i.isStringSelectMenu() && i.customId === 'pl:more') {
      await control(i, i.values[0]);
    }
    const current = lava.getPlayer(i.guildId);
    if (current) recovery.capture(current);
  } catch (e) {
    console.error('[interaction]', i.commandName || i.customId, e);
    const m = err('Something went wrong. Please try again.');
    if (i.deferred || i.replied) i.editReply(m).catch(() => {}); else i.reply(m).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
function saveBeforeExit() { for (const p of lava.players.values()) recovery.capture(p); recovery.flush(); store.flush(); }
process.on('SIGTERM', () => { saveBeforeExit(); process.exit(0); });
process.on('SIGINT', () => { saveBeforeExit(); process.exit(0); });
client.login(TOKEN);
