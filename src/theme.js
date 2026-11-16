'use strict';
// Presentation only. Message text and labels always carry meaning, not colour alone.
const { EmbedBuilder } = require('discord.js');
const icons = require('./icons');
const palette = Object.freeze({ music:0x5b8cff, success:0x46c99a, paused:0xf0b85a, queue:0xf0b85a, recovery:0xf0b85a, signal:0x42c9df, discovery:0xa48af5, lyrics:0xe58fbd, profile:0x50c9bc, settings:0x50c9bc, warning:0xf0b85a, error:0xed6675, idle:0x91a9c8 });
const labels = Object.freeze({ music:['Playback','music-2','♪'], success:['Playback updated','circle-check','✓'], paused:['Playback paused','pause','Ⅱ'], queue:['Queue updated','list-music','≡'], recovery:['Continue listening','history','↺'], signal:['Pulse connection','activity','⌁'], discovery:['Find your next track','search','⌕'], lyrics:['Lyrics','mic-vocal','♫'], profile:['Pulse profile','user','◉'], settings:['Player settings','settings','⚙'], warning:['Needs attention','triangle-alert','!'], error:['Could not complete that','circle-x','!'], idle:['Listening room','radio','♪'] });
function heading(kind='music', title) { const [label,key,fallback]=labels[kind]||labels.music;const icon=icons.get(key,null);let text=`${icon?.id ? `<:${icon.name}:${icon.id}>` : fallback} ${title||label}`.slice(0,256);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);return text; }
function embed(kind='music', title) { return new EmbedBuilder().setColor(palette[kind]??palette.music).setTitle(heading(kind,title)); }
function message(text,kind='music',title) { return {embeds:[embed(kind,title).setDescription(text)]}; }
// Preserve components, visibility, expiry and mention restrictions on existing payloads.
function present(payload,kind='music',title) { if(!payload.content)return payload;return {...payload,content:'',embeds:[embed(kind,title).setDescription(payload.content)]}; }
module.exports={palette,heading,embed,message,present};
