import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const BINARY = 'ts3client_linux_amd64';
const PLUGIN = path.join('plugins', 'libclientquery_plugin_linux_amd64.so');
const BOOTSTRAP_TIMEOUT_MS = 120_000;

/** Single-quoted SQL string literal. */
const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Profile values are stored as newline-separated key=value blobs. */
const blob = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');

/**
 * Manages the official TeamSpeak 3 client process running headless under Xvfb.
 *
 * The client is normally unusable without a human: on first start it shows a license
 * dialog and only then downloads/enables the ClientQuery plugin. We work around it by
 *  1) starting it once so it creates settings.db and installs ClientQuery ("bootstrap"),
 *  2) writing the settings a human would click through (license accepted, PulseAudio
 *     capture with continuous transmission) directly into settings.db.
 *
 * Events: 'exit' (code, signal) when the process dies without stop() being called.
 */
export class Ts3ClientProcess extends EventEmitter {
  #child = null;
  #stopping = false;

  constructor({ clientDir, configDir, log }) {
    super();
    this.clientDir = clientDir;
    this.configDir = configDir;
    this.log = log;
    this.startedAt = 0;
  }

  get dbPath() {
    return path.join(this.configDir, 'settings.db');
  }

  get running() {
    return this.#child !== null;
  }

  async prepare() {
    if (!this.#isBootstrapped()) await this.#bootstrap();
    this.#seedSettings();
  }

  readApiKey() {
    const ini = fs.readFileSync(path.join(this.configDir, 'clientquery.ini'), 'utf8');
    const match = ini.match(/^api_key=(.+)$/m);
    if (!match) throw new Error('api_key not found in clientquery.ini');
    return match[1].trim();
  }

  /** @param {string[]} args e.g. a ts3server:// URL to connect to right away */
  start(args = []) {
    if (this.#child) return;
    this.#stopping = false;
    this.startedAt = Date.now();

    const child = spawn(path.join(this.clientDir, BINARY), args, {
      cwd: this.clientDir,
      env: {
        ...process.env,
        // same as the bundled ts3client_runscript.sh
        KDEDIRS: '',
        KDEDIR: '',
        QTDIR: '.',
        QT_PLUGIN_PATH: '.',
        LD_LIBRARY_PATH: `.:${process.env.LD_LIBRARY_PATH ?? ''}`,
        QTWEBENGINE_DISABLE_SANDBOX: '1',
        DISPLAY: process.env.DISPLAY || ':99',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.log.info(`TeamSpeak client started (pid ${child.pid})`);

    const forward = (data) => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        if (/Connect status|Disconnected|kicked|banned|ERROR\s*\|.*(Connect|Server)/i.test(line)) {
          this.log.info(line.replace(/^\S+\s+\S+\|/, '').trim());
        } else this.log.debug(line);
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    child.on('exit', (code, signal) => {
      this.#child = null;
      if (this.#stopping) return;
      this.log.warn(`TeamSpeak client exited unexpectedly (code=${code}, signal=${signal})`);
      this.emit('exit', code, signal);
    });
  }

  async stop(timeoutMs = 10_000) {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const result = await Promise.race([exited.then(() => 'exited'), sleep(timeoutMs).then(() => 'timeout')]);
    if (result === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
    this.#child = null;
  }

  #isBootstrapped() {
    return [this.dbPath, path.join(this.configDir, 'clientquery.ini'), path.join(this.configDir, PLUGIN)].every(
      (f) => fs.existsSync(f),
    );
  }

  #query(statement) {
    return execFileSync('sqlite3', [this.dbPath], { input: statement, encoding: 'utf8' }).trim();
  }

  async #bootstrap() {
    this.log.info('First start: letting the TeamSpeak client create its config and install ClientQuery…');
    fs.mkdirSync(this.configDir, { recursive: true });
    this.start();

    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline && this.running) {
      await sleep(1_000);
      if (!this.#isBootstrapped()) continue;
      let licenseKnown = false;
      try {
        licenseKnown = this.#query("SELECT value FROM General WHERE key='LicenseVersion';") !== '';
      } catch {
        // database may still be locked/being created
      }
      if (licenseKnown) {
        ready = true;
        break;
      }
    }
    await sleep(2_000); // let the client finish writing settings
    await this.stop();

    if (!this.#isBootstrapped()) {
      throw new Error(
        'TeamSpeak client bootstrap failed: ClientQuery plugin was not installed. ' +
          'The client downloads it on first start, so the container needs internet access.',
      );
    }
    if (!ready) this.log.warn('License version not found in settings.db, assuming version 5');
    this.log.info('Bootstrap finished');
  }

  #seedSettings() {
    const capture = blob({ Mode: 'PulseAudio', Device: '', DeviceDisplayName: '' });
    const preprocessing = blob({
      continous_transmission: 'true', // (sic) TeamSpeak's own spelling
      vad: 'false',
      vad_over_ptt: 'false',
      vad_mode: '0',
      voiceactivation_level: '-40',
      agc: 'false',
      denoise: 'false',
      echo_cancellation: 'false',
    });
    const playback = blob({ Mode: 'PulseAudio', Device: '', DeviceDisplayName: '', VolumeModifier: '0' });

    const now = "strftime('%s','now')";
    const table = (name) =>
      `CREATE TABLE IF NOT EXISTS ${name} (timestamp INTEGER UNSIGNED NOT NULL, key VARCHAR NOT NULL UNIQUE, value VARCHAR);`;
    const put = (tableName, key, value) =>
      `INSERT OR REPLACE INTO ${tableName}(timestamp,key,value) VALUES(${now},${sql(key)},${value});`;

    this.#query(
      [
        table('General'),
        table('Profiles'),
        // Mark the current license version as already accepted -> no blocking license dialog.
        put('General', 'LastShownLicense', "COALESCE((SELECT value FROM General WHERE key='LicenseVersion'),'5')"),
        // One-time "TeamSpeak 5 / sync" intro dialog; while it is open ts3server:// URLs are ignored.
        put('General', 'SyncOverviewShown', sql('1')),
        put('Profiles', 'DefaultCaptureProfile', sql('Default')),
        put('Profiles', 'DefaultPlaybackProfile', sql('Default')),
        put('Profiles', 'Capture/Default', sql(capture)),
        put('Profiles', 'Capture/Default/PreProcessing', sql(preprocessing)),
        put('Profiles', 'Playback/Default', sql(playback)),
      ].join('\n'),
    );
    this.log.debug('settings.db seeded');
  }
}
