'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const settings={},timers=new Map();let next=0;
const store={get:g=>settings[g]||{},set:(g,p)=>settings[g]={...settings[g],...p},flush(){}};
const box={module:{exports:{}},require:n=>n==='./store'?store:require(n),setTimeout:(fn,ms)=>{const t={unref(){}};timers.set(t,{fn,ms});return t;},clearTimeout:t=>timers.delete(t)};
vm.runInNewContext(fs.readFileSync(__dirname+'/../src/routing.js','utf8'),box);const R=box.module.exports;
let visible=true,sendable=true,admin=false;const member={id:'u',permissions:{has:()=>admin}};
const guild={id:'g',members:{me:{voice:{channelId:'v'}}},channels:{cache:new Map()}};
const messages=[];
function channel(id,type=0,gid='g') {const ch={id,type,guildId:gid,permissionsFor:m=>({has:()=>m===member?visible:sendable}),async send(body){const m={channelId:id,body,url:'https://discord.com/channels/g/'+id+'/123',deleted:false,async edit(b){this.body=b;return this;},async delete(){this.deleted=true;}};messages.push(m);return m;}};guild.channels.cache.set(id,ch);return ch;}
const vc=channel('v',2),control=channel('control'),general=channel('general'),other=channel('other',0,'other-guild');
const client={guilds:{cache:new Map([['g',guild]])},channels:{cache:guild.channels.cache,fetch:async id=>guild.channels.cache.get(id)}};
function interaction(component=false){const calls=[];const i={guildId:'g',member,user:{id:'u'},channelId:'general',calls,replied:false,deferred:false,message:component?{}:undefined,async reply(p){calls.push(['reply',p]);this.replied=true;},async deferReply(p){calls.push(['defer',p]);this.deferred=true;},async editReply(p){calls.push(['edit',p]);},async followUp(p){calls.push(['follow',p]);return {id:'private-follow-up'};},async deleteReply(id){calls.push(['delete',id]);}};if(component)i.replied=true;return i;}
const lava={getPlayer:()=>({voiceChannelId:'v'})};
(async()=>{
 assert.equal((await R.channel(client,'g')).id,'v');
 await assert.rejects(()=>R.configure(client,guild,member,false,'control'),/Manage Server/);
 admin=true;await R.configure(client,guild,member,false,'control');assert.equal((await R.channel(client,'g')).id,'control');
 await assert.rejects(()=>R.configure(client,guild,member,false,'other'),/Choose/);
 visible=false;await assert.rejects(()=>R.configure(client,guild,member,false,'control'),/Choose/);visible=true;
 sendable=false;assert.equal(await R.channel(client,'g'),null,'never fall back to general or VC on destination permission failure');sendable=true;
 const i=interaction();R.bind(i,client,lava);await i.reply({_pulseShared:true,flags:64,content:'Paused.'});assert.equal(messages.length,1);assert.equal(messages[0].channelId,'control');assert.equal(messages[0].body._pulseShared,undefined);assert.equal(messages[0].body.flags,undefined);assert.equal(i.calls[0][0],'defer');assert.equal(i.calls[0][1].flags,64);
 assert.ok(![...timers.values()].some(t=>t.ms===60000),'private direction notice has no timer');assert.ok(!i.calls.some(x=>x[0]==='delete'));assert.equal(messages[0].deleted,false);
 const before=messages.length;const privateI=interaction();R.bind(privateI,client,lava);await privateI.reply({content:'Denied',flags:64});await privateI.editReply({flags:64,content:'Private error'});assert.equal(messages.length,before);
 const pick=interaction();R.bind(pick,client,lava);await pick.deferReply({});await pick.editReply({content:'Choose',components:[{customId:'private'}]});assert.equal(messages.length,before);assert.equal(pick.calls[0][1].flags,64);
 const menu=interaction(true);R.bind(menu,client,lava);await menu.followUp({_pulseShared:true,flags:64,embeds:[{color:0xe58fbd,description:'Lyrics'}]});assert.equal(messages.length,before+1);assert.equal(menu.calls.length,1);assert.equal(menu.calls[0][0],'follow','component notice must never edit the shared panel');assert.equal(menu.calls[0][1].flags,64);assert.match(menu.calls[0][1].content,/Tap to view it/);
 const hidden=interaction();visible=false;R.bind(hidden,client,lava);await hidden.reply({_pulseShared:true,content:'Result'});visible=true;assert.equal(messages.length,before+1);assert.match(hidden.calls.at(-1)[1].content,/No accessible/);
 await R.configure(client,guild,member,true,null);guild.members.me.voice.channelId='v';assert.equal((await R.channel(client,'g')).id,'v');
 console.log('PASS: VC default, control override/reset, manager/owner gate, destination permission and guild isolation, no general fallback, private ACK and cleanup, no replay/deleting human messages, private errors/picker, component lyrics never edit the player. Discord mocked.');
})().catch(e=>{console.error(e);process.exitCode=1;});
