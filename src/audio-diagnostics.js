'use strict';
// Host-only diagnostics. Never store voice tokens, node session IDs or user credentials.
const fs=require('fs'),path=require('path');
function install({client,lava,recovery,searchAny,panel,store,orderedNodes,markBad}){
 const dir=process.env.DATA_DIR||path.join(__dirname,'..','data');
 let busy=false;
 const clocks=new Map();
 async function sample(){if(busy)return;busy=true;try{const players=[];for(const p of lava.players.values()){
 const v=client.guilds.cache.get(p.guildId)?.members.me?.voice;
 let remote;const sampledNode=p.node,sampledTrack=p.queue.current;try{const n=sampledNode;const r=await n.request('/sessions/'+n.sessionId+'/players/'+p.guildId);remote={position:r?.state?.position,time:r?.state?.time,connected:r?.state?.connected,ping:r?.state?.ping,paused:r?.paused,volume:r?.volume,track:r?.track?.info?.title,filters:r?.filters};}catch(e){remote={error:e.message};}
 if(p.node.id!==sampledNode.id||p.queue.current!==sampledTrack)continue;
 await checkStall(p,remote);
 players.push({guild:p.guildId,node:p.node?.id,playing:p.playing,paused:p.paused,position:p.position,volume:p.volume,current:p.queue.current?.info?.title,queued:p.queue.tracks.length,voice:{channel:v?.channelId,serverMute:v?.serverMute,serverDeaf:v?.serverDeaf,selfMute:v?.selfMute,selfDeaf:v?.selfDeaf,suppress:v?.suppress},remote});}
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'audio-diagnostics.json'),JSON.stringify({at:Date.now(),players}),{mode:0o600});
 }catch(e){console.warn('[audio-diagnostics]',e.message);}finally{busy=false;}}
 async function checkStall(p,remote){
  if(!p.queue.current||p.paused||!p.playing||!remote.connected||remote.paused||!Number.isFinite(remote.position)){clocks.delete(p.guildId);return;}
  const key=p.node.id+':'+(p.queue.current.info?.uri||p.queue.current.encoded);let c=clocks.get(p.guildId);
  if(!c||c.key!==key||Math.abs(remote.position-c.position)>500){clocks.set(p.guildId,{key,position:remote.position,at:Date.now(),tried:c?.key===key?c.tried:new Set()});return;}
  if(Date.now()-c.at<45000)return;
  c.tried.add(p.node.id);const other=(orderedNodes?orderedNodes(lava):[...lava.nodeManager.nodes.values()]).find(n=>n.connected&&!c.tried.has(n.id));
  c.at=Date.now();if(!other)return;
  const before=p.node.id;console.warn('[audio-stall] connected voice but frozen remote clock on '+before+'; moving same queue to '+other.id);
  markBad?.(before);try{await p.changeNode(other.id);}catch(e){c.tried.add(other.id);markBad?.(other.id);throw e;}recovery.capture(p);clocks.set(p.guildId,{key:other.id+':'+(p.queue.current.info?.uri||p.queue.current.encoded),position:remote.position,at:Date.now(),tried:c.tried});
 }
 const timer=setInterval(sample,15000);timer.unref();
 console.log('[audio-stall] remote-clock guard active: checks every15s, frozen threshold45s');
 // One-time operator repair of the same explicitly active listening session.
 const repairFile=path.join(dir,'audio-repair.json');let started=false;
 const repair=async()=>{if(started||!fs.existsSync(repairFile))return;let req;try{req=JSON.parse(fs.readFileSync(repairFile));}catch{return;}const p=lava.getPlayer(req.guild);if(!p||!p.node?.connected)return;started=true;fs.renameSync(repairFile,repairFile+'.consumed');
 try{const saved=recovery.get(req.guild);if(!saved?.current||p.queue.current||p.queue.tracks.length||(req.revision&&saved.revision!==req.revision))return;
 const snapshot=saved;
 const out=await searchAny(lava,saved.current.uri,{id:client.user.id,username:client.user.username},req.preferNode);if(!out.res?.tracks?.length)throw Error('saved current track unavailable');
 if(out.nodeId&&out.nodeId!==p.node.id)await p.changeNode(out.nodeId);
 const tracks=[out.res.tracks[0]];for(const ref of saved.tracks||[]){const x=await searchAny(lava,ref.uri,{id:client.user.id,username:client.user.username},p.node.id);if(!x.res?.tracks?.[0])throw Error('queued track unavailable; original journal retained');tracks.push(x.res.tracks[0]);}
 if(lava.getPlayer(req.guild)!==p||p.queue.current||p.queue.tracks.length)throw Error('player changed while resolving; nothing replaced');
 await p.queue.add(tracks);if(['off','track','queue'].includes(req.repeatMode))await p.setRepeatMode(req.repeatMode);await p.play({paused:!!saved.paused});const position=Number.isFinite(req.positionMs)?req.positionMs:saved.position;if(position>0&&tracks[0].info.isSeekable)await p.seek(Math.min(position,tracks[0].info.duration-1000));
 await extrasClose(p.guildId,snapshot);await panel.syncGuild(client,p.guildId);recovery.capture(p);console.log('[audio-repair] same saved listening session resumed on '+p.node.id);
 }catch(e){console.warn('[audio-repair]',e.message);}await sample();};
 async function extrasClose(gid,snapshot){try{await require('./extras').closeRecoveryPrompt(gid,{client},snapshot);}catch(e){console.warn('[audio-repair] recovery offer cleanup:',e.message);}}
 const rt=setInterval(repair,3000);rt.unref();
 return {sample};
}
module.exports={install};
