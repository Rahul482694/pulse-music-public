'use strict';
const { SlashCommandBuilder, ChannelType } = require('discord.js');

const defs = [
  new SlashCommandBuilder().setName('controlchannel').setDescription('Choose where shared Pulse music messages appear')
    .addSubcommand(c=>c.setName('view').setDescription('Show this server music-message destination'))
    .addSubcommand(c=>c.setName('set').setDescription('Route music messages to one channel (Manage Server required)').addChannelOption(o=>o.setName('channel').setDescription('Music control channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildVoice).setRequired(true)))
    .addSubcommand(c=>c.setName('reset').setDescription('Use the current VC text chat again (Manage Server required)')),
  new SlashCommandBuilder().setName('dashboard').setDescription('Open the Pulse music dashboard and queue controls'),
  new SlashCommandBuilder().setName('web').setDescription('Open your private Pulse web control panel (no voice channel needed)'),
  new SlashCommandBuilder().setName('play').setDescription('Play a song, playlist, link or uploaded audio/video file')
    .addStringOption((o) => o.setName('query').setDescription('Song name or link (YouTube, Spotify, Apple Music, SoundCloud, Deezer, https file)'))
    .addAttachmentOption((o) => o.setName('file').setDescription('Or upload an audio/video file'))
    .addBooleanOption((o) => o.setName('next').setDescription('Play it right after the current track')),
  new SlashCommandBuilder().setName('lyrics').setDescription('Show lyrics for the current track or a song you name')
    .addStringOption((o) => o.setName('song').setDescription('Song name (optional, defaults to the current track)')),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel and clear the queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  new SlashCommandBuilder().setName('previous').setDescription('Go back to the previous track'),
  new SlashCommandBuilder().setName('forward').setDescription('Jump forward in the track')
    .addIntegerOption((o) => o.setName('seconds').setDescription('Seconds (default 15)').setMinValue(1).setMaxValue(600)),
  new SlashCommandBuilder().setName('rewind').setDescription('Jump back in the track')
    .addIntegerOption((o) => o.setName('seconds').setDescription('Seconds (default 15)').setMinValue(1).setMaxValue(600)),
  new SlashCommandBuilder().setName('seek').setDescription('Seek to a time, e.g. 1:30')
    .addStringOption((o) => o.setName('time').setDescription('mm:ss or seconds').setRequired(true)),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the player panel again'),
  new SlashCommandBuilder().setName('volume').setDescription('Set the volume')
    .addIntegerOption((o) => o.setName('percent').setDescription('0 to 100').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode')
    .addStringOption((o) => o.setName('mode').setDescription('Loop mode').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle autoplay (keeps music going with similar tracks)'),
  new SlashCommandBuilder().setName('247').setDescription('Toggle 24/7 mode (stay in the voice channel)'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue (stays in the channel)'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue but keep the current track'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a track from the queue')
    .addIntegerOption((o) => o.setName('position').setDescription('Position in the queue').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('sources').setDescription('Show what the connected audio servers can play right now'),
  new SlashCommandBuilder().setName('ping').setDescription('Show the bot latency: Discord gateway, response time and audio server'),
  new SlashCommandBuilder().setName('serverprofile').setDescription("Change Pulse's profile in THIS server only")
    .addSubcommand((c) => c.setName('view').setDescription("Show Pulse's profile in this server"))
    .addSubcommand((c) => c.setName('set').setDescription("Set Pulse's nickname, photo, banner or bio in this server")
      .addStringOption((o) => o.setName('nickname').setDescription('Server nickname').setMaxLength(32))
      .addAttachmentOption((o) => o.setName('photo').setDescription('Server profile photo'))
      .addAttachmentOption((o) => o.setName('banner').setDescription('Server profile banner'))
      .addStringOption((o) => o.setName('bio').setDescription('Server bio').setMaxLength(190)))
    .addSubcommand((c) => c.setName('reset').setDescription('Reset part of the server profile to default')
      .addStringOption((o) => o.setName('field').setDescription('What to reset').setRequired(true)
        .addChoices({ name: 'Nickname', value: 'nickname' }, { name: 'Photo', value: 'photo' }, { name: 'Banner', value: 'banner' }, { name: 'Bio', value: 'bio' }, { name: 'Everything', value: 'all' }))),
  new SlashCommandBuilder().setName('botprofile').setDescription('View the bot profile')
    .addSubcommand((c) => c.setName('view').setDescription('Show the bot username, photo, status and activity')),
  new SlashCommandBuilder().setName('botsettings').setDescription('View the bot profile; editing is in the web dashboard')
    .addSubcommand((c) => c.setName('view').setDescription('Show the global bot profile')),
  new SlashCommandBuilder().setName('vcstatus').setDescription('Show the playing song as the voice channel status (this server)')
    .addStringOption((o) => o.setName('mode').setDescription('Turn it on or off').addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })),
  new SlashCommandBuilder().setName('resumequeue').setDescription('Review and confirm restoring music saved before a restart'),
  new SlashCommandBuilder().setName('health').setDescription('Audio nodes, current player and last playback problem'),
  new SlashCommandBuilder().setName('help').setDescription('How to use this bot'),
].map((c) => c.setDMPermission(false).toJSON());

module.exports = { defs };
