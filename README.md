# Pulse music bot

A Node.js Discord music bot with Lavalink playback, a live player card, queue controls, multiple audio-node failover and an optional Discord OAuth web controller.

This is a standalone source snapshot with fresh history. It contains no deployment credentials or saved server settings. It does not connect you to an existing bot.

## Requirements

- Node.js 20 or newer and npm.
- Your own Discord application and bot token.
- A compatible Lavalink v4 server. Public fallback nodes are included, but their availability and playback support are not guaranteed. You can supply your own nodes with `LAVALINK_NODES`.
- For the optional web controller: an HTTPS origin and your own Discord OAuth client secret.

## Install

```sh
git clone https://github.com/rahul000ehb-create/pulse-music-public.git
cd pulse-music-public
npm ci
cp .env.example .env
```

Fill `DISCORD_TOKEN` in `.env` with your own bot token. Set `CLIENT_ID` to your Discord application ID if using the web controller. Invite your application to a server with `bot` and `applications.commands` scopes and the text/voice permissions needed for playback. Then start:

```sh
npm start
```

Commands register at startup. `DEV_GUILD_ID` can limit registration to one development server. Global command updates may take time to appear.

## Web controller

Set `WEB_BASE_URL` to your exact HTTPS origin, set `DISCORD_CLIENT_SECRET`, and add `WEB_BASE_URL/auth/callback` to your application's OAuth redirect URLs. Use `PORT` or `SERVER_PORT` for the listening port (default 3000). Put HTTPS in front of the Node server. Without `WEB_BASE_URL`, web authentication is disabled.

Discord login requests `identify` and `guilds`. Members of a shared server have music controls. Owner IDs control bot-wide settings. Review the access model before exposing your instance.

## Private runtime data

Keep `.env`, OAuth secrets, session keys, saved sessions, queues and server settings out of Git. The bot writes runtime state under `data/` by default (`DATA_DIR` can override it). Back up that directory privately. Never publish it with the source.

## Checks and helper scripts

```sh
npm test
node --test test/*.test.cjs
npm run nodes:check
```

Tests include mocked/offline checks; passing them is not proof that Discord voice, OAuth or every music source works in your environment. Public audio nodes can fail, and failover cannot guarantee uninterrupted playback. This publication has not been installed or tested on Android and is not a promise of 24/7 hosting.

`npm run preview` renders a sample player card. `node scripts/build-icons.js` rebuilds the bundled icon PNGs from SVG source. No screenshot previews of a private server are included.

## Rights and bundled assets

No new license for the application source is granted by this publication. Bundled Noto fonts retain their SIL Open Font License notice in `assets/fonts/OFL.txt`. Lucide-derived icons retain their notice in `assets/icons/LICENSE-lucide.txt`. Dependency packages retain their own licenses.
