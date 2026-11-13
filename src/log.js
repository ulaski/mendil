import { EventEmitter } from 'node:events';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const KEPT_LINES = 500;

/** Recent log lines for the web panel; emits 'line' ({at, level, scope, text}). */
export const logEvents = new EventEmitter();
const recent = [];

export function recentLogs() {
  return [...recent];
}

function text(args) {
  return args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const at = new Date().toISOString();
  (level === 'error' || level === 'warn' ? console.error : console.log)(`${at} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args);
  const entry = { at, level, scope, text: text(args) };
  recent.push(entry);
  if (recent.length > KEPT_LINES) recent.shift();
  logEvents.emit('line', entry);
}

export function createLogger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
