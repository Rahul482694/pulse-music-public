'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');const defs=require('../src/commands').defs;
assert.equal(defs.length,33);assert.equal(defs.some(x=>x.name==='lofi'),false,'lo-fi canceled');assert.equal(defs.some(x=>x.name==='speed'),false,'speed was only user example');for(const n of ['play','lyrics','health','sources','queue','autoplay','help','controlchannel'])assert.ok(defs.some(x=>x.name===n));
for(const f of ['src/index.js','src/web.js','src/panel.js','src/web/app.js','src/web/index.html']){const s=fs.readFileSync(path.join(__dirname,'..',f),'utf8');assert.ok(!/radio-start|radio-off|radio\.resolve|radio\.beforeManual|radio\.afterManual|audiobookmanager|\/lofi|ABM LoFi/.test(s),f+' must have no lo-fi controls or source');}
console.log('PASS: canceled lo-fi controls/endpoints/commands/station removed; speed not added; recent shared features have existing Discord command counterparts.');
