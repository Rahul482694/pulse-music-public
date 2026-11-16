'use strict';
const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const crypto = require('crypto');
const theme = require('./theme');
const suggestions=require('./autoplay');
const recovery = require('./recovery');
const routing = require('./routing');
const { searchAny, orderedNodes } = require('./music');
const sessions = new Map();
const failures = new Map();
const restoring = new Set();
const presentReply=(i,method,payload)=>i[method](theme.present(payload,'recovery')); 
const safe = s => String(s || '').replace(/([*_`~|>\[\]])/g, '\\$1').slice(0, 180);
const privateMessage = text => ({ ...theme.message(text,'warning'), content:'', components: [], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
function rememberSession(i, data, ttl = 120000) {
  const id = crypto.randomBytes(8).toString('hex');
  sessions.set(id, { ...data, user: i.user.id, guild: i.guildId, expires: Date.now() + ttl });
  if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
  return id;
}
const cleanup = setInterval(() => { const now = Date.now(); for (const [k,v] of sessions) if (v.expires < now) sessions.delete(k); for (const [k,v] of failures) if (v.at < now - 86400000) failures.delete(k); }, 60000); cleanup.unref?.();
function recordError(p, track, kind) {
  failures.set(p.guildId, { at: Date.now(), node: p.node?.id || 'unknown', kind: kind === 'stuck' ? 'Playback stalled' : 'Track could not play', track: recovery.ref(track) });
}
async function picker(i, out, player, next) {
  const tracks = out.res.tracks.slice(0, 5);
  const idleCleanup = setTimeout(() => { if (!player.queue.current && !player.queue.tracks.length && !require('./store').get(player.guildId).twentyFourSeven) player.destroy('unused-search').catch(() => {}); }, 125000); idleCleanup.unref?.();
  const id = rememberSession(i, { type: 'pick', tracks, nodeId: out.nodeId, next, voice: player.voiceChannelId });
  const menu = new StringSelectMenuBuilder().setCustomId(`px:pick:${id}`).setPlaceholder('Choose a song to play or queue').addOptions(tracks.map((t,n) => ({ label: String(t.info.title || 'Untitled').slice(0,100), description: `${t.info.author || 'Unknown artist'} | ${t.info.isStream ? 'Live' : Math.round((t.info.duration || 0)/60000)+' min'}`.slice(0,100), value: String(n) })));
  return presentReply(i,'editReply',{ content:'', ...theme.message('Choose the version you want. Nothing has been added yet. This picker expires in 2 minutes.','discovery','Choose your track'), components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } });
}
function canUse(i,p,ctx) { return ctx.isOwner(i) || i.member?.voice?.channel?.id === p.voiceChannelId; }
async function health(i,ctx) {
  const p=ctx.lava.getPlayer(i.guildId), nodes=[...ctx.lava.nodeManager.nodes.values()];
  const e=theme.embed(nodes.every(n=>n.connected)&&nodes.length?'signal':'warning','Pulse health').addFields(
    {name:'Audio servers',value:nodes.map(n=>`${safe(n.id)}: ${n.connected?'connected':'disconnected'}${Number.isFinite(n.heartBeatPing)?` (${Math.round(n.heartBeatPing)} ms)`:''}`).join('\n').slice(0,1024)||'No nodes configured'},
    {name:'Player',value:p?`${safe(p.node?.id)} | ${p.paused?'paused':p.playing?'playing':'idle'} | ${p.queue.tracks.length} queued`:'No active player'},
  );
  const f=failures.get(i.guildId); const components=[];
  e.addFields({name:'Last playback problem (this run)',value:f?`${f.kind} on ${safe(f.node)}\n${safe(f.track?.title || 'Unknown track')}\n<t:${Math.floor(f.at/1000)}:R>`:'None recorded since restart'});
  if(f?.track && Date.now()-f.at<900000){const id=rememberSession(i,{type:'retry',failure:f});components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`px:retry:${id}`).setLabel('Retry failed song (add next)').setStyle(ButtonStyle.Secondary)));}
  e.setFooter({text:'Retry adds the failed song next; it does not interrupt current music. Public audio nodes can fail.'});
  return presentReply(i,'reply',{embeds:[e],components,flags:MessageFlags.Ephemeral});
}
async function resumeQueue(i,ctx) {
  const s=recovery.get(i.guildId); if(!s) return presentReply(i,'reply',privateMessage('No saved queue is available. Queues begin saving after this update.'));
  const p=ctx.lava.getPlayer(i.guildId);
  if(p && !canUse(i,p,ctx)) return presentReply(i,'reply',privateMessage('Join the bot\'s voice channel first.'));
  if(!p && !i.member?.voice?.channel) return presentReply(i,'reply',privateMessage('Join the voice channel where you want to restore the queue.'));
  if(p?.queue.current || p?.queue.tracks.length) return presentReply(i,'reply',privateMessage('There is already music in the player. Restore will not overwrite or duplicate it.'));
  const id=rememberSession(i,{type:'restore',revision:s.revision,snapshot:JSON.parse(JSON.stringify(s))});
  return presentReply(i,'reply',{...theme.message(`Saved queue: ${s.current?`**${safe(s.current.title)}** plus `:''}${s.tracks.length} queued track(s). Saved <t:${Math.floor(s.savedAt/1000)}:R>.\nRestore starts playback only after you press Confirm. Position is best effort; unavailable tracks will be reported.`,'recovery','Review saved queue'),content:'',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`px:restore:${id}`).setLabel('Confirm restore and play').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId(`px:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
}
// Shared entry point, private review/confirm. Durable revision prevents stale restore.
const prompting = new Set();
async function offerRecovery(gid,ctx) {
  if(prompting.has(gid))return;
  const s=recovery.get(gid),p=ctx.lava.getPlayer(gid);
  if(!s || restoring.has(gid) || p?.queue.current || p?.queue.tracks.length)return;
  prompting.add(gid);
  try {
    const ch=await routing.channel(ctx.client,gid,p?.voiceChannelId||s.voiceChannelId);
    if(!ch){console.warn('[recovery] no accessible music channel:',gid);return;}
    const channelId=ch.id;
    if(!ch?.isTextBased?.() || ch.guildId!==gid || typeof ch.send!=='function')return;
    // Reuse an existing prompt rather than sending another after each restart.
    if(s.prompt?.revision===s.revision && s.prompt.channelId===channelId){
      try { const m=await ch.messages.fetch(s.prompt.messageId); if(m.author.id===ctx.client.user.id && m.components?.length)return; }
      catch(e){if(e.code!==10008){console.warn('[recovery] cannot verify existing prompt:',gid,e.code||e.message);return;}}
    }
    const current=recovery.get(gid),live=ctx.lava.getPlayer(gid);
    if(current?.revision!==s.revision || live?.queue.current || live?.queue.tracks.length)return;
    const m=await ch.send({content:'',...theme.message('I saved the interrupted queue. Press the button to review it privately and confirm. No music starts by itself.','recovery','Continue listening?'),components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`px:continue:${s.revision}`).setLabel('Continue listening?').setStyle(ButtonStyle.Primary))],allowedMentions:{parse:[]}});
    if(recovery.get(gid)?.revision!==s.revision || ctx.lava.getPlayer(gid)?.queue.current || ctx.lava.getPlayer(gid)?.queue.tracks.length){await m.delete();return;}
    if(s.prompt && s.prompt.channelId!==channelId){try{const old=await ctx.client.channels.fetch(s.prompt.channelId);const oldMsg=await old.messages.fetch(s.prompt.messageId);if(oldMsg.author.id===ctx.client.user.id)await oldMsg.delete();}catch{}}
    recovery.setPrompt(gid,s.revision,{revision:s.revision,channelId,messageId:m.id});
    console.log('[recovery] continue prompt posted:',gid);
  } catch(e){console.warn('[recovery] could not post prompt:',gid,e.code||e.message);}
  finally{prompting.delete(gid);}
}
async function closeRecoveryPrompt(gid,ctx,snapshot) {
  const s=snapshot || recovery.get(gid);if(!s?.prompt)return false;
  try {
    const ch=await ctx.client.channels.fetch(s.prompt.channelId);
    if(ch?.guildId!==gid)return false;
    const m=await ch.messages.fetch(s.prompt.messageId);
    if(m.author.id!==ctx.client.user.id)return false;
    await m.delete();
  } catch(e) {
    // Unknown message is already gone. Keep the pointer on other failures so cleanup can retry.
    if(e.code!==10008){console.warn('[recovery] could not delete offer:',gid,e.code||e.message);return false;}
  }
  recovery.setPrompt(gid,s.revision,null);
  return true;
}
async function handle(i,ctx) {
  const [,action,id]=i.customId.split(':');
  if(action==='continue'){
    const saved=recovery.get(i.guildId);
    if(!saved || saved.revision!==id)return presentReply(i,'reply',privateMessage('This recovery offer is no longer current. Use /resumequeue to check the latest saved queue.'));
    return resumeQueue(i,ctx);
  }
  const s=sessions.get(id);
  if(!s || s.expires<Date.now() || s.user!==i.user.id || s.guild!==i.guildId) return presentReply(i,'reply',privateMessage('This control expired or belongs to another member. Run the command again.'));
  if(action==='cancel'){sessions.delete(id);return presentReply(i,'update',{content:'Cancelled. No music started.',embeds:[],components:[]});}
  const p=ctx.lava.getPlayer(i.guildId);
  if(p && !canUse(i,p,ctx)) return presentReply(i,'reply',privateMessage('Join the bot\'s voice channel first.'));
  if(action==='pick' && (!p || p.voiceChannelId!==s.voice)) return presentReply(i,'reply',privateMessage('The player moved or disconnected. Run /play again.'));
  if(action==='restore' && (restoring.has(i.guildId)||p?.queue.current||p?.queue.tracks.length)) return presentReply(i,'reply',privateMessage('A queue is already active or being restored. Nothing was replaced.'));
  if(action==='restore' && recovery.get(i.guildId)?.revision!==s.revision) return presentReply(i,'reply',privateMessage('The saved queue changed. Run /resumequeue again to review it.'));
  if(!['pick','retry','restore'].includes(action) || s.type!==({pick:'pick',retry:'retry',restore:'restore'})[action]) return presentReply(i,'reply',privateMessage('Invalid control.'));
  sessions.delete(id);
  await i.deferUpdate();
  const r=await ctx.ensurePlayer(i,{create:true});if(r.error)return presentReply(i,'editReply',{content:r.error,embeds:[],components:[]});
  if(action==='pick'){
    const n=Number(i.values?.[0]);if(!Number.isInteger(n)||!s.tracks[n])return presentReply(i,'editReply',{content:'Invalid song selection.',components:[]});
    await ctx.enqueue(r.player,s.tracks[n],s.next,s.nodeId);
    const destination=await routing.channel(ctx.client,i.guildId,r.player.voiceChannelId);
    const visible=destination?.permissionsFor(i.member)?.has('ViewChannel');
    const result=await presentReply(i,'editReply',{content:`Added **${safe(s.tracks[n].info.title)}**.${visible?` Go to <#${destination.id}> to see the player.`:''}`,embeds:[],components:[]});
    return result;
  }
  if(action==='retry'){
    if(failures.get(i.guildId)!==s.failure || Date.now()-s.failure.at>900000)return presentReply(i,'editReply',{content:'That failure is no longer current. Run /health again.',components:[]});
    const out=await searchAny(ctx.lava,s.failure.track.uri,{id:i.user.id,username:i.user.username},r.player.node?.id);
    if(!out.res.tracks?.length) return presentReply(i,'editReply',{content:'Still unavailable. Nothing added.',components:[]});
    await ctx.enqueue(r.player,out.res.tracks[0],true,out.nodeId);
    return presentReply(i,'editReply',{content:'Added the failed song next. If the player was idle it has started.',components:[]});
  }
  if(!recovery.start(i.guildId))return presentReply(i,'editReply',{content:'Restore already in progress.',components:[]});
  restoring.add(i.guildId);
  const player=r.player, snapshot=s.snapshot, refs=[...(snapshot.current?[snapshot.current]:[]),...snapshot.tracks].slice(0,201);
  const result=new Array(refs.length);let cursor=0,completed=0;const deadline=Date.now()+180000;
  try {
    await presentReply(i,'editReply',{content:`Resolving ${refs.length} saved tracks. This may take a few minutes.`,components:[]});
    await Promise.all(Array.from({length:Math.min(3,refs.length)},async()=>{while(cursor<refs.length&&Date.now()<deadline){const n=cursor++;try{const out=await searchAny(ctx.lava,refs[n].uri,{id:i.user.id,username:i.user.username},player.node?.id);if(out.res.tracks?.[0])result[n]=out;}catch{}completed++;}}));
    // Another member may have added music during the network work. Never overwrite it.
    if(ctx.lava.getPlayer(i.guildId)!==player||player.queue.current||player.queue.tracks.length)return presentReply(i,'editReply',{content:'The player changed while restoring. Nothing replaced; saved queue kept.',components:[]});
    const valid=result.filter(Boolean);if(!valid.length)return presentReply(i,'editReply',{content:'No saved tracks could be resolved. Saved queue kept so you can retry later.',components:[]});
    if(valid[0].nodeId&&player.node?.id!==valid[0].nodeId)await player.changeNode(valid[0].nodeId);
    suggestions.manual(player);
    await player.queue.add(valid.map(x=>x.res.tracks[0]));
    await player.play({paused:!!snapshot.paused});
    await closeRecoveryPrompt(i.guildId,ctx,snapshot);
    let position='';
    if(snapshot.current&&result[0]&&snapshot.position>0){const t=result[0].res.tracks[0];if(!t.info.isStream&&t.info.isSeekable&&snapshot.position<(t.info.duration||0)-1000){try{await player.seek(snapshot.position);position=' Tried the saved position.';}catch{position=' Could not seek to the saved position.';}}}
    await ctx.panel.postPanel(ctx.client,player);
    const missing=refs.length-valid.length;
    return presentReply(i,'editReply',{content:`Restored ${valid.length}/${refs.length} tracks.${missing?` ${missing} unavailable or not resolved before the time limit.`:''}${position}${snapshot.paused?' Restored paused.':''}`,components:[]});
  } finally {restoring.delete(i.guildId);recovery.finish(i.guildId);if(player.queue.current||player.queue.tracks.length)recovery.capture(player);}
}
module.exports={offerRecovery,closeRecoveryPrompt,picker,health,resumeQueue,handle,recordError,recovery,restoring};
