import net from 'node:net';
import { EventEmitter } from 'node:events';
import { buildCommand, parseParams, parseRows } from './protocol.js';

export class QueryError extends Error {
  constructor(id, message, command) {
    super(`${command.split(' ')[0]} failed: ${message} (id=${id})`);
    this.id = Number(id);
    this.queryMessage = message;
  }
}

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Minimal client for the TeamSpeak 3 *ClientQuery* plugin (telnet on 127.0.0.1:25639).
 *
 * Events:
 *  - 'notify' (name, params)  every notification, e.g. ('notifytextmessage', {...})
 *  - 'close'                  socket closed
 */
export class ClientQuery extends EventEmitter {
  #socket = null;
  #buffer = '';
  #queue = [];
  #current = null;
  #ready = false;
  #greetingDone = null;

  constructor({ host = '127.0.0.1', port = 25639, log }) {
    super();
    this.host = host;
    this.port = port;
    this.log = log;
  }

  get connected() {
    return this.#ready && this.#socket && !this.#socket.destroyed;
  }

  /** Opens the socket, waits for the greeting and authenticates with the API key. */
  async connect(apiKey) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.#socket = socket;
      socket.setEncoding('utf8');
      socket.setKeepAlive(true, 15_000);

      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          socket.destroy();
          reject(err);
        } else resolve();
      };
      // The greeting ends with a line mentioning "auth"; fall back to a timeout.
      const timer = setTimeout(() => finish(), 2_000);
      this.#greetingDone = () => finish();

      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('error', (err) => {
        if (!settled) finish(err);
        else this.log.warn('socket error:', err.message);
      });
      socket.on('close', () => {
        if (!settled) finish(new Error('ClientQuery closed during greeting'));
        this.#teardown(new Error('ClientQuery connection closed'));
        this.emit('close');
      });
    });

    this.#ready = true;
    try {
      await this.send('auth', { apikey: apiKey });
    } catch (err) {
      this.close(); // don't leave an unauthenticated socket behind
      throw err;
    }
  }

  close() {
    this.#socket?.destroy();
  }

  /** Sends a command and resolves with the parsed rows of its response. */
  send(name, params = {}, flags = [], props = []) {
    if (!this.#socket || this.#socket.destroyed) {
      return Promise.reject(new Error('ClientQuery is not connected'));
    }
    const line = buildCommand(name, params, flags, props);
    return new Promise((resolve, reject) => {
      this.#queue.push({ line, resolve, reject, rows: [] });
      this.#flush();
    });
  }

  #flush() {
    if (this.#current || this.#queue.length === 0) return;
    const cmd = this.#queue.shift();
    this.#current = cmd;
    cmd.timer = setTimeout(() => {
      // Protocol state is unknown after a timeout; drop the connection so it gets rebuilt.
      cmd.reject(new Error(`ClientQuery command timed out: ${cmd.line.split(' ')[0]}`));
      this.#current = null;
      this.#socket?.destroy();
    }, COMMAND_TIMEOUT_MS);
    this.log.debug('>>', cmd.line.startsWith('auth') ? 'auth apikey=***' : cmd.line);
    this.#socket.write(`${cmd.line}\n`);
  }

  #onData(chunk) {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n\r?/);
    this.#buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (line) this.#onLine(line);
    }
  }

  #onLine(line) {
    this.log.debug('<<', line.length > 300 ? `${line.slice(0, 300)}…` : line);

    if (line.startsWith('notify')) {
      const space = line.indexOf(' ');
      const name = space === -1 ? line : line.slice(0, space);
      const params = space === -1 ? {} : parseParams(line.slice(space + 1));
      this.emit('notify', name, params);
      return;
    }
    if (line.startsWith('selected ')) return; // "selected schandlerid=1" after connect/handler switch

    if (line.startsWith('error ')) {
      const cmd = this.#current;
      if (!cmd) return;
      clearTimeout(cmd.timer);
      this.#current = null;
      const { id, msg } = parseParams(line.slice(6));
      if (id === '0') cmd.resolve(cmd.rows);
      else cmd.reject(new QueryError(id, msg, cmd.line));
      this.#flush();
      return;
    }

    if (this.#current) {
      this.#current.rows.push(...parseRows(line));
    } else if (/auth/i.test(line)) {
      this.#greetingDone?.(); // last greeting line
    }
  }

  #teardown(err) {
    this.#ready = false;
    if (this.#current) {
      clearTimeout(this.#current.timer);
      this.#current.reject(err);
      this.#current = null;
    }
    for (const cmd of this.#queue.splice(0)) cmd.reject(err);
  }
}
