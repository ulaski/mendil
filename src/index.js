import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Bot } from './bot.js';
import { PanelServer } from './panel/server.js';
import { LANGUAGES } from './i18n/index.js';

const log = createLogger('bot');

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

if (!LANGUAGES[config.bot.language]) {
  log.warn(`unknown BOT_LANGUAGE "${config.bot.language}", using English. Available: ${Object.keys(LANGUAGES).join(', ')}`);
}

const bot = new Bot(config, log);
const panel = config.panel.port ? new PanelServer({ bot, config, log: log.child('panel') }) : null;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await panel?.stop();
    await bot.shutdown();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

panel?.start().catch((err) => log.error(`web panel could not start: ${err.message}`));
bot.start().catch((err) => {
  log.error('startup failed:', err);
  process.exit(1);
});
