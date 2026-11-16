// Renders the white PNG icons (from Lucide SVGs, ISC licence) used as Discord application emojis.
const fs = require('fs'), path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
(async () => {
  const dir = path.join(__dirname, '..', 'assets', 'icons');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.svg'))) {
    let svg = fs.readFileSync(path.join(dir, f), 'utf8').replace(/currentColor/g, '#ffffff').replace(/width="24"/, 'width="128"').replace(/height="24"/, 'height="128"');
    const img = await loadImage(Buffer.from(svg));
    const c = createCanvas(128, 128); c.getContext('2d').drawImage(img, 0, 0, 128, 128);
    fs.writeFileSync(path.join(dir, f.replace('.svg', '.png')), c.toBuffer('image/png'));
  }
  console.log('icons built');
})();
