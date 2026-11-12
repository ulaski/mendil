import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientQuery } from '../src/ts3/clientquery.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

/** Minimal fake of the TS3 ClientQuery plugin. */
async function fakeClientQuery() {
  const state = { closed: 0, sockets: [] };
  const server = net.createServer((socket) => {
    state.sockets.push(socket);
    socket.on('close', () => state.closed++);
    socket.write('TS3 Client\n\rWelcome to the TeamSpeak 3 ClientQuery interface.\n\r');
    socket.write('Use the "auth" command to authenticate yourself.\n\r');
    socket.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        if (line === 'auth apikey=good') socket.write('error id=0 msg=ok\n\r');
        else if (line.startsWith('auth')) socket.write('error id=520 msg=invalid\\sapikey\n\r');
        else if (line === 'whoami') socket.write('clid=7 cid=3\n\rerror id=0 msg=ok\n\r');
        else socket.write('error id=256 msg=command\\snot\\sfound\n\r');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, state, port: server.address().port };
}

test('ClientQuery authenticates, parses responses and emits notifications', async (t) => {
  const { server, state, port } = await fakeClientQuery();
  t.after(() => server.close());
  const cq = new ClientQuery({ port, log: quietLog });
  await cq.connect('good');
  assert.equal(cq.connected, true);
  assert.deepEqual(await cq.send('whoami'), [{ clid: '7', cid: '3' }]);

  const notified = once(cq, 'notify');
  state.sockets[0].write('notifytextmessage schandlerid=1 targetmode=2 msg=!play\\sdaft\\spunk invokerid=5\n\r');
  const [name, params] = await notified;
  assert.equal(name, 'notifytextmessage');
  assert.equal(params.msg, '!play daft punk');
  cq.close();
});

test('ClientQuery closes the socket when auth fails', async (t) => {
  const { server, state, port } = await fakeClientQuery();
  t.after(() => server.close());
  const cq = new ClientQuery({ port, log: quietLog });
  await assert.rejects(cq.connect('wrong'), /invalid apikey/);
  for (let i = 0; i < 50 && state.closed === 0; i++) await sleep(20);
  assert.equal(state.closed, 1, 'server should see the connection closed');
  assert.equal(cq.connected, false);
});
