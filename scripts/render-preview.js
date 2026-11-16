'use strict';
// Renders sample player cards to ./preview/*.png (no Discord needed).
const fs = require('fs');
const path = require('path');
const { renderCard } = require('../src/card');

(async () => {
  const out = path.join(__dirname, '..', 'preview');
  fs.mkdirSync(out, { recursive: true });
  const art = process.argv[2] || 'https://i.ytimg.com/vi/FTQbiNvZqaY/hqdefault.jpg';
  const base = { title: 'Daft Punk - One More Time (Official Video)', author: 'Daft Punk', artworkUrl: art, duration: 320000, volume: 80, loop: 'off', autoplay: true, twentyFourSeven: true };
  const samples = {
    start: { ...base, position: 4000 },
    mid: { ...base, position: 150000, loop: 'queue' },
    paused: { ...base, position: 200000, paused: true },
    noart: { ...base, artworkUrl: null, title: 'यह रहा एक बहुत लंबा हिंदी गाने का नाम that keeps going and going', author: 'कलाकार', position: 90000 },
  };
  for (const [k, v] of Object.entries(samples)) fs.writeFileSync(path.join(out, `card-${k}.png`), await renderCard(v));
  console.log('wrote', Object.keys(samples).map((k) => `card-${k}.png`).join(', '));
})();
