// Helpers for the TeamSpeak 3 query text protocol (shared by ServerQuery and ClientQuery).

const ESCAPES = [
  ['\\', '\\\\'],
  ['/', '\\/'],
  [' ', '\\s'],
  ['|', '\\p'],
  ['\x07', '\\a'],
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['\v', '\\v'],
];

const UNESCAPE = Object.fromEntries(ESCAPES.map(([raw, esc]) => [esc[1], raw]));

export function escape(value) {
  let out = String(value);
  for (const [raw, esc] of ESCAPES) out = out.split(raw).join(esc);
  return out;
}

export function unescape(value) {
  return String(value).replace(/\\(.)/g, (m, c) => UNESCAPE[c] ?? c);
}

/** "a=1 b=x\sy flag" -> { a: '1', b: 'x y', flag: '' } */
export function parseParams(segment) {
  const out = {};
  for (const token of segment.split(' ')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) out[token] = '';
    else out[token.slice(0, eq)] = unescape(token.slice(eq + 1));
  }
  return out;
}

/** A response line can hold several rows separated by "|". */
export function parseRows(line) {
  return line.split('|').map(parseParams);
}

/** Builds "cmd key=value ... -flag". Undefined/null/empty-string params are omitted. */
export function buildCommand(name, params = {}, flags = []) {
  const parts = [name];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${escape(value)}`);
  }
  for (const flag of flags) parts.push(flag.startsWith('-') ? flag : `-${flag}`);
  return parts.join(' ');
}
