'use strict';
// Playback actions shared by slash commands and panel buttons.
const store = require('./store');
const { st } = require('./state');
const { refreshPanel, postPanel, removePanel } = require('./panel');
const { fmt } = require('./card');

const suggestions=require('./autoplay');
const STEP = 15_000; // dedicated -15s / +15s buttons and the default for /forward and /rewind

async function pauseToggle(player) { return player.paused ? player.resume() : player.pause(); }

async function skip(player) {
  if (!player.queue.tracks.length && !store.get(player.guildId).autoplay) return player.stopPlaying(false, false);
  return player.skip(0, false);
}

async function previous(player) {
  const prev = player.queue.previous[0];
  if (!prev) {
    // no history: restart the current track
    return player.seek(0);
  }
  const cur = player.queue.current;
  if (cur) await player.queue.add(cur, 0);
  return player.play({ clientTrack: prev });
}

async function seekBy(player, deltaMs) {
  const t = player.queue.current;
  if (!t || t.info.isStream || !t.info.isSeekable) return false;
  const to = Math.min(Math.max(0, player.position + deltaMs), Math.max(0, t.info.duration - 1000));
  await player.seek(to);
  return true;
}

async function stop(client, player) {
  suggestions.suspend(player);
  require('./recovery').discard(player.guildId);
  await player.stopPlaying(true, false);
  await removePanel(player,client);
}

async function leave(client, player) {
  suggestions.clear(player.guildId);
  require('./recovery').discard(player.guildId);
  const gid = player.guildId;
  store.set(gid, { twentyFourSeven: false, voiceChannelId: null });
  await removePanel(player,client);
  await player.destroy('leave');
  require('./state').clear(gid);
}

async function loopCycle(player) {
  const next = { off: 'queue', queue: 'track', track: 'off' }[player.repeatMode] || 'off';
  await player.setRepeatMode(next);
  return next;
}

async function setVolume(player, v) {
  v = Math.min(100, Math.max(0, Math.round(v)));
  await player.setVolume(v);
  store.set(player.guildId, { volume: v });
  return v;
}

function toggleAutoplay(guildId) {
  const on = !store.get(guildId).autoplay;
  store.set(guildId, { autoplay: on });
  suggestions.manual({guildId});
  return on;
}

function toggle247(player) {
  const s = store.get(player.guildId);
  const on = !s.twentyFourSeven;
  store.set(player.guildId, { twentyFourSeven: on, voiceChannelId: on ? player.voiceChannelId : null, textChannelId: player.textChannelId });
  return on;
}

function queuePage(player, page = 1, per = 10) {
  const t = player.queue.tracks;
  const pages = Math.max(1, Math.ceil(t.length / per));
  page = Math.min(Math.max(1, page), pages);
  const cur = player.queue.current;
  const lines = t.slice((page - 1) * per, page * per).map((x, i) => `\`${(page - 1) * per + i + 1}.\` ${esc(x.info.title)} - ${esc(x.info.author)} \`${x.info.isStream ? 'live' : fmt(x.info.duration)}\``);
  const total = t.reduce((a, x) => a + (x.info.isStream ? 0 : x.info.duration || 0), 0);
  return {
    pages, page,
    text: [
      cur ? `**Now playing**\n${esc(cur.info.title)} - ${esc(cur.info.author)}` : 'Nothing playing.',
      lines.length ? `\n**Up next**\n${lines.join('\n')}` : '\nThe queue is empty.',
      t.length ? `\n${t.length} track${t.length === 1 ? '' : 's'}, ${fmt(total)} total` : '',
    ].join('\n'),
  };
}
const esc = (s = '') => String(s).replace(/([*_`~|>\[\]])/g, '\\$1').slice(0, 90);

module.exports = { pauseToggle, skip, previous, seekBy, stop, leave, loopCycle, setVolume, toggleAutoplay, toggle247, queuePage, STEP, esc };
