'use strict';
// Queue browser for long queues (100+ songs). Discord Components V2, shown privately to whoever opens it.
// Pick a song from the list, then Play now / Play next / Move to position / Remove.
const crypto = require('crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, MessageFlags,
} = require('discord.js');
const icons = require('./icons');
const theme = require('./theme');
const suggestions=require('./autoplay');
const { fmt } = require('./card');
const { esc } = require('./actions');
const store = require('./store');

const PER = 5; // compact page: thumbnails stay readable on a phone and the page stays well under Discord's 40-component limit
const FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const hash = (t) => crypto.createHash('md5').update(String(t.encoded || t.info.uri || t.info.title)).digest('hex').slice(0, 6);
const dur = (t) => (t.info.isStream ? 'live' : fmt(t.info.duration));
const b = (id, label, style = ButtonStyle.Secondary, emoji, disabled = false) => {
  const x = new ButtonBuilder().setCustomId(id).setStyle(style).setDisabled(disabled);
  if (label) x.setLabel(label);
  if (emoji) x.setEmoji(emoji);
  return x;
};
const pagesOf = (p) => Math.max(1, Math.ceil(p.queue.tracks.length / PER));

function trackText(t, n) {
  return `${n ? `\`${n}.\` ` : ''}**${esc(t.info.title)}**\n${esc(t.info.author)} · ${dur(t)}`;
}
function trackBlock(c, t, n) {
  const text = new TextDisplayBuilder().setContent(trackText(t, n));
  if (t.info.artworkUrl) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(t.info.artworkUrl)));
  else c.addTextDisplayComponents(text);
}

function listView(player, page = 1, notice = '') {
  const tracks = player.queue.tracks;
  const pages = pagesOf(player);
  page = Math.min(Math.max(1, page), pages);
  const c = new ContainerBuilder().setAccentColor(theme.palette.queue);
  const cur = player.queue.current;
  const total = tracks.reduce((a, x) => a + (x.info.isStream ? 0 : x.info.duration || 0), 0);
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    [notice, cur ? `**Now playing:** ${esc(cur.info.title)}` : '', tracks.length ? `## Queue
${tracks.length} songs · ${fmt(total)} · page ${page}/${pages}` : '**The queue is empty.**'].filter(Boolean).join('\n')));
  const start = (page - 1) * PER;
  const slice = tracks.slice(start, start + PER);
  slice.forEach((t, i) => trackBlock(c, t, start + i + 1));
  const rows = [];
  if (slice.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('qu:sel').setPlaceholder('Choose a song to manage')
      .addOptions(slice.map((t, i) => ({ label: `${start + i + 1}. ${t.info.title}`.slice(0, 100), description: `${t.info.author} · ${dur(t)}`.slice(0, 100), value: String(start + i) })))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    b('qu:pg:1:first', '', ButtonStyle.Secondary, icons.get('chevrons-left', '⏪'), page <= 1),
    b(`qu:pg:${page - 1}:prev`, '', ButtonStyle.Secondary, icons.get('chevron-left', '◀️'), page <= 1),
    b('qu:jump', `${page} / ${pages}`, ButtonStyle.Secondary, undefined, pages <= 1),
    b(`qu:pg:${page + 1}:next`, '', ButtonStyle.Secondary, icons.get('chevron-right', '▶️'), page >= pages),
    b(`qu:pg:${pages}:last`, '', ButtonStyle.Secondary, icons.get('chevrons-right', '⏩'), page >= pages),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    b('qu:goto', 'Go to song #', ButtonStyle.Secondary, icons.get('hash', '#️⃣'), !tracks.length),
    b(`qu:shuf:${page}`, 'Shuffle', ButtonStyle.Secondary, icons.get('shuffle', '🔀'), tracks.length < 2),
  ));
  const auto=suggestions.view(player);const extra=[];
  if(store.get(player.guildId).autoplay){const ac=new ContainerBuilder().setAccentColor(theme.palette.discovery);ac.addTextDisplayComponents(new TextDisplayBuilder().setContent('## Autoplay suggestions\n'+(auto.tracks.length?auto.tracks.map((x,n)=>`**${n+1}.** ${esc(x.track.info.title)} · ${esc(x.track.info.author)}`).join('\n'):(auto.loading?'Finding playable suggestions…':auto.error||'Suggestions appear when the human queue is empty.'))));if(auto.tracks.length)ac.addActionRowComponents(new ActionRowBuilder().addComponents(auto.tracks.map((x,n)=>b(`qu:ar:${x.id}:${auto.version}`,`Remove ${n+1}`,ButtonStyle.Secondary))));extra.push(ac);}
  return { components: [c, ...rows, ...extra], flags: FLAGS };
}

function songView(player, idx, notice = '') {
  const t = player.queue.tracks[idx];
  if (!t) return listView(player, 1, 'That song is no longer in the queue.');
  const h = hash(t);
  const c = new ContainerBuilder().setAccentColor(theme.palette.queue);
  if (notice) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(notice));
  trackBlock(c, t, idx + 1);
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Position ${idx + 1} of ${player.queue.tracks.length}`));
  const row1 = new ActionRowBuilder().addComponents(
    b(`qu:now:${idx}:${h}`, 'Play now', ButtonStyle.Primary, icons.get('play', '▶️')),
    b(`qu:next:${idx}:${h}`, 'Play next', ButtonStyle.Secondary, icons.get('skip-forward', '⏭️')),
    b(`qu:mv:${idx}:${h}`, 'Move to position', ButtonStyle.Secondary, icons.get('arrow-up-down', '↕️')),
    b(`qu:rm:${idx}:${h}`, 'Remove', ButtonStyle.Secondary, icons.get('trash-2', '🗑️')),
  );
  const row2 = new ActionRowBuilder().addComponents(b(`qu:back:${Math.floor(idx / PER) + 1}`, 'Back to queue', ButtonStyle.Secondary, icons.get('chevron-left', '◀️')));
  return { components: [c, row1, row2], flags: FLAGS };
}

const modal = (id, title, label, placeholder) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6)));

const save = (p) => p.queue.utils.save().catch(() => {});

/**
 * Handles every "qu:" interaction. ctx: { lava, panel, client, canControl(i, player) -> bool }.
 * Returns true when the interaction was ours.
 */
async function handle(i, ctx) {
  const id = i.customId;
  if (!id || !id.startsWith('qu:')) return false;
  const player = ctx.lava.getPlayer(i.guildId);
  const gone = () => i.reply({ ...theme.message('Nothing is playing.','idle'), flags: MessageFlags.Ephemeral });
  if (!player) { await gone(); return true; }
  const [, op, a, h] = id.split(':');
  const upd = (v) => (i.isFromMessage?.() || i.isMessageComponent() ? i.update(v) : i.reply(v));
  const deny = () => i.reply({ ...theme.message(`Join <#${player.voiceChannelId}> to change the queue.`,'warning'), flags: MessageFlags.Ephemeral });
  const mutating = ['now', 'next', 'mv', 'mvm', 'rm', 'shuf','ar'].includes(op);
  if (mutating && !ctx.canControl(i, player)) { await deny(); return true; }

  const find = (idx) => { const t = player.queue.tracks[idx]; return t && hash(t) === h ? t : null; };
  const stale = () => upd(listView(player, 1, 'The queue changed, so I refreshed it. Pick the song again.'));
  const tracks = player.queue.tracks;

  switch (op) {
    case 'ar': {const ok=suggestions.dismiss(player,a,h);await upd(listView(player,1,ok?'Autoplay suggestion removed.':'Suggestions changed. Refreshed the list.'));break;}
    case 'pg': await upd(listView(player, Number(a))); break;
    case 'back': await upd(listView(player, Number(a))); break;
    case 'sel': await upd(songView(player, Number(i.values[0]))); break;
    case 'jump': await i.showModal(modal('qu:jumpm', 'Go to page', `Page number (1 to ${pagesOf(player)})`, 'e.g. 4')); break;
    case 'jumpm': {
      const n = parseInt(i.fields.getTextInputValue('n'), 10);
      await upd(listView(player, Number.isInteger(n) ? n : 1, Number.isInteger(n) && n >= 1 && n <= pagesOf(player) ? '' : `Enter a page from 1 to ${pagesOf(player)}.`));
      break;
    }
    case 'goto': await i.showModal(modal('qu:gotom', 'Go to song', 'Song number in the queue', `1 to ${tracks.length}`)); break;
    case 'gotom': {
      const n = parseInt(i.fields.getTextInputValue('n'), 10);
      if (!Number.isInteger(n) || n < 1 || n > tracks.length) return (await upd(listView(player, 1, `Enter a number from 1 to ${tracks.length}.`)), true);
      await upd(songView(player, n - 1));
      break;
    }
    case 'shuf': {
      if (tracks.length > 1) await player.queue.shuffle();
      await upd(listView(player, 1, 'Queue shuffled.'));
      if (player.queue.current) ctx.panel.postPanel(ctx.client, player).catch(() => {});
      break;
    }
    case 'now': {
      const idx = Number(a); const t = find(idx);
      if (!t) { await stale(); break; }
      tracks.splice(idx, 1); tracks.unshift(t); await save(player);
      await upd(listView(player, 1, `Playing **${esc(t.info.title)}** now.`));
      await player.skip(0, false);
      break;
    }
    case 'next': {
      const idx = Number(a); const t = find(idx);
      if (!t) { await stale(); break; }
      tracks.splice(idx, 1); tracks.unshift(t); await save(player);
      await upd(listView(player, 1, `**${esc(t.info.title)}** will play next.`));
      if (player.queue.current) ctx.panel.postPanel(ctx.client, player).catch(() => {});
      break;
    }
    case 'rm': {
      const idx = Number(a); const t = find(idx);
      if (!t) { await stale(); break; }
      tracks.splice(idx, 1); await save(player);
      await upd(listView(player, Math.floor(idx / PER) + 1, `Removed **${esc(t.info.title)}**.`));
      if (player.queue.current) ctx.panel.postPanel(ctx.client, player).catch(() => {});
      break;
    }
    case 'mv': {
      if (!find(Number(a))) { await stale(); break; }
      await i.showModal(modal(`qu:mvm:${a}:${h}`, 'Move to position', `New position (1 to ${tracks.length})`, `1 = plays next`));
      break;
    }
    case 'mvm': {
      const idx = Number(a); const t = find(idx);
      if (!t) { await stale(); break; }
      const n = parseInt(i.fields.getTextInputValue('n'), 10);
      if (!Number.isInteger(n) || n < 1 || n > tracks.length) return (await upd(songView(player, idx, `Enter a number from 1 to ${tracks.length}.`)), true);
      tracks.splice(idx, 1); tracks.splice(n - 1, 0, t); await save(player);
      await upd(songView(player, n - 1, `Moved to position ${n}.`));
      if (player.queue.current) ctx.panel.postPanel(ctx.client, player).catch(() => {});
      break;
    }
    default: await i.deferUpdate().catch(() => {});
  }
  return true;
}

module.exports = { handle, listView, songView };
