'use strict';
// Resolved autoplay candidates are separate from the human queue and never persisted as human requests.
const store=require('./store');
const recommendations=require('./recommendations');
const title=t=>recommendations.base(t?.info?.title); 
const states=new Map();
const key=t=>String(t?.info?.uri||t?.info?.identifier||t?.encoded||'');
function state(gid){let s=states.get(gid);if(!s){s={epoch:0,list:[],excluded:new Set(),excludedTitles:new Set(),excludedRecordings:new Set(),job:null,seed:null,anchor:null,error:null};states.set(gid,s);}return s;}
function enabled(p){return !!store.get(p.guildId).autoplay;}
function invalidate(p){const s=state(p.guildId);s.epoch++;s.list=[];s.seed=null;s.error=null;s.notice=null;return s;}
function manual(p){const s=invalidate(p);s.anchor=null;s.suspended=false;}
function suspend(p){const s=invalidate(p);s.suspended=true;s.error='Suggestions cleared. Add a song, or switch Autoplay off and on to start again.';}
function clear(gid){const s=states.get(gid);if(s)s.epoch++;states.delete(gid);}
function dismiss(p,id,version){const s=state(p.guildId);if(version!==String(s.epoch))return false;const n=s.list.findIndex(x=>x.id===id);if(n<0)return false;if(s.list[n].recording)s.excludedRecordings.add(s.list[n].recording);if(s.excludedRecordings.size>500)s.excludedRecordings.delete(s.excludedRecordings.values().next().value);s.excluded.add(key(s.list[n].track));s.excludedTitles.add(title(s.list[n].track));if(s.excludedTitles.size>500)s.excludedTitles.delete(s.excludedTitles.values().next().value);if(s.excluded.size>500)s.excluded.delete(s.excluded.values().next().value);s.list.splice(n,1);return true;}
function view(p){const s=state(p.guildId);return{version:String(s.epoch),loading:!!s.job&&s.job.epoch===s.epoch,error:s.error,notice:s.notice||null,anchor:s.anchor?{title:s.anchor.info?.title,author:s.anchor.info?.author}:null,tracks:s.list.map(x=>({id:x.id,track:x.track,reason:x.reason}))};}
async function prepare(p,seed,search){
 const s=state(p.guildId);
 if(s.suspended||!enabled(p)||!seed||seed.info?.isStream||p.queue.tracks.length){if(s.list.length)invalidate(p);return;}
 const seedKey=key(seed);if(s.seed===seedKey)return s.job?.promise;
 s.anchor=s.anchor||seed;const anchor=s.anchor;
 s.list=[];s.epoch++;
 s.seed=seedKey;const epoch=s.epoch;const job={epoch};s.job=job;s.error=null;
 job.promise=(async()=>{
  const current=()=>states.get(p.guildId)===s&&s.epoch===epoch&&s.seed===seedKey&&s.job===job&&enabled(p)&&!p.queue.tracks.length;
  const used=new Set([seedKey,...p.queue.tracks.map(key),...(p.queue.previous||[]).map(key),...s.excluded]);
  try{
   const result=await recommendations.recommend(anchor,{current});if(!current())return;
   s.notice='Song-specific radio, not audio mood analysis.'+(result.language?' '+result.language.charAt(0).toUpperCase()+result.language.slice(1)+' catalogue language locked.':' Language not verified.');
   const ranked=[],seen=new Set();
   for(const candidate of result.tracks||[]){
    if(!current())return;
    const recording=candidate.identity||recommendations.base(candidate.title);
    if(!recording||seen.has(recording)||s.excludedRecordings.has(recording)||[seed,anchor,...(p.queue.previous||[])].some(t=>recommendations.contains(t?.info?.title,candidate.title)))continue;
    seen.add(recording);
    try{
     const {res,nodeId}=await search(p.LavalinkManager,'https://www.youtube.com/watch?v='+candidate.id,seed.requester,p.node?.id);if(!current())return;
     const t=(res.tracks||[]).find(t=>recommendations.resolvedMatches(candidate,t));if(!t||used.has(key(t))||s.excludedTitles.has(title(t)))continue;
     // Catalogue artist/title are not inferred from uploader text. The resolved ID must match exactly.
     t.info={...t.info,title:candidate.title,author:candidate.artists.map(a=>a.name).join(', ')};
     const k=key(t);used.add(k);ranked.push({id:require('crypto').createHash('sha256').update(k).digest('hex').slice(0,24),track:t,nodeId,reason:candidate.reason,recording});if(ranked.length>=5)break;
    }catch{if(current())s.error='Some suggested recordings could not be resolved.';}
   }
   if(current()){s.list=ranked;if(!ranked.length)s.error=result.error||'No different playable songs passed the catalogue checks. No search fallback.';}
  }catch{if(current())s.error='Song radio is unavailable. No title-search fallback.';}
  finally{if(s.job===job)s.job=null;}
 })();return job.promise;
}
async function next(p,last,search){
 if(!enabled(p)||p.queue.tracks.length||!last)return;
 const initial=state(p.guildId),work=prepare(p,last,search),generation=initial.epoch;await work;const s=state(p.guildId),epoch=s.epoch;
 if(s!==initial||s.epoch!==generation||(p.queue.current&&key(p.queue.current)!==key(last)))return;
 if(!enabled(p)||p.queue.tracks.length)return;
 const item=s.list.shift();if(!item)return;
 if(item.nodeId&&p.node?.id!==item.nodeId){try{await p.changeNode(item.nodeId);}catch{s.error='The suggested audio source is unavailable.';return;}}
 if(states.get(p.guildId)!==s||s.epoch!==epoch||!enabled(p)||p.queue.tracks.length)return;
 s.excludedRecordings.add(item.recording);if(s.excludedRecordings.size>500)s.excludedRecordings.delete(s.excludedRecordings.values().next().value);
 s.excludedTitles.add(title(item.track));if(s.excludedTitles.size>500)s.excludedTitles.delete(s.excludedTitles.values().next().value);
 s.excluded.add(key(item.track));if(s.excluded.size>500)s.excluded.delete(s.excluded.values().next().value);
 await p.queue.add(item.track);
}
module.exports={prepare,next,manual,suspend,invalidate,dismiss,view,clear,key};
