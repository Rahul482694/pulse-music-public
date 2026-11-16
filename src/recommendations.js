'use strict';
// Public song catalogue/radio metadata. No login, key, audio download or user profile.
const norm=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&amp;/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const base=x=>norm(String(x||'').replace(/\([^)]*\)|\[[^\]]*\]/g,'').split(/\b(?:feat|ft)\.?\s/i)[0]).replace(/\b(?:official|audio|video|lyrics|lyric|visualizer|remastered|remaster|music|hd|hq)\b/g,'').trim().replace(/\s+/g,' ');
const edit=/\b(cover|slowed|reverb|sped|speed up|karaoke|nightcore|8d|instrumental version|tribute|snippet|shorts|teaser|tiktok|remix|mashup)\b/i;
const text=x=>x?.runs?.map(r=>r.text).join('')||x?.simpleText||'';
const secs=x=>/^\d+(?::\d{1,2}){1,2}$/.test(x||'')?x.split(':').reduce((n,v)=>n*60+Number(v),0):0;
function collect(x,k,out=[]){if(!x||typeof x!=='object')return out;if(x[k]){out.push(x[k]);return out;}for(const v of Object.values(x))collect(v,k,out);return out;}
function artists(runs){return (runs||[]).filter(r=>r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType==='MUSIC_PAGE_TYPE_ARTIST').map(r=>({name:r.text,id:r.navigationEndpoint.browseEndpoint.browseId}));}
function parse(data,radio=false){return collect(data,radio?'playlistPanelVideoRenderer':'musicResponsiveListItemRenderer').map(r=>{
 const cols=r.flexColumns?.map(c=>c.musicResponsiveListItemFlexColumnRenderer.text)||[];
 const endpoint=radio?r.navigationEndpoint?.watchEndpoint:cols[0]?.runs?.[0]?.navigationEndpoint?.watchEndpoint;
 const runs=radio?r.longBylineText?.runs:cols[1]?.runs;
 return {id:r.videoId||r.playlistItemData?.videoId||endpoint?.videoId,title:text(r.title||cols[0]),artists:artists(runs),duration:secs(text(r.lengthText))||secs((runs||[]).map(r=>r.text).find(t=>/^\d+:\d\d$/.test(t))),type:endpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType,unavailable:!!r.unplayableText};
 }).filter(t=>/^[A-Za-z0-9_-]{11}$/.test(t.id||'')&&t.title&&t.artists.length&&t.type==='MUSIC_VIDEO_TYPE_ATV'&&!t.unavailable&&t.duration>=90&&!edit.test(t.title));}
let nextAt=0;
const cache=new Map();
async function json(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Recommendation metadata unavailable');const raw=await r.text();if(raw.length>4000000)throw Error('Metadata too large');return JSON.parse(raw);}
async function request(endpoint,body){const wait=Math.max(0,nextAt-Date.now());nextAt=Math.max(Date.now(),nextAt)+1000;if(wait)await new Promise(r=>setTimeout(r,wait));return json('https://music.youtube.com/youtubei/v1/'+endpoint,{method:'POST',headers:{'content-type':'application/json','origin':'https://music.youtube.com','user-agent':'Mozilla/5.0'},body:JSON.stringify({context:{client:{clientName:'WEB_REMIX',clientVersion:'1.'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'.01.00',hl:'en'}},...body})});}
async function memo(k,fn){const old=cache.get(k);if(old&&old.until>Date.now())return old.promise;const p=fn();cache.set(k,{until:Date.now()+3600000,promise:p});if(cache.size>120)cache.delete(cache.keys().next().value);try{return await p;}catch(e){cache.delete(k);throw e;}}
function contains(h,n){return !!n&&(' '+norm(h)+' ').includes(' '+norm(n)+' ');}
function canonical(seed,list){const raw=norm(seed.info?.title),author=norm(String(seed.info?.author||'').replace(/\s*-?\s*Topic$/i,'')),duration=(seed.info?.duration??seed.info?.length??0)/1000;
 const ranked=list.map(t=>{const name=base(t.title),at=t.artists.some(a=>norm(a.name).length>=3&&(contains(raw,a.name)||norm(a.name)===author));const titleOK=contains(norm(seed.info?.title),name);const durOK=!duration||Math.abs(duration-t.duration)<Math.max(35,t.duration*.22);return {t,score:titleOK&&at&&durOK?name.length+30:0};}).filter(x=>x.score).sort((a,b)=>b.score-a.score);
 if(!ranked.length)return null;const top=ranked[0].t;if(ranked[1]&&ranked[1].score===ranked[0].score&&base(ranked[1].t.title)!==base(top.title))return null;return top;}
async function language(t){return memo('lang:'+t.id,async()=>{const u=new URL('https://www.jiosaavn.com/api.php');Object.entries({__call:'search.getResults',q:t.title+' '+t.artists[0].name,_format:'json',_marker:'0',api_version:'4',ctx:'web6dot0',n:'5'}).forEach(([k,v])=>u.searchParams.set(k,v));const d=await json(u);const rows=(d.results||[]).filter(x=>base(x.title)===base(t.title)&&!edit.test(x.title)&&Math.abs(Number(x.more_info?.duration)-t.duration)<=15&&(x.more_info?.artistMap?.primary_artists||[]).some(a=>t.artists.some(b=>norm(a.name)===norm(b.name))));const langs=[...new Set(rows.map(x=>norm(x.language)).filter(x=>x&&x!=='unknown'))];return langs.length===1?langs[0]:null;});}
async function recommend(seed,{current=()=>true,fetchLanguage=language}={}){
 const query=String(seed.info?.title||'').replace(/\([^)]*\)|\[[^\]]*\]|#[\w]+/g,'').split('|')[0].slice(0,140)+' '+String(seed.info?.author||'').replace(/ - Topic$/,'');
 const seedSong=await memo('seed:'+norm(query),async()=>canonical(seed,parse(await request('search',{query:query.slice(0,180),params:'EgWKAQIIAWoMEA4QChADEAQQCRAF'}))));
 if(!current())return {tracks:[]};if(!seedSong)return {tracks:[],error:'Could not confidently identify this song in the music catalogue. No title-search fallback.'};
 const radio=await memo('radio:'+seedSong.id,async()=>parse(await request('next',{videoId:seedSong.id,playlistId:'RDAMVM'+seedSong.id,enablePersistentPlaylistPanel:true,isAudioOnly:true,params:'wAEB'}),true));
 if(!current())return {tracks:[]};let lang=null;try{lang=await fetchLanguage(seedSong);}catch{}
 const seen=new Set([base(seedSong.title)]),out=[];
 // Only song-specific radio results. No artist/top-chart/genre search fallbacks.
 for(const t of radio.slice(0,18)){if(!current())return {tracks:[]};const title=base(t.title);if(!title||seen.has(title)||contains(t.title,seedSong.title))continue;seen.add(title);let candidateLang=null;
  if(lang){try{candidateLang=await fetchLanguage(t);}catch{}if(candidateLang!==lang)continue;}
  out.push({...t,language:candidateLang,reason:'Song radio'+(candidateLang?' · '+candidateLang.charAt(0).toUpperCase()+candidateLang.slice(1)+' catalogue':''),identity:title});if(out.length>=10)break;
 }
 return {seed:seedSong,language:lang,tracks:out,error:out.length?null:'No different songs passed catalogue and language checks. No search fallback.'};
}
function resolvedMatches(t,resolved){const i=resolved?.info;if(!i||i.isStream||!resolved.encoded||i.identifier!==t.id||i.sourceName!=='youtube')return false;const d=(i.duration??i.length??0)/1000;return d>=90&&Math.abs(d-t.duration)<=12&&!edit.test(i.title);}
module.exports={recommend,parse,canonical,base,norm,contains,language,resolvedMatches,edit};
