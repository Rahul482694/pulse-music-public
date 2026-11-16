'use strict';
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, AttachmentBuilder,
} = require('discord.js');
const { renderCard, fmt } = require('./card');
const store = require('./store');
const routing = require('./routing');
const { st } = require('./state');
const icons = require('./icons');
const vcs = require('./vcstatus');

const COLOR = 0x5865f2;
const TICK_MS = 30_000; // progress bar refresh interval

function btn(id, emoji, style = ButtonStyle.Secondary, label) {
  const b = new ButtonBuilder().setCustomId(id).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  if (label) b.setLabel(label);
  return b;
}

function components(player) {
  const s = store.get(player.guildId);
  const loop = player.repeatMode;
  const idle=!player.queue.current;
  const seekable=!idle&&!player.queue.current.info.isStream&&!!player.queue.current.info.isSeekable;
  const row1 = new ActionRowBuilder().addComponents(
    btn('pl:prev', icons.get('skip-back', '⏮️')),
    btn('pl:rewind', icons.get('rewind', '⏪'), ButtonStyle.Secondary, '15s'),
    btn('pl:pause', player.paused ? icons.get('play', '▶️') : icons.get('pause', '⏸️'), player.paused ? ButtonStyle.Primary : ButtonStyle.Secondary),
    btn('pl:forward', icons.get('fast-forward', '⏩'), ButtonStyle.Secondary, '15s'),
    btn('pl:skip', icons.get('skip-forward', '⏭️')),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('pl:more')
      .setPlaceholder('More controls')
      .addOptions(
        { label: 'Shuffle queue', value: 'shuffle', emoji: icons.get('shuffle', '🔀') },
        { label: `Loop: ${loop === 'off' ? 'off' : loop}`, value: 'loop', emoji: icons.get(loop === 'track' ? 'repeat-1' : 'repeat', '🔁') },
        { label: `Autoplay: ${s.autoplay ? 'on' : 'off'}`, value: 'autoplay', emoji: icons.get('infinity', '♾️') },
        { label: 'Lyrics', value: 'lyrics', emoji: icons.get('mic-vocal', '🎤') },
        { label: 'Show queue', value: 'queue', emoji: icons.get('list-music', '📜') },
        { label: 'Volume up (+10%)', value: 'volup', emoji: icons.get('volume-2', '🔊') },
        { label: 'Volume down (-10%)', value: 'voldown', emoji: icons.get('volume-1', '🔉') },
        { label: `24/7 mode: ${s.twentyFourSeven ? 'on' : 'off'}`, value: 'tfs', emoji: icons.get('moon', '🌙') },
        { label: `VC status: ${vcs.enabled(player.guildId) ? 'on' : 'off'}`, value: 'vcs', emoji: icons.get('radio', '📻') },
        { label: 'Stop and clear queue', value: 'stop', emoji: icons.get('square', '⏹️') },
        { label: 'Leave voice channel', value: 'leave', emoji: icons.get('log-out', '👋') },
      ),
  );
  for(const b of row1.components)b.setDisabled(idle || (!seekable&&['pl:rewind','pl:forward'].includes(b.data.custom_id)));
  if(idle)row3.components[0].setOptions({label:`Autoplay: ${s.autoplay?'on':'off'}`,value:'autoplay',emoji:icons.get('infinity','♾️')});
  const volumeRow=new ActionRowBuilder().addComponents(btn('pl:voldown',icons.get('volume-1','🔉'),ButtonStyle.Secondary,'Volume -'),btn('pl:volup',icons.get('volume-2','🔊'),ButtonStyle.Secondary,'Volume +'));
  const rows=[row1,volumeRow,row3];
  let saved={};try{saved=JSON.parse(require('fs').readFileSync(require('path').join(process.env.DATA_DIR||require('path').join(__dirname,'..','data'),'web-config.json'),'utf8'));}catch{}
  const base=process.env.WEB_BASE_URL||saved.base||'';
  if (/^https:\/\/[^/]+\/?$/.test(base)) return [...rows,new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open dashboard').setURL(new URL(base).origin+'/'))];
  return rows;
}

// Direct links often have no title tag: fall back to the file name.
function displayTitle(t) {
  const title = t?.info.title;
  if (title && !/^unknown title$/i.test(title)) return title;
  try { return decodeURIComponent(new URL(t.info.uri).pathname.split('/').pop()) || 'Unknown title'; } catch { return 'Unknown title'; }
}

async function view(player,client) {
  const t = player.queue.current;
  const s = store.get(player.guildId);
  const member=client?.guilds.cache.get(player.guildId)?.members.me;
  const botName=member?.displayName||client?.user?.displayName||client?.user?.username||'Pulse';
  const botAvatarUrl=member?.displayAvatarURL?.({extension:'png',size:256})||client?.user?.displayAvatarURL?.({extension:'png',size:256});
  const png = await renderCard({
    idle:!t,botName,botAvatarUrl,
    title: t && displayTitle(t),
    author: t?.info.author,
    artworkUrl: t?.info.artworkUrl,
    sourceName: t?.info.sourceName,sourceUri: t?.info.uri,
    position: t?player.position:0,
    duration: t?.info.duration,
    isStream: t?.info.isStream,
    paused: player.paused,
    volume: player.volume,
    loop: player.repeatMode,
    autoplay: !!s.autoplay,
    twentyFourSeven: !!s.twentyFourSeven,
  });
  const file = new AttachmentBuilder(png, { name: 'player.png',description:!t?`${botName}: not playing. Use /play to play music.`:`${botName}: ${player.paused?'paused':'playing'} ${displayTitle(t)}` });
  const left = player.queue.tracks.length;
  const total = player.queue.tracks.reduce((a, x) => a + (x.info.isStream ? 0 : x.info.duration || 0), 0);
  const who = t?.requester?.id ? `<@${t.requester.id}>` : null;
  const line = [who && `Requested by ${who}`, `Volume \`${player.volume}%\``, left ? `Up next \`${left}\` (${fmt(total)})` : 'Queue empty'].filter(Boolean).join('  ·  ');
  const src = t?.info.uri && /^https?:/.test(t.info.uri) ? `[Track link](<${t.info.uri}>)` : null;
  const content = t?[line, src].filter(Boolean).join('\n'):'Nothing is playing.\nUse **/play** to play music.';
  // No embed box: the rounded card is sent as an image attachment, so the whole player looks round.
  return { content, embeds: [], files: [file], components: components(player), attachments: [], allowedMentions: { parse: [] } };
}

async function channelOf(client, player) {
  return routing.channel(client,player.guildId,player.voiceChannelId);
}

/**
 * Post a fresh panel at the bottom of the channel and delete the previous one.
 * Calls are serialized per guild so two quick changes can never leave two panels behind.
 */
// Keep lifecycle locks outside transient playback state: playerDestroy clears that state.
const locks=new Map(),clients=new Map();
function idlePlayer(guildId,voiceChannelId){const s=store.get(guildId);return {guildId,voiceChannelId,position:0,paused:false,volume:s.volume??80,repeatMode:'off',queue:{current:null,tracks:[]}};}
function postPanel(client,player){return syncGuild(client,player.guildId,player.voiceChannelId);}
function syncGuild(client,guildId,voiceId){
  clients.set(guildId,client);
  const next=(locks.get(guildId)||Promise.resolve()).then(()=>doSync(client,guildId,voiceId)).catch(e=>console.warn('[panel] sync failed:',e.message));
  locks.set(guildId,next);return next;
}
async function doSync(client,gid,voiceId){
  const player=client.lavalink?.getPlayer(gid)||idlePlayer(gid,voiceId);
  const gs=st(gid),ch=await channelOf(client,player);if(!ch?.send)return;
  let old=gs.panel;
  if(!old){const ref=store.get(gid).panelRef;if(ref?.c){const prior=ref.c===ch.id?ch:await client.channels.fetch(ref.c).catch(()=>null);const m=await prior?.messages?.fetch(ref.m).catch(()=>null);if(m?.author?.id===client.user.id)old=m;}}
  const payload=await view(player,client);
  let msg;
  if(old?.channelId===ch.id){try{msg=await old.edit(payload);}catch(e){if(![10008,10003].includes(e.code))throw e;}}
  if(!msg){msg=await ch.send(payload);if(old)await old.delete().catch(()=>{});}
  gs.panel=msg;player.textChannelId=ch.id;store.set(gid,{panelRef:{c:msg.channelId,m:msg.id}});
  clearInterval(gs.ticker);
  if(player.queue.current){startTicker(client,player);vcs.sync(player);}else vcs.clear(gid);
}
function refreshPanel(client,player){return postPanel(client,player);}
function startTicker(client,player){const gs=st(player.guildId);clearInterval(gs.ticker);gs.ticker=setInterval(()=>{const p=client.lavalink.getPlayer(player.guildId);if(!p?.queue.current){clearInterval(gs.ticker);return;}if(!p.paused)refreshPanel(client,p);},TICK_MS);gs.ticker.unref?.();}
async function removePanel(player,client=clients.get(player.guildId)){
  const gs=st(player.guildId);clearInterval(gs.ticker);clearTimeout(gs.refreshTimer);vcs.clear(player.guildId);
  // Stop/disconnect are state transitions, not removal of the room's controller.
  if(client)return syncGuild(client,player.guildId,player.voiceChannelId);
}

/**
 * On startup, remove player panels this bot left behind in an earlier run:
 * the one remembered in the store, plus bot-authored messages among the last 50 in the saved text channel
 * that carry Pulse's own control ids ("pl:"). Only the bot's own player panels are touched.
 */
async function sweepStale(client) {
  let removed = 0;
  for (const [gid, g] of Object.entries(store.all())) {
    const chans = new Set([g.panelRef?.c,g.controlChannelId,g.voiceChannelId,g.textChannelId].filter(Boolean));
    for (const cid of chans) {
      const ch = await client.channels.fetch(cid).catch(() => null);
      if (!ch?.messages) continue;
      const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
      for (const m of recent?.values() || []) {
        if (m.author.id !== client.user.id) continue;
        const ours = m.components?.some((r) => r.components?.some((c) => String(c.customId || '').startsWith('pl:')));
        if (ours && await m.delete().then(() => true).catch(() => false)) removed++;
      }
    }
    if (g.panelRef) store.set(gid, { panelRef: null });
  }
  console.log(`[panel] startup cleanup removed ${removed} old player panel(s)`);
}

// Cosmetic updates must not block an accepted enqueue. Coalesce bursts into one card.
function requestRefresh(client,player){const gs=st(player.guildId);clearTimeout(gs.refreshTimer);gs.refreshTimer=setTimeout(()=>{if(client.lavalink?.getPlayer(player.guildId)===player)postPanel(client,player).catch(e=>console.warn('[panel] deferred refresh failed:',e.message));},250);gs.refreshTimer.unref?.();}
module.exports = { sweepStale, postPanel, refreshPanel, removePanel, view, components, TICK_MS, COLOR, requestRefresh, syncGuild };
