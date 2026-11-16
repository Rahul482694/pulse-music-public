'use strict';
// Dependency-free web panel. Discord OAuth secrets remain host-only. Never log tokens or callbacks.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const routing=require('./routing');
const random = () => crypto.randomBytes(32).toString('hex');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TTL = 30 * 24 * 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
function createWeb(ctx, config = {}) {
  const {client, lava, ownerIds, A, panel, recovery, store, st, searchAny, orderedNodes, enqueue, profile} = ctx;
  let saved={};try{saved=JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR||path.join(__dirname,'..','data'),'web-config.json'),'utf8'));}catch{}
  const base = config.base || process.env.WEB_BASE_URL || saved.base || '';
  const enabled = /^https:\/\/[^/]+\/?$/.test(base);
  const origin = enabled ? new URL(base).origin : '';
  const sessions = new Map(), searches = new Map(), limits = new Map(), busy = new Set(), addRequests=new Map(),searchCache=new Map();
  const suggestions=ctx.suggestions||require('./autoplay');
  const lyrics=ctx.lyrics||require('./lyrics');
  const repaint=p=>{if(panel.requestRefresh)panel.requestRefresh(client,p);else Promise.resolve().then(()=>panel.refreshPanel(client,p)).catch(()=>{});};
  const sessionFile=config.sessionFile||(config.test?null:path.join(process.env.DATA_DIR||path.join(__dirname,'..','data'),'.web-sessions.json'));
  let sessionKey=null;
  if(sessionFile){const keyFile=sessionFile+'.key';try{fs.mkdirSync(path.dirname(sessionFile),{recursive:true,mode:0o700});if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,crypto.randomBytes(32),{mode:0o600,flag:'wx'});fs.chmodSync(keyFile,0o600);sessionKey=fs.readFileSync(keyFile);if(sessionKey.length!==32)throw Error('invalid key');}catch{console.warn('[web] encrypted session storage unavailable.');}}
  if(sessionFile&&sessionKey){try{const packed=JSON.parse(fs.readFileSync(sessionFile,'utf8'));const decipher=crypto.createDecipheriv('aes-256-gcm',sessionKey,Buffer.from(packed.iv,'base64'));decipher.setAuthTag(Buffer.from(packed.tag,'base64'));const saved=JSON.parse(Buffer.concat([decipher.update(Buffer.from(packed.data,'base64')),decipher.final()]).toString());for(const [key,v]of saved){if(/^[a-f0-9]{64}$/.test(key)&&typeof v.userId==='string'&&typeof v.username==='string'&&Array.isArray(v.guilds)&&/^[a-f0-9]{64}$/.test(v.csrf)&&v.accessToken&&v.expires>Date.now()&&v.expires<=Date.now()+TTL&&sessions.size<64){v.checkedAt=0;sessions.set(key,v);}}fs.chmodSync(sessionFile,0o600);}catch(e){if(e.code!=='ENOENT')console.warn('[web] saved sessions unavailable; fresh sign-in required.');}}
  function saveSessions(){if(!sessionFile)return;if(!sessionKey)throw Error('private session storage unavailable');const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',sessionKey,iv);const data=Buffer.concat([cipher.update(JSON.stringify([...sessions])),cipher.final()]);const tmp=sessionFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,sessionFile);}
  const authChecks=new Map();
  async function validateGrant(s){
    if(s.checkedAt>now()-300000)return;
    if(authChecks.has(s.userId))return authChecks.get(s.userId);
    const work=(async()=>{
      function revoke(){for(const[k,v]of sessions)if(v.userId===s.userId)sessions.delete(k);saveSessions();throw fail(401,'Discord authorization expired or was revoked. Continue with Discord again.');}
      if(s.tokenExpires<now()+30000){
        if(!s.refreshToken)return revoke();
        const r=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:secret(),grant_type:'refresh_token',refresh_token:s.refreshToken}),signal:AbortSignal.timeout(12000)});
        if(r.status===400||r.status===401)return revoke();if(!r.ok)throw fail(503,'Discord authorization check is unavailable. Try again shortly.');
        const a=await r.json();if(!a.access_token)return revoke();s.accessToken=a.access_token;s.refreshToken=a.refresh_token||s.refreshToken;s.tokenExpires=now()+(a.expires_in||3600)*1000;
      }
      const r=await fetch('https://discord.com/api/v10/oauth2/@me',{headers:{Authorization:'Bearer '+s.accessToken},signal:AbortSignal.timeout(12000)});
      if(r.status===401||r.status===403)return revoke();if(!r.ok)throw fail(503,'Discord authorization check is unavailable. Try again shortly.');
      const a=await r.json();if(a.user?.id!==s.userId||!a.scopes?.includes('identify')||!a.scopes?.includes('guilds'))return revoke();
      s.checkedAt=now();saveSessions();
    })();authChecks.set(s.userId,work);try{await work;}finally{authChecks.delete(s.userId);}
  }
  const remoteUntil = new Map();
  const now = () => Date.now();
  function prune() {
    for (const m of [sessions, searches]) for (const [k,v] of m) if (v.expires < now()) m.delete(k);
    try{saveSessions();}catch{console.warn('[web] session persistence failed.');}
    for (const [k,v] of limits) if (v.reset < now()) limits.delete(k);
  }
  const timer = setInterval(prune, 60000); timer.unref();
  const oauthStates = new Map();
  const clientId = config.clientId || process.env.CLIENT_ID || client.user?.id || '';
  function secret() {const file=process.env.DISCORD_CLIENT_SECRET_FILE||path.join(process.env.DATA_DIR||path.join(__dirname,'..','data'),'.oauth-client-secret');return config.secret||process.env.DISCORD_CLIENT_SECRET||(fs.existsSync(file)?fs.readFileSync(file,'utf8').trim():'');}
  async function access(userId,guild) {
    const member=await guild.members.fetch({user:userId,force:true}).catch(()=>null);
    const role=ownerIds.has(userId)?'owner':'member';
    if(!member){for(const v of sessions.values())if(v.userId===userId)v.guilds=v.guilds.filter(id=>id!==guild.id);try{saveSessions();}catch{}throw fail(403,'You are not a member of this server.');}
    return {member,role};
  }
  async function loginCommand(i) {
    return i.reply({content:enabled?`Open the Pulse web panel: ${origin}\nChoose Continue with Discord. No separate password and no need to join voice.`:'The web panel is not configured yet.',flags:64});
  }
  async function discordJson(route, token) {
    const r=await fetch('https://discord.com/api/v10'+route,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw fail(502,'Discord authorization could not finish. Please sign in again.');
    return r.json();
  }
  function rate(key, max) {
    let v=limits.get(key); if (!v || v.reset < now()) {v={n:0,reset:now()+60000};limits.set(key,v);}
    if (++v.n > max) throw fail(429,'Too many requests. Wait a minute.');
  }
  const trackKey=t=>hash(t?.encoded||t?.info?.uri||'').slice(0,20);
  const queueVersion=p=>hash(JSON.stringify([p?.voiceChannelId,p?.queue.current?.encoded||p?.queue.current?.info?.uri,p?.queue.tracks.map(t=>[trackKey(t),t.requester?.id])]));
  const profileLocks=new Set(), profileTimes=new Map();
  async function profileRequest(globalScope,guildId,s,b,isPost) {
    if(globalScope&&!ownerIds.has(s.userId))throw fail(403,'Only the bot owner can edit the global bot profile.');
    const scope=globalScope?'global':guildId;
    if(!isPost)return profile.webRead(client,globalScope?null:guildId);
    const key='profile:'+scope;
    if(profileLocks.has(key))throw fail(409,'A profile change is still finishing.');
    if((profileTimes.get(key)||0)>now()-60000)throw fail(429,'Wait a minute between photo/profile changes.');
    profileLocks.add(key);profileTimes.set(key,now());
    try{return await profile.webUpdate(client,globalScope?null:guildId,s.userId,b);}
    catch(e){if(e.status===429)throw fail(429,'Discord is limiting profile updates. Wait a few minutes.');if(e.status===403||e.code===50013)throw fail(403,'Discord refused this profile change. Check the bot permissions.');throw fail(400,e.status?'Discord did not accept the profile update. Try a smaller image or wait before retrying.':e.message);}
    finally{profileLocks.delete(key);}
  }
  function track(t) {
    if (!t) return null;
    const x=t.info || {};
    const artwork = /^https:\/\//i.test(x.artworkUrl || '') ? x.artworkUrl : null;
    return {title:String(x.title || 'Unknown track').slice(0,300),author:String(x.author || 'Unknown artist').slice(0,200),duration:x.duration || 0,live:!!x.isStream,seekable:!!x.isSeekable,artwork};
  }
  function view(guild, rights) {
    const p=lava.getPlayer(guild.id), settings=store.get(guild.id);
    const auto=p?suggestions.view(p):null;
    return {routing:{channelId:settings.controlChannelId||null,canManage:routing.canManage(rights.member,rights.role==='owner'),channels:[...guild.channels.cache.values()].filter(c=>routing.valid(c,guild,rights.member)).map(c=>({id:c.id,name:c.name,type:c.type}))},role:rights.role,guild:{id:guild.id,name:guild.name}, textChannels:[...guild.channels.cache.values()].filter(c=>c.type===0 && c.permissionsFor(guild.members.me)?.has(['ViewChannel','SendMessages','AttachFiles','EmbedLinks']) && c.permissionsFor(rights.member)?.has('ViewChannel')).map(c=>({id:c.id,name:c.name})),channels:[...guild.channels.cache.values()].filter(c=>c.type===2 && c.permissionsFor(guild.members.me)?.has(['ViewChannel','Connect','Speak']) && c.permissionsFor(rights.member)?.has(['ViewChannel','Connect'])).map(c=>({id:c.id,name:c.name})), player:p ? {voiceChannelId:p.voiceChannelId,voiceChannelName:guild.channels.cache.get(p.voiceChannelId)?.name || 'Voice channel',current:track(p.queue.current),queueVersion:queueVersion(p),queue:p.queue.tracks.slice(0,200).map((t,index)=>({...track(t),index,key:hash(t.encoded || t.info?.uri || String(index)).slice(0,20),canRemove:true})),paused:p.paused,playing:p.playing,position:p.position||0,volume:p.volume,loop:p.repeatMode,autoplay:!!settings.autoplay,suggestions:auto?{version:auto.version,loading:auto.loading,error:auto.error,notice:auto.notice,tracks:auto.tracks.map(x=>({...track(x.track),id:x.id,reason:x.reason})),anchor:auto.anchor}:null,stay:!!settings.twentyFourSeven} : null, nodeCount:orderedNodes(lava).length};
  }
  function retain(p, session) {
    remoteUntil.set(p.guildId, session.expires);
    clearTimeout(st(p.guildId).emptyTimer);
  }
  async function body(req,limit=4096) {
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>limit)throw fail(413,'Request too large.');}
    try{return JSON.parse(data || '{}');}catch{throw fail(400,'Invalid request.');}
  }
  const assets = {'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  function send(res,status,data) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
  const server=http.createServer(async(req,res)=>{
    let operation=null;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url=new URL(req.url,'http://local');
      if(req.method==='GET' && assets[url.pathname]) {
        const [file,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(path.join(__dirname,'web',file)));return;
      }
      if(!enabled) throw fail(503,'Web panel setup is not complete.');
      if(req.headers.host !== new URL(origin).host || (req.headers['x-forwarded-proto'] !== 'https' && !req.socket.encrypted && !config.test)) throw fail(403,'Open the secure HTTPS panel address.');
      if(req.method==='GET' && url.pathname==='/auth/login') {
        if(!secret())throw fail(503,'Discord sign-in setup is not complete yet.');
        rate('login:'+req.socket.remoteAddress,20);
        for(const [k,v] of oauthStates)if(v.expires<now())oauthStates.delete(k);
        if(oauthStates.size>=128)throw fail(503,'Please try signing in in a few minutes.');
        const state=random(),verifier=random();oauthStates.set(hash(state),{verifier,expires:now()+300000});
        res.setHeader('Set-Cookie',`__Host-pulse-oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);
        const target=new URL('https://discord.com/oauth2/authorize');
        target.search=new URLSearchParams({client_id:clientId,redirect_uri:origin+'/auth/callback',response_type:'code',scope:'identify guilds',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
        res.writeHead(302,{Location:target.href});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/auth/callback') {
        const state=url.searchParams.get('state')||'',cookie=String(req.headers.cookie||'').match(/(?:^|; )__Host-pulse-oauth=([a-f0-9]{64})(?:;|$)/)?.[1];
        const attempt=oauthStates.get(hash(state));oauthStates.delete(hash(state));
        if(!cookie||cookie!==state||!attempt||attempt.expires<now()||url.searchParams.has('error')||(url.searchParams.get('iss')&&url.searchParams.get('iss')!=='https://discord.com'))throw fail(403,'Discord sign-in was cancelled or expired. Return to the panel and sign in again.');
        const code=url.searchParams.get('code');if(!code||code.length>512)throw fail(400,'Missing authorization code.');
        const response=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:secret(),grant_type:'authorization_code',code,redirect_uri:origin+'/auth/callback',code_verifier:attempt.verifier}),signal:AbortSignal.timeout(12000)});
        if(!response.ok)throw fail(502,'Discord sign-in could not finish. Try again from the panel.');
        const auth=await response.json();
        const user=await discordJson('/users/@me',auth.access_token),guilds=await discordJson('/users/@me/guilds',auth.access_token);
        prune();if(sessions.size>=64)throw fail(503,'Session limit reached. Try later.');
        const sid=random();sessions.set(hash(sid),{userId:user.id,username:user.global_name||user.username,guilds:guilds.map(g=>g.id),expires:now()+TTL,csrf:random(),accessToken:auth.access_token,refreshToken:auth.refresh_token||null,tokenExpires:now()+(auth.expires_in||3600)*1000,checkedAt:0});
        try{saveSessions();}catch{sessions.delete(hash(sid));throw fail(503,'Sign-in could not be saved safely. Try again shortly.');}
        res.setHeader('Set-Cookie',[`__Host-pulse=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,'__Host-pulse-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
        res.writeHead(303,{Location:'/'});return res.end();
      }
      if(!url.pathname.startsWith('/api/'))throw fail(404,'Not found.');
      if(req.method==='POST' && req.headers.origin!==origin)throw fail(403,'Use the panel to send commands.');
      if(req.method==='POST' && !String(req.headers['content-type']).startsWith('application/json'))throw fail(415,'JSON required.');
      const cookie=String(req.headers.cookie||'').match(/(?:^|; )__Host-pulse=([a-f0-9]{64})(?:;|$)/)?.[1];
      const s=cookie && sessions.get(hash(cookie));if(!s || s.expires<now()){if(cookie){sessions.delete(hash(cookie));try{saveSessions();}catch{}res.setHeader('Set-Cookie','__Host-pulse=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');}throw fail(401,'Continue with Discord to sign in.');}
      if(url.pathname!=='/api/logout')await validateGrant(s);
      rate(s.userId,180);
      if(req.method==='GET' && url.pathname==='/api/guilds'){const shared=[];for(const g of client.guilds.cache.values()){try{await access(s.userId,g);shared.push({id:g.id,name:g.name});}catch{}}s.guilds=shared.map(g=>g.id);try{saveSessions();}catch{}return send(res,200,{username:s.username,csrf:s.csrf,owner:ownerIds.has(s.userId),guilds:shared});}
      if(req.method==='POST' && req.headers['x-pulse-csrf']!==s.csrf)throw fail(403,'Reload the panel and try again.');
      const b=req.method==='POST'?await body(req,['/api/global-profile','/api/server-profile'].includes(url.pathname)?5700000:4096):{};
      if(url.pathname==='/api/activity'&&req.method==='POST'){if(!s.lastActivity||s.lastActivity<now()-60000){s.lastActivity=now();s.expires=now()+TTL;saveSessions();res.setHeader('Set-Cookie',`__Host-pulse=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);}return send(res,200,{ok:true,expires:s.expires});}
      if(url.pathname==='/api/logout' && req.method==='POST'){sessions.delete(hash(cookie));try{saveSessions();}catch{throw fail(503,'Sign-out could not be saved safely. Try again.');}res.setHeader('Set-Cookie','__Host-pulse=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');return send(res,200,{ok:true});}
      if(url.pathname==='/api/global-profile')return send(res,200,await profileRequest(true,null,s,b,req.method==='POST'));
      if(url.pathname==='/api/owner') {
        if(!ownerIds.has(s.userId))throw fail(403,'Only the bot owner can use bot-wide controls.');
        if(req.method==='POST') {
          rate('presence:'+s.userId,6);
          if(!['listening','playing','watching','competing'].includes(b.type||'listening')||!['online','idle','dnd','invisible'].includes(b.status)||typeof b.text!=='string'||b.text.length>128)throw fail(400,'Use a valid status and up to 128 characters.');
          store.set('__bot',{presence:{status:b.status,type:b.type||'listening',text:b.text}});profile.applyPresence(client);
        }
        return send(res,200,{guildCount:client.guilds.cache.size,nodeCount:orderedNodes(lava).length,players:lava.players.size,uptime:process.uptime(),memoryMB:Math.round(process.memoryUsage().rss/1024/1024),presence:store.get('__bot').presence||{status:'online',type:'listening',text:'/play'}});
      }
      const guildId=req.method==='GET'?url.searchParams.get('guildId'):b.guildId;
      const guild=client.guilds.cache.get(guildId);
      if(!guild||!s.guilds.includes(guildId))throw fail(403,'Choose a server you share with Pulse.');
      const rights=await access(s.userId,guild);
      if(url.pathname==='/api/server-profile')return send(res,200,await profileRequest(false,guild.id,s,b,req.method==='POST'));
      const existing=lava.getPlayer(guild.id),vc=existing&&guild.channels.cache.get(existing.voiceChannelId);
      if(vc&&!vc.permissionsFor(rights.member)?.has(['ViewChannel','Connect']))throw fail(403,'You cannot access the voice channel Pulse is using.');
      if(req.method==='POST' && url.pathname==='/api/routing'){
        rate('routing:'+s.userId,6);
        if(b.channelId!==null && (typeof b.channelId!=='string'||!/^\d{15,22}$/.test(b.channelId)))throw fail(400,'Choose a control channel or Current VC chat.');
        if(!routing.canManage(rights.member,rights.role==='owner'))throw fail(403,'Manage Server permission or bot ownership is required.');
        try{await routing.configure(client,guild,rights.member,rights.role==='owner',b.channelId,store);}catch(e){throw fail(400,e.message);}
        if(panel.syncGuild)await panel.syncGuild(client,guild.id);else if(existing?.queue.current)await panel.postPanel(client,existing);
        if(ctx.offerRecovery)await ctx.offerRecovery(guild.id);
        return send(res,200,{ok:true,...view(guild,rights)});
      }
      if(req.method==='GET' && url.pathname==='/api/diagnostics'){
        rate('diagnostics:'+s.userId,12);
        return send(res,200,{gatewayMs:Number.isFinite(client.ws?.ping)&&client.ws.ping>=0?Math.round(client.ws.ping):null,nodes:[...(lava.nodeManager?.nodes?.values()||[])].map(n=>({name:String(n.id).slice(0,80),connected:!!n.connected,pingMs:Number.isFinite(n.heartBeatPing)&&n.heartBeatPing>=0?Math.round(n.heartBeatPing):null,sources:(n.info?.sourceManagers||[]).filter(x=>typeof x==='string').slice(0,60)})),player:existing?{state:existing.paused?'paused':existing.playing?'playing':'idle',queued:existing.queue.tracks.length}:null});
      }
      if(req.method==='GET' && url.pathname==='/api/lyrics'){
        rate('lyrics:'+s.userId,8);const t=existing?.queue.current;
        if(!t||t.info?.isStream)throw fail(409,'Play a regular song first. Live radio has no track lyrics here.');
        const hit=await lyrics.find({title:t.info.title,artist:t.info.author,durationSec:(t.info.duration||0)/1000});
        return send(res,200,{found:!!hit,title:hit?.title||t.info.title,artist:hit?.artist||t.info.author,text:hit?.text?.slice(0,24000)||'',source:'https://lrclib.net/'});
      }
      if(req.method==='GET' && url.pathname==='/api/state')return send(res,200,{...view(guild,rights),csrf:s.csrf,username:s.username,expires:s.expires});
      if(req.method!=='POST')throw fail(404,'Not found.');
      if(url.pathname==='/api/search') {
        rate('search:'+s.userId,12);
        if(busy.has('search:'+s.userId))throw fail(409,'Your previous search is still loading.');
        const q=String(b.query||'').trim();if(!q||q.length>300)throw fail(400,'Enter a title, artist or supported music link (up to 300 characters).');
        if(/^https?:/i.test(q)) {const u=new URL(q);if(u.protocol!=='https:' || !/(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com|spotify\.com|soundcloud\.com|deezer\.com|music\.apple\.com|bandcamp\.com)$/.test(u.hostname)||u.username||u.password||u.port)throw fail(400,'Use a music-service HTTPS link or search by title. Custom file URLs are available through Discord /play.');}
        busy.add('search:'+s.userId);
        try{
          const ck=s.userId+':'+guild.id+':'+(/^https?:/i.test(q)?q:q.toLowerCase());const cached=searchCache.get(ck);
          const out=cached&&cached.expires>now()&&orderedNodes(lava).some(n=>n.id===cached.out.nodeId)?cached.out:await searchAny(lava,q,{id:s.userId,username:s.username},lava.getPlayer(guild.id)?.node?.id);
          if(!cached||out!==cached.out){for(const[k,v]of searchCache)if(v.expires<now())searchCache.delete(k);if(searchCache.size>=64)searchCache.delete(searchCache.keys().next().value);searchCache.set(ck,{out,expires:now()+30000});}
          const tracks=out.res.tracks?.slice(0,out.res.loadType==='playlist'?200:12)||[];
          prune();if(searches.size>=128)searches.delete(searches.keys().next().value);
          const id=random();searches.set(id,{tracks,nodeId:out.nodeId,userId:s.userId,guildId:guild.id,expires:now()+120000});
          return send(res,200,{id,playlist:out.res.loadType==='playlist',total:out.res.tracks?.length||0,tracks:tracks.map(track)});
        }finally{busy.delete('search:'+s.userId);}
      }
      if(url.pathname!=='/api/control')throw fail(404,'Not found.');
      let requestKey,fp;
      if(b.action==='add'&&b.requestId!==undefined){if(typeof b.requestId!=='string'||!/^[-a-zA-Z0-9]{16,64}$/.test(b.requestId))throw fail(400,'Invalid add request.');requestKey=s.userId+':'+guild.id+':'+b.requestId;fp=hash(JSON.stringify([b.searchId,b.index,!!b.all,!!b.next,b.voiceChannelId]));const prior=addRequests.get(requestKey);if(prior&&prior.expires>now()){if(prior.fp!==fp)throw fail(409,'That add request was already used for a different track.');const result=await prior.promise;if(result.status!==200)return send(res,result.status,{error:result.error,requestId:b.requestId});return send(res,200,{ok:true,requestId:b.requestId,...view(guild,rights)});}}
      if(busy.has(guild.id))throw fail(409,'Another command is finishing. Try again.');
      if(requestKey){for(const[k,v]of addRequests)if(v.expires<now())addRequests.delete(k);if(addRequests.size>=512)throw fail(429,'Too many pending track adds. Wait a moment.');let finish;const promise=new Promise(r=>finish=r);operation={fp,promise,finish,expires:now()+300000};addRequests.set(requestKey,operation);} 
      busy.add(guild.id);
      try{
        let p=lava.getPlayer(guild.id);
        if(b.action==='add') {
          const found=searches.get(b.searchId);
          if(!found || found.expires<now() || found.userId!==s.userId || found.guildId!==guild.id)throw fail(400,'Search results expired. Search again.');
          const indexes=b.all ? found.tracks.map((_,n)=>n) : [b.index];
          if(indexes.some(n=>!Number.isInteger(n)||!found.tracks[n]))throw fail(400,'Choose a search result.');
          const tracks=indexes.map(n=>found.tracks[n]);
          if((p?.queue.tracks.length||0)+tracks.length>200)throw fail(400,'Queue limit is 200. Remove some tracks first.');
          if(!p){
            const ch=guild.channels.cache.get(b.voiceChannelId);
            if(!ch||ch.type!==2)throw fail(400,'Choose a voice channel.');
            const perms=ch.permissionsFor(guild.members.me);
            if(!ch.permissionsFor(rights.member)?.has(['ViewChannel','Connect']))throw fail(403,'You cannot access that voice channel.');
            if(!perms?.has(['ViewChannel','Connect','Speak']) || (ch.full&&!perms.has('MoveMembers')))throw fail(403,'Pulse cannot join and speak in that channel.');
            if(!orderedNodes(lava).length)throw fail(503,'No audio server is connected.');
            const text=await routing.channel(client,guild.id,ch.id,store.get(guild.id));
            if(!text||!text.permissionsFor(rights.member)?.has('ViewChannel'))throw fail(400,'No accessible music-message channel. Check the Current VC chat permissions or ask an admin to set the control channel.');
            p=lava.createPlayer({guildId:guild.id,voiceChannelId:ch.id,textChannelId:text.id,selfDeaf:false,volume:store.get(guild.id).volume??80});
            try{await p.connect();}catch(e){await p.destroy('web-connect-failed').catch(()=>{});throw e;}
          } else if(b.voiceChannelId && b.voiceChannelId!==p.voiceChannelId)throw fail(409,'The playing channel changed. Reload and choose Playing to move Pulse.');
          retain(p,s);
          suggestions.manual(p);
          if(tracks.length===1)await enqueue(p,tracks[0],!!b.next,found.nodeId);
          else{if(found.nodeId&&p.node?.id!==found.nodeId&&!p.queue.current)await p.changeNode(found.nodeId);await p.queue.add(tracks);if(!p.playing&&!p.paused)await p.play({paused:false});repaint(p);}
        }else{
          if(!p)throw fail(409,'No player yet. Search and add a track first.');
          retain(p,s);
          switch(b.action){
            case 'pause':await p.pause();break;
            case 'resume':await p.resume();break;
            case 'skip':await A.skip(p);break;
            case 'previous':await A.previous(p);break;
            case 'seek':if(!p.queue.current?.info.isSeekable||p.queue.current?.info.isStream)throw fail(400,'This track cannot seek.');if(!Number.isFinite(b.position)||b.position<0||b.position>p.queue.current.info.duration)throw fail(400,'Invalid seek position.');await p.seek(b.position);break;
            case 'volume':if(!Number.isInteger(b.value)||b.value<0||b.value>100)throw fail(400,'Volume must be 0 to 100.');await A.setVolume(p,b.value);break;
            case 'loop':if(!['off','track','queue'].includes(b.mode))throw fail(400,'Invalid loop mode.');await p.setRepeatMode(b.mode);break;
            case 'shuffle':await p.queue.shuffle();break;
            case 'autoplay':A.toggleAutoplay(p.guildId);suggestions.manual(p);suggestions.prepare(p,p.queue.current,searchAny).then(()=>repaint(p)).catch(()=>{});break;
            case 'dismiss-autoplay':if(!suggestions.dismiss(p,b.id,b.version))throw fail(409,'Autoplay suggestions changed. Reload and try again.');break;
            case 'stay':A.toggle247(p);break;
            case 'voice':{
              const ch=guild.channels.cache.get(b.voiceChannelId);
              if(!ch||ch.type!==2||!ch.permissionsFor(rights.member)?.has(['ViewChannel','Connect']))throw fail(403,'Choose a voice channel you can view and join.');
              const perms=ch.permissionsFor(guild.members.me);
              if(!perms?.has(['ViewChannel','Connect','Speak'])||(ch.full&&!perms.has('MoveMembers')))throw fail(403,'Pulse cannot join and speak in that channel.');
              if(ch.id===p.voiceChannelId)break;
              rate('movevoice:'+guild.id,6);
              const old=p.voiceChannelId;
              let finish;
              const confirmed=new Promise(resolve=>{const onState=(before,after)=>{if(after.id===client.user.id&&after.guild.id===guild.id&&after.channelId===ch.id)finish(true);};const timeout=setTimeout(()=>finish(false),8000);finish=value=>{clearTimeout(timeout);client.off('voiceStateUpdate',onState);resolve(value);};client.on('voiceStateUpdate',onState);});
              try{await p.changeVoiceState({voiceChannelId:ch.id,selfDeaf:false});}catch(e){finish(false);throw e;}
              const arrived=await confirmed;
              if(!arrived&&guild.members.me?.voice?.channelId!==ch.id){const actual=guild.members.me?.voice?.channelId||old;p.voiceChannelId=actual;p.options.voiceChannelId=actual;throw fail(409,'Discord has not confirmed the move. Reload before trying again.');}
              store.set(guild.id,{voiceChannelId:ch.id});
              break;
            }
            case 'move':{
              if(!Number.isInteger(b.from)||!Number.isInteger(b.to)||b.from<0||b.to<0||b.from>=p.queue.tracks.length||b.to>=p.queue.tracks.length)throw fail(400,'Choose queued tracks, not the current song.');
              if(b.version!==queueVersion(p)||b.key!==trackKey(p.queue.tracks[b.from]))throw fail(409,'Queue changed. Reloaded the current order; try again.');
              // Lavalink Queue.splice mutates synchronously before saving, so there is no remove/add gap.
              const next=p.queue.tracks.slice();const [moved]=next.splice(b.from,1);next.splice(b.to,0,moved);
              await p.queue.splice(0,p.queue.tracks.length,next);
              break;
            }
            case 'remove':{const t=p.queue.tracks[b.index];if(!Number.isInteger(b.index)||!t||hash(t.encoded||t.info?.uri||String(b.index)).slice(0,20)!==b.key)throw fail(409,'Queue changed. Reload and try again.');await p.queue.splice(b.index,1);break;}
            case 'clear':suggestions.suspend(p);await p.queue.splice(0,p.queue.tracks.length);break;
            case 'stop':await A.stop(client,p);break;
            case 'leave':remoteUntil.delete(guild.id);await A.leave(client,p);p=null;break;
            default:throw fail(400,'Unknown control.');
          }
          if(p)repaint(p);
        }
        if(p)recovery.capture(p);
        operation?.finish({status:200});
        return send(res,200,{ok:true,requestId:b.requestId,...view(guild,rights)});
      }finally{busy.delete(guild.id);}
    }catch(e){const status=e.status||502,error=e.status?e.message:'The audio service could not finish this request. Check the queue before trying again, or use /health in Discord.';operation?.finish({status,error});if(!res.headersSent)send(res,status,{error});else res.end();}
  });
  server.headersTimeout=10000;server.requestTimeout=20000;server.maxHeadersCount=40;
  return {server,loginCommand,enabled,remoteUntil,close:()=>{clearInterval(timer);server.close();},start:()=>{const port=Number(process.env.SERVER_PORT||process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.log(`[web] listening on ${port}; ${enabled?'Discord authorization route configured':'authentication disabled until WEB_BASE_URL is configured'}`));server.on('error',()=>console.error('[web] listener failed; check allocated port.'));}};
}
module.exports={createWeb};
