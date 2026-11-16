'use strict';
// Clean white icons (Lucide, ISC licence) uploaded once as Discord *application emojis*
// (free; owned by the bot, usable in every server). If upload fails we fall back to Unicode emoji.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'icons');
const PREFIX = 'pulse_';
const cache = new Map(); // icon name -> { id, name }

async function init(client) {
  try {
    const existing = await client.application.emojis.fetch();
    for (const e of existing.values()) if (e.name.startsWith(PREFIX)) cache.set(e.name.slice(PREFIX.length).replace(/_/g, '-'), { id: e.id, name: e.name });
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png'));
    let created = 0;
    for (const f of files) {
      const key = f.replace('.png', '');
      if (cache.has(key)) continue;
      const name = PREFIX + key.replace(/-/g, '_');
      const e = await client.application.emojis.create({ attachment: path.join(DIR, f), name });
      cache.set(key, { id: e.id, name: e.name });
      created++;
    }
    console.log(`[icons] ${cache.size} custom icons ready (${created} uploaded)`);
  } catch (e) {
    console.error('[icons] custom icons unavailable, using Unicode fallback:', e.message);
  }
}

/** Emoji for a button/menu: custom icon if available, else the Unicode fallback. */
const get = (key, fallback) => cache.get(key) || fallback;

module.exports = { init, get };
