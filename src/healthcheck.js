// Docker HEALTHCHECK: healthy while the bot is connected to the TeamSpeak server.
// The bot touches HEALTH_FILE every watchdog tick (10s) while connected.
import fs from 'node:fs';
import { HEALTH_FILE } from './bot.js';

const MAX_AGE_MS = 60_000;

try {
  const age = Date.now() - fs.statSync(HEALTH_FILE).mtimeMs;
  process.exit(age < MAX_AGE_MS ? 0 : 1);
} catch {
  process.exit(1);
}
