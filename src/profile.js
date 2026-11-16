'use strict';
// Bot profile settings.
//  /serverprofile  - per-server nickname, photo, banner and bio of the bot. Any member,
//                    only ever applied to the server the command is run in.
//  /botprofile view and /botsettings view - read-only profile card for everyone.
//  Global edits are web-only (every server), owner only.
// Nothing is changed at startup except re-applying the saved owner status/activity.
const { EmbedBuilder, MessageFlags, Routes, ActivityType, PermissionFlagsBits } = require('discord.js');
const store = require('./store');
const theme = require('./theme');

const COLOR = theme.palette.profile;
const BOT_KEY = '__bot'; // global (not a server) entry in the settings store
const ACTIVITY = { playing: ActivityType.Playing, listening: ActivityType.Listening, watching: ActivityType.Watching, competing: ActivityType.Competing };
const MAX_IMAGE = 8 * 1024 * 1024;
const COOLDOWN_MS = 20_000;
const lastUse = new Map(); // `${guildId}:${userId}` -> time

const eph = (description) => ({ embeds: [theme.embed('profile').setDescription(description)], flags: MessageFlags.Ephemeral });
const bad = (description) => ({ embeds: [theme.embed('error','Profile not changed').setDescription(description)], flags: MessageFlags.Ephemeral });

/** Download a Discord attachment and return a data URI. Only Discord's own CDN, image types, size-limited. */
async function imageData(att) {
  if (!att) return undefined;
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(att.contentType || '')) throw new Error('Use a PNG, JPG, GIF or WebP image.');
  if (att.size > MAX_IMAGE) throw new Error('That image is over 8 MB. Use a smaller one.');
  const host = new URL(att.url).hostname;
  if (!/(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/i.test(host)) throw new Error('The image has to be uploaded to Discord.');
  const res = await fetch(att.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error('Could not download that image.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error('That image is over 8 MB. Use a smaller one.');
  return `data:${att.contentType.split(';')[0]};base64,${buf.toString('base64')}`;
}

function apiError(e, what = 'change') {
  const code = e?.code;
  if (code === 50013 || e?.status === 403) return 'Discord refused: the bot is missing a permission here (for the nickname it needs **Change Nickname**).';
  if (e?.status === 429) return 'Discord is rate limiting this change. Try again in a few minutes.';
  const detail = e?.rawError?.errors ? JSON.stringify(e.rawError.errors).slice(0, 300) : e?.rawError?.message || e?.message || 'unknown error';
  return `Discord did not accept that ${what === 'read' ? 'request' : 'change'}: ${detail}`;
}

const dot = (v) => (v ? `${v}` : '_not set_');

/* ---------------- per-server ---------------- */
async function serverProfile(i, client) {
  if (!i.inGuild()) return i.reply(bad('Use this in a server.'));
  const sub = i.options.getSubcommand();
  const gid = i.guildId;
  if (sub === 'view') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const m = await client.rest.get(Routes.guildMember(gid, client.user.id)); // GET needs the numeric id; only PATCH accepts @me
      const e = theme.embed('profile','This server profile')
        .addFields({ name: 'Username', value: client.user.username },
          { name: 'Server nickname', value: m.nick || 'Not set (uses username)' },
          ...presenceFields(client),
          { name: 'Server bio', value: m.bio === undefined ? 'Not provided by Discord' : (m.bio || 'Not set') })
        .setThumbnail(m.avatar ? `https://cdn.discordapp.com/guilds/${gid}/users/${client.user.id}/avatars/${m.avatar}.${m.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256` : client.user.displayAvatarURL({ size: 256 }))
        .setFooter({ text: 'Server profile changes apply only here | Status and activity are global' }).setTimestamp();
      if (m.banner) e.setImage(`https://cdn.discordapp.com/guilds/${gid}/users/${client.user.id}/banners/${m.banner}.${m.banner.startsWith('a_') ? 'gif' : 'png'}?size=512`);
      return i.editReply({ embeds: [e] });
    } catch (e) {
      console.warn('[profile] view failed:', e?.status, e?.code, e?.message);
      return i.editReply(bad(apiError(e, 'read')));
    }
  }
  const key = `${gid}:${i.user.id}`;
  const wait = COOLDOWN_MS - (Date.now() - (lastUse.get(key) || 0));
  if (wait > 0) return i.reply(bad(`Wait ${Math.ceil(wait / 1000)}s before changing the profile again.`));

  const body = {};
  if (sub === 'reset') {
    const f = i.options.getString('field', true);
    if (f === 'nickname' || f === 'all') body.nick = null;
    if (f === 'photo' || f === 'all') body.avatar = null;
    if (f === 'banner' || f === 'all') body.banner = null;
    if (f === 'bio' || f === 'all') body.bio = null;
  } else {
    const nick = i.options.getString('nickname');
    const bio = i.options.getString('bio');
    if (nick !== null) body.nick = nick.slice(0, 32);
    if (bio !== null) body.bio = bio.slice(0, 190);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const photo = await imageData(i.options.getAttachment('photo'));
      const banner = await imageData(i.options.getAttachment('banner'));
      if (photo) body.avatar = photo;
      if (banner) body.banner = banner;
    } catch (e) { return i.editReply(bad(e.message)); }
    if (!Object.keys(body).length) return i.editReply(bad('Nothing to change. Give a nickname, photo, banner or bio.'));
  }
  if ('nick' in body && !i.guild.members.me?.permissions.has(PermissionFlagsBits.ChangeNickname)) {
    const r = bad('The bot needs the **Change Nickname** permission in this server to change its nickname.');
    return i.deferred ? i.editReply(r) : i.reply(r);
  }
  try {
    await client.rest.patch(Routes.guildMember(gid, '@me'), { body, reason: `Pulse profile changed by ${i.user.tag} (${i.user.id}) with /serverprofile` });
    lastUse.set(key, Date.now());
    const what = Object.keys(body).map((k) => ({ nick: 'nickname', avatar: 'photo', banner: 'banner', bio: 'bio' }[k])).join(', ');
    const r = eph(`Updated for **this server only**: ${what}${sub === 'reset' ? ' (reset to default)' : ''}.`);
    return i.deferred ? i.editReply(r) : i.reply(r);
  } catch (e) {
    console.warn('[profile] server change failed:', e?.status, e?.code, e?.message);
    const r = bad(apiError(e));
    return i.deferred ? i.editReply(r) : i.reply(r);
  }
}

/* ---------------- global (owner only) ---------------- */
function applyPresence(client) {
  const p = store.get(BOT_KEY).presence || { status: 'online', type: 'listening', text: '/play' };
  const activities = p.text ? [{ name: p.text, type: ACTIVITY[p.type] ?? ActivityType.Listening }] : [];
  client.user.setPresence({ status: p.status || 'online', activities });
  return p;
}

// Read-only profile cards are available to every member; replies are private to the invoker.
const statusLabel = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible (appears offline)', offline: 'Offline' };
function presenceFields(client) {
  const presence = client.user.presence;
  const status = presence?.status;
  const names = { 0: 'Playing', 1: 'Streaming', 2: 'Listening to', 3: 'Watching', 4: 'Custom', 5: 'Competing in' };
  const activity = (presence?.activities || []).map(a => `${names[a.type] || 'Activity'}: ${a.name}`).join('\n');
  return [
    { name: 'Status', value: statusLabel[status] || status || 'Not available from the current session' },
    { name: 'Activity', value: activity.slice(0, 1024) || 'None in the current session' },
  ];
}
async function botProfileView(i, client) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const u = await client.rest.get(Routes.user('@me'));
    let about;
    try { about = (await client.application.fetch()).description; } catch { /* Do not present cached app text as live. */ }
    const e = theme.embed('profile','Global Pulse profile')
      .addFields({ name: 'Username', value: u.username }, ...presenceFields(client),
        { name: 'Bio', value: typeof u.bio === 'string' ? (u.bio.slice(0, 1024) || 'Not set') : 'Not provided by Discord' });
    if (about !== undefined) e.addFields({ name: 'About (app description)', value: about?.slice(0, 1024) || 'Not set' });
    e.setThumbnail(u.avatar ? client.rest.cdn.avatar(u.id, u.avatar, { size: 256 }) : client.user.defaultAvatarURL);
    if (u.banner) e.setImage(client.rest.cdn.banner(u.id, u.banner, { size: 512 }));
    e.setFooter({ text: 'Current session status and activity | Saved presence settings persist across restarts' }).setTimestamp();
    return i.editReply({ embeds: [e] });
  } catch (e) {
    console.warn('[profile] global view failed:', e?.status, e?.code);
    return i.editReply(bad('Could not read the current bot profile from Discord. Try again shortly.'));
  }
}
async function botSettings(i, client, isOwner) {
  if (i.options.getSubcommand() === 'view') return botProfileView(i, client);
  return i.reply(bad('Global bot editing has moved to the owner-only web dashboard. Use /dashboard.'));
}

// Browser profile images are inline uploads, never arbitrary fetch URLs.
function webImage(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Choose an image file.');
  const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || m[2].length > 2800000 || m[2].length % 4) throw new Error('Use a PNG, JPG, GIF or WebP file up to 2 MB.');
  const b = Buffer.from(m[2], 'base64');
  const type = b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : b[0]===255 && b[1]===216 && b[2]===255 ? 'jpeg' : /^GIF8[79]a$/.test(b.subarray(0,6).toString()) ? 'gif' : b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WEBP' ? 'webp' : '';
  if (b.length > 2*1024*1024 || b.length < 12 || type !== m[1]) throw new Error('The file contents must match its image type (up to 2 MB).');
  return value;
}
async function webRead(client, guildId) {
  const u = await client.rest.get(Routes.user('@me'));
  if (guildId) {
    const m = await client.rest.get(Routes.guildMember(guildId, client.user.id));
    return {name:m.nick||u.username,custom:!!m.avatar,avatar:m.avatar ? client.rest.cdn.guildMemberAvatar(guildId,client.user.id,m.avatar,{size:256}) : client.rest.cdn.avatar(u.id,u.avatar,{size:256})};
  }
  const a = await client.rest.get('/applications/@me');
  return {name:u.username,avatar:u.avatar?client.rest.cdn.avatar(u.id,u.avatar,{size:256}):client.user.defaultAvatarURL,banner:u.banner?client.rest.cdn.banner(u.id,u.banner,{size:512}):null,about:a.description||''};
}
async function webUpdate(client, guildId, userId, body) {
  const patch = {};
  if (Object.hasOwn(body,'avatar')) patch.avatar=webImage(body.avatar);
  if (guildId) {
    if (!Object.keys(patch).length || Object.keys(body).some(k=>!['avatar','guildId'].includes(k))) throw new Error('This form changes only the photo for the selected server.');
    await client.rest.patch(Routes.guildMember(guildId,'@me'),{body:patch,reason:'Server photo changed in Pulse dashboard by '+userId});
  } else {
    if (Object.hasOwn(body,'name')) {if(typeof body.name!=='string'||body.name.trim().length<2||body.name.trim().length>32)throw new Error('Use a bot name between 2 and 32 characters.');patch.username=body.name.trim();}
    if (Object.hasOwn(body,'banner')) patch.banner=webImage(body.banner);
    if (Object.keys(body).some(k=>!['name','avatar','banner','about','guildId'].includes(k))) throw new Error('Unknown global profile field.');
    if (body.about!==undefined && (typeof body.about!=='string'||body.about.length>400)) throw new Error('About text must be at most 400 characters.');
    if (!Object.keys(patch).length && body.about===undefined)throw new Error('Choose something to change.');
    let applied=false;
    try {
      if(Object.keys(patch).length){await client.rest.patch(Routes.user('@me'),{body:patch});applied=true;}
      if(body.about!==undefined)await client.rest.patch('/applications/@me',{body:{description:body.about}});
    } catch(e){if(applied)throw new Error('The account name/photo update succeeded, but the About update failed. Reload to check before retrying.');throw e;}
  }
  return {ok:true};
}

module.exports = { serverProfile, botSettings, botProfileView, applyPresence, webImage, webRead, webUpdate };
