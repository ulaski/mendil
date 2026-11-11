import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Bot } from './bot.js';

const log = createLogger('bot');

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

const bot = new Bot(config, log);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await bot.shutdown();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

bot.start().catch((err) => {
  log.error('startup failed:', err);
  process.exit(1);
});
