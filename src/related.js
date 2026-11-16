'use strict';
// Metadata matching, not audio analysis. Keep the human-selected anchor until another human add.
const clean=x=>String(x||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const noise=new Set('the a an and of to from in on with feat ft official audio video lyrics lyric music soundtrack score ost theme main full album hd hq remastered remaster topic original song version extended'.split(' '));
const words=x=>[...new Set(clean(x).split(' ').filter(w=>(w.length>2||/^\d+$/.test(w))&&!noise.has(w)))];
const title=t=>clean(t?.info?.title).replace(/\b(official|audio|video|lyrics|remastered|remaster|hd|hq)\b/g,'').replace(/\s+/g,' ').trim();
function artist(t){let a=clean(t?.info?.author).replace(/\b(topic|official|vevo)\b/g,'').trim();const prefix=String(t?.info?.title||'').split(/\s[-–—]\s/);if(prefix.length>1&&words(prefix[0]).length>=2&&!/\b(topic|vevo|official)\b/i.test(t?.info?.author||'')&&!/\b(theme|soundtrack|score|ost)\b/i.test(prefix.slice(1).join(' ')))a=clean(prefix[0]);return a;}
const moods=['lofi','lo fi','jazz','ambient','piano','instrumental','orchestral','classical','synthwave','electronic','acoustic','chill','downtempo','metal','rock','hip hop','soul','blues','noir'];
function tags(t){const text=clean([t?.info?.title,t?.info?.albumName,t?.pluginInfo?.albumName].join(' '));return moods.filter(m=>(' '+text+' ').includes(' '+m+' '));}
function context(t){return words([t?.info?.albumName,t?.pluginInfo?.albumName,t?.info?.title].filter(Boolean).join(' '));}
function identity(t,anchor){const remove=new Set([...words(artist(anchor)),...context(anchor)]);return words(String(t?.info?.title||'').split(/\s\/\s/)[0].replace(/\([^)]*\)|\[[^\]]*\]/g,'')).filter(w=>!remove.has(w)&&!/^\d{4}$/.test(w)).join(' ');}
function qualify(seed,t,anchor=seed){
 if(!t?.info||t.info.isStream||!t.encoded)return null;
 const duration=t.info.duration??t.info.length;if(duration&&duration<45000)return null;
 const ct=title(t);if(!ct||ct===title(seed)||ct===title(anchor)||!identity(t,anchor))return null;
 const tw=words(ct),sw=words(title(seed)),common=sw.filter(w=>tw.includes(w)).length;const sd=seed.info?.duration??seed.info?.length,td=t.info.duration??t.info.length;if(sw.length>=2&&common/Math.max(sw.length,tw.length)>=0.8&&sd&&td&&Math.abs(td-sd)/sd<0.2)return null;
 const a=artist(anchor),b=artist(t),ctx=context(anchor),all=clean([t.info.title,t.info.author,t.info.albumName,t.pluginInfo?.albumName].join(' '));
 const overlap=ctx.filter(w=>(' '+all+' ').includes(' '+w+' '));
 const sameArtist=!!a&&a.length>=4&&b===a&&!/^(unknown|various artists|soundtrack|music|artist|sample)$/.test(a);
 const album=clean(anchor.info?.albumName||anchor.pluginInfo?.albumName),sameAlbum=album.length>3&&album===clean(t.info?.albumName||t.pluginInfo?.albumName);
 const mood=tags(anchor).filter(x=>tags(t).includes(x));
 // A source mix alone is not evidence of similarity. Require a visible metadata link.
 if(!sameArtist&&!sameAlbum&&overlap.length<2&&!mood.length)return null;
 const conflicts=[['metal','ambient'],['metal','lofi'],['rock','piano'],['hip hop','classical']];for(const[x,y]of conflicts){if((tags(anchor).includes(x)&&tags(t).includes(y))||(tags(anchor).includes(y)&&tags(t).includes(x)))if(!sameArtist&&!sameAlbum)return null;}
 const reason=sameAlbum?'Same album / soundtrack':sameArtist?'Same artist / composer':overlap.length>=2?'Related title / soundtrack':'Shared style: '+mood.join(', ');
 return {score:(sameAlbum?100:0)+(sameArtist?70:0)+overlap.length*12+mood.length*20,reason,identity:identity(t,anchor)};
}
function queries(seed,anchor=seed){const out=[],id=seed.info?.identifier;if(seed.info?.sourceName==='youtube'&&/^[A-Za-z0-9_-]{6,}$/.test(id||''))out.push(`https://www.youtube.com/watch?v=${id}&list=RD${id}`);const album=anchor.info?.albumName||anchor.pluginInfo?.albumName;if(album)out.push(String(album)+' soundtrack');const a=artist(anchor),ctx=context(anchor).slice(0,9).join(' ');out.push([a,ctx].filter(Boolean).join(' '));if(a.length>=4)out.push(a+' '+(tags(anchor).join(' ')||'music'));return [...new Set(out.map(q=>q.slice(0,180)))].slice(0,3);}
module.exports={qualify,queries,title,artist,tags,identity};
