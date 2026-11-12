import fs from 'node:fs';

// Processes worth watching, by /proc/<pid>/comm (which is cut to 15 characters).
const WATCHED = {
  ts3client_linux: 'ts3client',
  QtWebEngineProc: 'qtwebengine',
  Xvfb: 'xvfb',
  pulseaudio: 'pulse',
  node: 'node',
  'node-MainThread': 'node', // Node 26+ names its main thread
  ffmpeg: 'ffmpeg',
};
const CLOCK_TICKS = 100; // USER_HZ on Linux

/** CPU seconds and RSS (MB) per watched process group, read from /proc. Empty off Linux. */
export function readProcessStats() {
  const totals = {};
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return totals;
  }
  for (const pid of pids) {
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      const name = WATCHED[comm];
      if (!name) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cpu = (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS; // utime + stime
      const rssKb = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
      const t = (totals[name] ??= { cpu: 0, rssMb: 0, count: 0 });
      t.cpu += cpu;
      t.rssMb += rssKb / 1024;
      t.count++;
    } catch {
      // process exited meanwhile
    }
  }
  return totals;
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Builds a periodic one-line summary: CPU % and RSS per process, plus playback timings. */
export class StatsReporter {
  #prev = null;

  sample(now, { gaps = [], loads = [], resolves = [] } = {}) {
    const procs = readProcessStats();
    const parts = [];
    for (const [name, t] of Object.entries(procs).sort()) {
      const prev = this.#prev?.procs[name];
      const seconds = this.#prev ? (now - this.#prev.at) / 1000 : 0;
      const cpu = prev && seconds > 0 ? `${(((t.cpu - prev.cpu) / seconds) * 100).toFixed(1)}%` : '-';
      parts.push(`${name}=${cpu}/${Math.round(t.rssMb)}MB`);
    }
    this.#prev = { at: now, procs };
    const ms = (v) => (v === null ? '-' : `${v}`);
    const timing = (label, list) => `${label} p50/p95=${ms(percentile(list, 50))}/${ms(percentile(list, 95))}ms (n=${list.length})`;
    return [`cpu/rss ${parts.join(' ') || '-'}`, timing('gap', gaps), timing('load', loads), timing('resolve', resolves)].join(' | ');
  }
}
