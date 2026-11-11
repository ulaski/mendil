const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line, ...args);
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
