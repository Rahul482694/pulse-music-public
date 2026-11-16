'use strict';
// Voice channel status ("Now playing: ...") for the channel the bot is playing in.
// Per server on/off (default OFF until enabled), changed with /vcstatus or the More controls menu.
// Needs the "Set Voice Channel Status" permission in that channel. Updates are coalesced, skipped when the
// text is unchanged, and the status is cleared only if this bot set it (also after a restart).
const { PermissionFlagsBits, Routes } = require('discord.js');
const store = require('./store');
const { st } = require('./state');

const DEBOUNCE_MS = 1500;
const DENY_COOLDOWN_MS = 10 * 60_000;
let client = null;

const enabled = (gid) => store.get(gid).vcStatus === true;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

function textFor(player) {
  const t = player.queue.current;
  if (!t) return null;
  const title = (t.info.title || '').trim() || 'Unknown title';
  return clip(title, 120);
}

async function put(channelId, status) {
  await client.rest.put(Routes.channel(channelId) + '/voice-status', { body: { status }, reason: 'Pulse voice channel status' });
}

function canSet(gid, channelId) {
  const g = client.guilds.cache.get(gid);
  const ch = g?.channels.cache.get(channelId);
  const me = g?.members.me;
  return !!(ch && me && me.permissionsIn(ch).has(PermissionFlagsBits.SetVoiceChannelStatus));
}

function later(gid, fn) {
  const gs = st(gid);
  clearTimeout(gs.vcsTimer);
  gs.vcsTimer = setTimeout(() => { gs.vcsLock = (gs.vcsLock || Promise.resolve()).then(fn).catch((e) => console.warn('[vcstatus]', e.message)); }, DEBOUNCE_MS);
  gs.vcsTimer.unref?.();
}

/** Make the channel status match the player. Safe to call after any change. */
function sync(player) {
  if (!client) return;
  const gid = player.guildId;
  later(gid, async () => {
    const p = client.lavalink.getPlayer(gid);
    const gs = st(gid);
    const text = p && enabled(gid) ? textFor(p) : null;
    if (!text) return clearNow(gid);
    const ch = p.voiceChannelId;
    if (gs.vcsApplied && gs.vcsApplied.c !== ch) await clearNow(gid);
    if (gs.vcsApplied?.c === ch && gs.vcsApplied.t === text) return;
    if (gs.vcsDenied && Date.now() < gs.vcsDenied) return;
    if (!canSet(gid, ch)) { gs.vcsDenied = Date.now() + DENY_COOLDOWN_MS; console.warn(`[vcstatus] ${gid}: missing Set Voice Channel Status permission`); return; }
    try {
      await put(ch, text);
      gs.vcsApplied = { c: ch, t: text };
      gs.vcsDenied = 0;
      store.set(gid, { vcApplied: ch });
    } catch (e) {
      if (e.status === 403 || e.code === 50013) gs.vcsDenied = Date.now() + DENY_COOLDOWN_MS;
      console.warn('[vcstatus] set failed:', e.status, e.code, e.message);
    }
  });
}

async function clearNow(gid) {
  const gs = st(gid);
  const c = gs.vcsApplied?.c || null;
  gs.vcsApplied = null;
  if (!c) return;
  store.set(gid, { vcApplied: null });
  await put(c, '').catch((e) => console.warn('[vcstatus] clear failed:', e.status, e.code));
}

/** Clear the status we set (playback ended, left, disconnected, feature turned off). */
function clear(gid) {
  if (!client) return;
  later(gid, () => clearNow(gid));
}

/** At startup, clear only a persisted bot-owned status that still matches its saved track. */
async function sweep(c) {
  client = c;
  let snapshots = {};
  try { snapshots=JSON.parse(require('fs').readFileSync(require('path').join(process.env.DATA_DIR||require('path').join(__dirname,'..','data'),'queues.json'),'utf8')); } catch {}
  let n=0;
  for(const [gid,g] of Object.entries(store.all())) {
    if(!g.vcApplied)continue;
    const info=await new Promise(resolve=>{
      const finish=value=>{clearTimeout(timer);client.off('raw',onRaw);resolve(value);};
      const onRaw=e=>{if(e.t==='CHANNEL_INFO'&&e.d.guild_id===gid)finish(e.d.channels.find(x=>x.id===g.vcApplied));};
      const timer=setTimeout(()=>finish(null),4000);client.on('raw',onRaw);
      try{client.ws.broadcast({op:43,d:{guild_id:gid,fields:['status']}});}catch{finish(null);}
    });
    const t=snapshots[gid]?.current;
    const base=(t?.title||'')+(t?.author&&!/unknown/i.test(t.author)?' - '+t.author:'');
    const expected=[t?.title,'Now playing: '+base,'Paused: '+base].filter(Boolean).map(x=>clip(x,120));
    if(t&&info&&expected.includes(info.status))await put(g.vcApplied,'').then(()=>{n++;store.set(gid,{vcApplied:null});}).catch(()=>{});
    else if(!info?.status)store.set(gid,{vcApplied:null});
  }
  console.log(`[vcstatus] startup cleanup cleared ${n} verified leftover status(es); enabled servers use title only`);
}

function setEnabled(player, on) {
  store.set(player.guildId, { vcStatus: on });
  if (on) sync(player); else clear(player.guildId);
}

function describe(guildId, player) {
  const on = enabled(guildId);
  let perm = 'unknown until the bot is in a voice channel';
  if (player) perm = canSet(guildId, player.voiceChannelId) ? 'yes' : 'no (give the bot "Set Voice Channel Status" in that channel)';
  return { on, perm };
}

module.exports = { sweep, sync, clear, setEnabled, describe, enabled };
