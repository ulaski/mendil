import os from 'node:os';
import path from 'node:path';
import { parseStations } from './radio.js';

const env = process.env;

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function list(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Accepts "host", "host:port" or "[ipv6]:port". */
function parseHost(raw, defaultPort) {
  const value = (raw ?? '').trim();
  const v6 = value.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: int(v6[2], defaultPort) };
  const parts = value.split(':');
  if (parts.length === 2) return { host: parts[0], port: int(parts[1], defaultPort) };
  return { host: value, port: defaultPort };
}

export function loadConfig() {
  const { host, port } = parseHost(env.TS3_HOST, int(env.TS3_PORT, 9987));
  if (!host) {
    throw new Error('TS3_HOST is not set. Copy .env.example to .env and fill in your server address.');
  }

  const configDir = env.TS3_CONFIG_DIR || path.join(os.homedir(), '.ts3client');
  // Mendil's own persistent files live on the same volume as the TS3 identity.
  const dataDir = env.MENDIL_DATA_DIR || path.join(configDir, 'mendil');

  const backend = (env.VOICE_BACKEND || 'classic').toLowerCase();
  if (!['classic', 'native'].includes(backend)) {
    throw new Error(`VOICE_BACKEND must be "classic" or "native", not "${env.VOICE_BACKEND}".`);
  }

  return {
    dataDir,
    voice: {
      backend,
      // Opus bitrate of the native engine (CBR). 192 kbit/s is the most a voice packet holds.
      bitrate: int(env.NATIVE_BITRATE, 128, { min: 48, max: 192 }),
    },
    ts3: {
      host,
      port,
      serverPassword: env.TS3_SERVER_PASSWORD || '',
      nickname: env.BOT_NICKNAME || 'Mendil',
      channel: env.TS3_CHANNEL || '',
      channelPassword: env.TS3_CHANNEL_PASSWORD || '',
      clientDir: env.TS3_CLIENT_DIR || '/opt/ts3client',
      configDir,
      queryPort: int(env.TS3_CLIENTQUERY_PORT, 25639),
    },
    bot: {
      language: (env.BOT_LANGUAGE || 'en').toLowerCase(),
      prefix: env.COMMAND_PREFIX || '!',
      allowedUids: list(env.ALLOWED_UIDS),
      allowedGroups: list(env.ALLOWED_GROUPS),
      // Roles (src/roles.js): admins control playback; with none set, every allowed user is one.
      adminUids: list(env.ADMIN_UIDS),
      adminGroups: list(env.ADMIN_GROUPS),
      channelHints: bool(env.CHANNEL_HINTS, true),
      // Pause (and stop transmitting) while nobody else is in the bot's channel.
      pauseWhenAlone: bool(env.PAUSE_WHEN_ALONE, true),
      announceTracks: bool(env.ANNOUNCE_TRACKS, true),
    },
    player: {
      sink: env.PULSE_SINK || 'tsbot',
      defaultVolume: int(env.DEFAULT_VOLUME, 70, { min: 0, max: 100 }),
      normalize: bool(env.NORMALIZE_AUDIO, true),
      maxQueue: int(env.MAX_QUEUE, 100, { min: 1 }),
      maxPlaylistItems: int(env.MAX_PLAYLIST_ITEMS, 50, { min: 1 }),
      maxTrackDuration: int(env.MAX_TRACK_DURATION, 0, { min: 0 }),
      allowPrivateUrls: bool(env.ALLOW_PRIVATE_URLS, false),
      cookiesFile: env.YTDLP_COOKIES_FILE || '',
      proxy: env.YTDLP_PROXY || '',
      cacheDir: path.join(dataDir, 'yt-dlp-cache'), // player JS etc.; speeds up extraction
      prefetch: bool(env.PREFETCH, true),
      prefetchDir: env.PREFETCH_DIR || '/tmp/mendil-cache',
      prefetchMaxDuration: int(env.PREFETCH_MAX_DURATION, 30 * 60, { min: 0 }),
    },
    radio: {
      stations: parseStations(env.RADIO_STATIONS),
      // Station name or stream address that plays whenever the queue is empty, from the start.
      default: (env.RADIO || '').trim(),
    },
    panel: {
      // 0 turns the web panel off. In Docker, publish the port to reach it (see README).
      port: int(env.PANEL_PORT, 8080, { min: 0, max: 65535 }),
      host: env.PANEL_HOST || '0.0.0.0',
      password: env.PANEL_PASSWORD || '',
      // Behind a reverse proxy, take the client address from X-Forwarded-For (for the login limit).
      trustProxy: bool(env.PANEL_TRUST_PROXY, false),
    },
    ytdlp: {
      autoUpdate: bool(env.YTDLP_AUTO_UPDATE, true),
      venv: env.YTDLP_VENV || '/opt/yt-dlp',
    },
  };
}
