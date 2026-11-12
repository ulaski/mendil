#!/usr/bin/env node
// Fake ffmpeg for tests: reports progress on fd 3 (-progress pipe:3) like the real one.
// Input pipe:0 plays while bytes arrive; an input file holds "len=<s>" and optional "stall=<s>".
const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ bin: 'ffmpeg', args })}\n`);

if (args.some((a) => a.includes('ebur128'))) { // loudness analysis
  process.stderr.write('[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -10.0 LUFS\n');
  process.exit(0);
}

const emit = (us) => {
  try {
    fs.writeSync(3, `out_time_us=${Math.round(us)}\nprogress=continue\n`);
  } catch {
    // no progress pipe
  }
};
const input = args[args.indexOf('-i') + 1];

if (input === 'pipe:0') {
  let bytes = 0;
  let started = null;
  process.stdin.on('data', (d) => {
    bytes += d.length;
    started ??= Date.now();
  });
  const timer = setInterval(() => started && emit((Date.now() - started) * 1000), 50);
  process.stdin.on('end', () => {
    clearInterval(timer);
    if (!bytes) {
      process.stderr.write('pipe:0: Invalid data found when processing input\n');
      process.exit(1);
    }
    process.exit(0);
  });
} else {
  const spec = Object.fromEntries(fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
  const ssAt = args.indexOf('-ss');
  const offset = ssAt !== -1 && ssAt < args.indexOf('-i') ? Number(args[ssAt + 1]) : 0;
  const len = Number(spec.len);
  const stall = spec.stall ? Number(spec.stall) : null;
  const started = Date.now();
  const timer = setInterval(() => {
    const pos = (Date.now() - started) / 1000;
    if (stall !== null && offset + pos >= stall) return; // stuck: alive, but no progress
    emit(pos * 1e6);
    if (offset + pos >= len) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 50);
}
