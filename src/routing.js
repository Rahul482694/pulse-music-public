'use strict';
const store = require('./store');
const REQUIRED = ['ViewChannel','SendMessages','EmbedLinks','AttachFiles','ReadMessageHistory'];
function canManage(member, owner=false) { return owner || !!member?.permissions?.has('ManageGuild'); }
function valid(ch, guild, member) {
  return !!ch && ch.guildId===guild.id && [0,2].includes(ch.type) && typeof ch.send==='function' &&
    !!ch.permissionsFor(guild.members.me)?.has(REQUIRED) && (!member || !!ch.permissionsFor(member)?.has('ViewChannel'));
}
async function channel(client, gid, voiceId, settings=store.get(gid)) {
  const guild=client.guilds.cache.get(gid); if(!guild)return null;
  const id=settings.controlChannelId || guild.members.me?.voice?.channelId || voiceId || settings.voiceChannelId;
  if(!id)return null;
  const ch=guild.channels.cache.get(id) || await client.channels?.fetch(id).catch(()=>null);
  return valid(ch,guild) ? ch : null;
}
async function configure(client, guild, member, owner, id, settingsStore=store) {
  if(!canManage(member,owner))throw Error('Manage Server permission or bot ownership is required to change the control channel.');
  if(id!==null){
    const ch=guild.channels.cache.get(id) || await client.channels.fetch(id).catch(()=>null);
    if(!valid(ch,guild,member))throw Error('Choose a text or voice-chat channel you can view. Pulse needs View Channel, Send Messages, Embed Links, Attach Files and Read Message History there.');
  }
  settingsStore.set(guild.id,{controlChannelId:id});settingsStore.flush?.();
}
// Only explicitly marked music results can be made shared. Private pickers,
// errors, profiles, login links and recovery confirmations are never forwarded.
function bind(i, client, lava) {
  if(i.__pulseRouting)return;
  i.__pulseRouting=true;
  const raw={};for(const k of ['reply','deferReply','editReply','followUp'])raw[k]=i[k].bind(i);
  let shared=null;
  const clean=p=>{const q=typeof p==='string'?{content:p}:{...p};delete q._pulseShared;delete q.flags;delete q.ephemeral;delete q.fetchReply;delete q.withResponse;return {...q,allowedMentions:{parse:[]}};};
  async function publish(p){
    if(!i.replied&&!i.deferred)await raw.deferReply({flags:64});
    const player=lava.getPlayer(i.guildId);
    const ch=await channel(client,i.guildId,player?.voiceChannelId||i.member?.voice?.channelId);
    if(!ch || !ch.permissionsFor(i.member)?.has('ViewChannel'))return (i.message?raw.followUp:raw.editReply)({flags:64,content:'No accessible music-message destination. Ask an admin to check /controlchannel, or Pulse permissions in its voice chat.',embeds:[],components:[]});
    try {
      const body=clean(p);
      shared=shared?.channelId===ch.id ? await shared.edit(body) : await ch.send(body);
      const notice={content:`Your result is in <#${ch.id}>, not in this response.${shared.url?' [Tap to view it]('+shared.url+').':''}`,embeds:[],components:[],allowedMentions:{parse:[]}};
      if(i.message)await raw.followUp({...notice,flags:64});else await raw.editReply(notice);
      if(!p.embeds?.some(e=>(e.data||e).color===0xe58fbd)){const sent=shared;setTimeout(()=>sent.delete().catch(()=>{}),90000).unref?.();}
      return shared;
    }catch(e){await (i.message?raw.followUp:raw.editReply)({flags:64,content:'Could not post to the music channel. Check Pulse permissions and try again.',embeds:[],components:[]});throw e;}
  }
  i.deferReply=(p={})=>raw.deferReply({...p,flags:64});
  for(const k of ['reply','editReply','followUp'])i[k]=async(p)=>{
    if(p?._pulseShared && !p?.components?.length)return publish(p);
    const q={...(typeof p==='string'?{content:p}:p)};delete q._pulseShared;
    if(k==='editReply')return raw.editReply(q);
    return raw[k]({...q,flags:64});
  };
}
module.exports={REQUIRED,canManage,valid,channel,configure,bind};
