#!/usr/bin/env node
// Fake yt-dlp for tests. Behaviour is chosen by the URL (last argument):
//   ok://<name>        a short track (0.3 s); ok://long streams forever and starts a child
//   ok://stall         its file makes the fake ffmpeg stop progressing after 0.3 s
//   ok://truncated     stream mode: some audio, then an HTTP error
//   fail://bot         YouTube bot check;  fail://<other>  video unavailable
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const url = args[args.length - 1];
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ bin: 'yt-dlp', args })}\n`);

if (url.startsWith('fail://')) {
  process.stderr.write(url === 'fail://bot'
    ? "ERROR: [youtube] abc: Sign in to confirm you're not a bot\n"
    : 'ERROR: [youtube] abc: Video unavailable\n');
  process.exit(1);
}

const len = url === 'ok://long' ? 30 : 0.3;
if (args.includes('--print')) { // download mode (prefetch)
  const file = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm');
  fs.writeFileSync(file, `len=${len}\n${url === 'ok://stall' ? 'stall=0.3\n' : ''}`);
  process.stdout.write(`${file}\n`);
  process.exit(0);
}

// stream mode
if (url === 'ok://long' && process.env.FAKE_CHILD_PIDFILE) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' }); // like yt-dlp's own helpers
  fs.writeFileSync(process.env.FAKE_CHILD_PIDFILE, String(child.pid));
}
const started = Date.now();
const timer = setInterval(() => {
  process.stdout.write('x'.repeat(256));
  const elapsed = (Date.now() - started) / 1000;
  if (url === 'ok://truncated' && elapsed > 0.3) {
    process.stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden\n');
    process.exit(1);
  }
  if (url !== 'ok://long' && elapsed > len) {
    clearInterval(timer);
    process.exit(0);
  }
}, 50);
