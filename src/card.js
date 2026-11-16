'use strict';
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSans.ttf'), 'PulseSans');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSansDevanagari.ttf'), 'PulseDeva');
const FONT = '"PulseSans", "PulseDeva", sans-serif';

const W = 860;
const H = 348;
const artCache = new Map(); // url -> Image (small LRU)

async function fetchArt(url) {
  if (!url) return null;
  if (artCache.has(url)) return artCache.get(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const img = await loadImage(Buffer.from(await res.arrayBuffer()));
    artCache.set(url, img);
    if (artCache.size > 8) artCache.delete(artCache.keys().next().value);
    return img;
  } catch { return null; }
}

function fmt(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

// Centre-crop an image into a box (like CSS object-fit: cover).
function drawCover(ctx, img, x, y, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const sw = w / r, sh = h / r;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function dominant(img) {
  // Average colour of a 8x8 downscale, used to tint the background.
  const c = createCanvas(8, 8);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, 8, 8);
  const d = x.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

const NAMES={youtube:'YouTube',youtubemusic:'YouTube Music',soundcloud:'SoundCloud',spotify:'Spotify',applemusic:'Apple Music',tidal:'Tidal',deezer:'Deezer',bandcamp:'Bandcamp',jiosaavn:'JioSaavn',twitch:'Twitch',vimeo:'Vimeo',http:'Direct link',local:'Local file'};
// Catalogue services (Spotify etc.) are not streamed from the service. The audio server matches audio itself and does not report which provider it used (checked: no provider in track info or pluginInfo), so the real provider is unknown.
const MATCHED=new Set(['spotify','applemusic','deezer','tidal']);
function sourceLabel(sourceName,uri){
  let k=String(sourceName||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(!k)return null;
  if(k==='http'){try{const h=new URL(uri).hostname.replace(/^www\./,'');if(/(^|\.)music\.youtube\.com$/.test(h))k='youtubemusic';}catch{}}
  const name=NAMES[k]||(String(sourceName).charAt(0).toUpperCase()+String(sourceName).slice(1));
  return MATCHED.has(k)?'Unknown source':name;
}

/**
 * Render the player card.
 * state: { title, author, artworkUrl, position, duration, isStream, paused, volume, loop, autoplay, queueLeft, requester }
 */
async function renderCard(state) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const idle=!!state.idle;
  const art = await fetchArt(idle?state.botAvatarUrl:state.artworkUrl);
  const avatar = await fetchArt(state.botAvatarUrl);
  const [tr, tg, tb] = art ? dominant(art) : [88, 101, 242];

  // Rounded outer card: pixels outside the rounded rectangle stay transparent, so the
  // corners look round inside Discord's embed.
  rr(ctx, 0, 0, W, H, 44);
  ctx.clip();

  // background
  ctx.fillStyle = '#111d32';
  ctx.fillRect(0, 0, W, H);
  if (art) {
    ctx.save();
    ctx.filter = 'blur(40px)';
    ctx.globalAlpha = 0.62;
    drawCover(ctx, art, -60, -60, W + 120, H + 120);
    ctx.restore();
  }
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, `rgba(${tr},${tg},${tb},0.48)`);
  g.addColorStop(1, 'rgba(10,20,39,0.88)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Actual bot identity, independent of track art.
  if(avatar){ctx.save();rr(ctx,40,12,28,28,14);ctx.clip();drawCover(ctx,avatar,40,12,28,28);ctx.restore();}
  ctx.fillStyle='#eaf0ff';ctx.font=`600 17px ${FONT}`;ctx.textAlign='left';const nm=fit(ctx,state.botName||'Pulse',420);ctx.fillText(nm,avatar?80:40,32);
  const srcText=!idle&&sourceLabel(state.sourceName,state.sourceUri);
  if(srcText){const nx=(avatar?80:40)+ctx.measureText(nm).width+12;ctx.font=`600 13px ${FONT}`;const pw=ctx.measureText(srcText).width+22;if(nx+pw<W-30){rr(ctx,nx,15,pw,24,12);ctx.fillStyle='rgba(255,255,255,0.16)';ctx.fill();ctx.fillStyle='#ffffff';ctx.fillText(srcText,nx+11,32);}}
  ctx.translate(0,48);
  // cover
  const AS = 220, AX = 40, AY = 40;
  ctx.save();
  rr(ctx, AX, AY, AS, AS, 34);
  ctx.clip();
  if (art) drawCover(ctx, art, AX, AY, AS, AS);
  else {
    const ag = ctx.createLinearGradient(AX, AY, AX + AS, AY + AS);
    ag.addColorStop(0, '#5865f2'); ag.addColorStop(1, '#2b2d52');
    ctx.fillStyle = ag; ctx.fillRect(AX, AY, AS, AS);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `bold 96px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.beginPath();ctx.moveTo(AX+88,AY+68);ctx.lineTo(AX+88,AY+152);ctx.lineTo(AX+152,AY+110);ctx.closePath();ctx.fill();
  }
  ctx.restore();
  if(idle){ctx.beginPath();ctx.arc(AX+AS-20,AY+AS-20,26,0,Math.PI*2);ctx.fillStyle='#5865f2';ctx.fill();ctx.beginPath();ctx.moveTo(AX+AS-27,AY+AS-33);ctx.lineTo(AX+AS-27,AY+AS-7);ctx.lineTo(AX+AS-7,AY+AS-20);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();}

  const X = AX + AS + 36;
  const maxW = W - X - 44;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = state.paused ? '#ffd28a' : '#9cdcff';
  ctx.fillText(idle?'NOT PLAYING':state.paused?'PAUSED':'NOW PLAYING', X, 62);

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText(fit(ctx, idle?'Nothing is playing':state.title || 'Unknown title', maxW), X, 104);

  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `400 20px ${FONT}`;
  ctx.fillText(fit(ctx, idle?'Use /play to play music':state.author || 'Unknown artist', maxW), X, 136);

  // progress bar
  const BY = 178, BH = 8;
  const pct = idle?0:state.isStream || !state.duration ? 1 : Math.min(1, Math.max(0, state.position / state.duration));
  rr(ctx, X, BY, maxW, BH, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.20)';
  ctx.fill();
  if (pct > 0) {
    ctx.save();
    rr(ctx, X, BY, maxW, BH, 4);
    ctx.clip();
    ctx.fillStyle = state.paused ? '#ffd28a' : '#9cdcff';
    ctx.fillRect(X, BY, Math.max(8, maxW * pct), BH);
    ctx.restore();
  }
  if (!idle && !state.isStream) {
    ctx.beginPath();
    ctx.arc(X + Math.max(4, maxW * pct), BY + BH / 2, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  ctx.font = `500 15px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.textAlign = 'left';
  ctx.fillText(fmt(idle?0:state.position), X, BY + 34);
  ctx.textAlign = 'right';
  ctx.fillText(idle?'0:00':state.isStream?'LIVE':fmt(state.duration), X + maxW, BY + 34);
  ctx.textAlign = 'left';

  // chips
  const chips = [
    idle?'Idle':state.paused ? 'Paused' : 'Playing',
    !idle&&`Vol ${state.volume}%`,
    state.loop === 'track' ? 'Loop: track' : state.loop === 'queue' ? 'Loop: queue' : null,
    state.autoplay ? 'Autoplay' : null,
    state.twentyFourSeven ? '24/7' : null,
  ].filter(Boolean);
  let cx = X;
  ctx.font = `600 13px ${FONT}`;
  for (const c of chips) {
    const w = ctx.measureText(c).width + 24;
    if (cx + w > X + maxW) break;
    rr(ctx, cx, 238, w, 26, 13);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(c, cx + 12, 256);
    cx += w + 8;
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderCard, fmt, sourceLabel };
