'use strict';
// Builds docs/panel-mockup.html + .png: the real rendered card inside an approximation of
// Discord's dark theme (embed, buttons, select menu). The card image is real output;
// the surrounding chrome is an HTML approximation, not a Discord screenshot.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderCard } = require('../src/card');

(async () => {
  const dir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(dir, { recursive: true });
  const art = 'https://i.ytimg.com/vi/FTQbiNvZqaY/hqdefault.jpg';
  const png = await renderCard({ title: 'Daft Punk - One More Time (Official Video)', author: 'Daft Punk', artworkUrl: art, position: 150000, duration: 320000, volume: 80, loop: 'queue', autoplay: true, twentyFourSeven: true });
  const b64 = png.toString('base64');
  const btn = (e, cls = '') => `<div class="b ${cls}">${e}</div>`;
  const html = `<!doctype html><meta charset=utf-8><style>
  body{margin:0;background:#313338;font-family:"gg sans","Noto Sans",Helvetica,Arial,sans-serif;color:#dbdee1;width:760px;padding:24px 20px}
  .row{display:flex;gap:14px}.av{width:40px;height:40px;border-radius:50%;background:#5865f2;flex:none;display:flex;align-items:center;justify-content:center;font-size:20px}
  .name{font-weight:600;color:#fff}.tag{background:#5865f2;color:#fff;font-size:10px;border-radius:3px;padding:1px 4px;margin:0 6px;vertical-align:2px}.ts{font-size:12px;color:#949ba4}
  .embed{margin-top:4px;background:#2b2d31;border-left:4px solid #5865f2;border-radius:4px;padding:10px 14px 12px;width:560px}
  .title{color:#00a8fc;font-weight:600;font-size:15px;margin-bottom:8px}.embed img{width:100%;border-radius:4px;display:block}
  .desc{font-size:13px;margin-top:10px;color:#dbdee1}.desc code{background:#1e1f22;border-radius:3px;padding:0 4px}.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 3px}
  .comp{margin-top:8px;display:flex;gap:8px}.b{gap:6px;background:#4e5058;border-radius:3px;height:32px;min-width:44px;display:flex;align-items:center;justify-content:center;font-size:16px;padding:0 8px;box-sizing:border-box}
  .b.p{background:#5865f2}.b.g{background:#248046}.b.d{background:#da373c}
  .sel{margin-top:8px;width:560px;height:40px;box-sizing:border-box;background:#1e1f22;border:1px solid #1e1f22;border-radius:4px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:#b5bac1;font-size:14px}
  </style>
  <div class=row><div class=av>♪</div><div>
  <div><span class=name>Pulse</span><span class=tag>APP</span><span class=ts>Today at 18:42</span></div>
  <div class=desc style="margin:4px 0 6px">Requested by <span class=mention>@Listener</span>  ·  Volume <code>80%</code>  ·  Up next <code>6</code> (24:10)  ·  <span style="color:#00a8fc">Track link</span></div>
  <img style="width:560px;display:block;border-radius:8px" src="data:image/png;base64,${b64}">
  <div class=comp>${btn('⏮')}${btn('⏪ <span style="font-size:13px;font-weight:600">15s</span>')}${btn('⏸', 'p')}${btn('⏩ <span style="font-size:13px;font-weight:600">15s</span>')}${btn('⏭')}</div>
  <div class=sel><span>More controls</span><span>⌃</span></div><div style="margin-top:4px;width:560px;background:#2b2d31;border:1px solid #1e1f22;border-radius:8px;padding:6px;box-sizing:border-box;font-size:14px;color:#dbdee1"><div style="padding:6px 8px">Shuffle queue</div><div style="padding:6px 8px">Loop: off</div><div style="padding:6px 8px">Autoplay: on</div><div style="padding:6px 8px">Show queue</div><div style="padding:6px 8px">Volume up (+10%)</div><div style="padding:6px 8px">Volume down (-10%)</div><div style="padding:6px 8px">24/7 mode: on (tap to switch)</div><div style="padding:6px 8px">Stop and clear queue</div><div style="padding:6px 8px">Leave voice channel</div></div>
  </div></div>`;
  const f = path.join(dir, 'panel-mockup.html');
  fs.writeFileSync(f, html);
  execFileSync('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=800,720', `--screenshot=${path.join(dir, 'panel-mockup.png')}`, `file://${f}`], { stdio: 'ignore' });
  console.log('wrote docs/panel-mockup.png');
})();
