import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startWsServer } from '../src/ws-server.mjs';

const config = { port: 0, token: 'test-token' };
const dispatch = async (action, args, ctx) => {
  if (action === 'computer_info') return { platform: 'test' };
  if (action === 'slow') { await new Promise(r => setTimeout(r, 500)); return { slept: 500 }; }
  if (action === 'need-confirm') { const ok = await ctx.requestConfirm('preview'); return { approved: ok }; }
  throw new Error('unknown action');
};
const server = startWsServer(config, dispatch, () => { });
await new Promise(r => server.once('listening', r));
test.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }));
const url = `ws://127.0.0.1:${server.address().port}`;

function makeClient(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: 'chrome-extension://test-multi' });
    const waiters = new Map();
    const confirms = [];
    let msgId = 0;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: config.token, v: 1, sessionId })));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString('utf8'));
      if (m.type === 'hello_ok') { resolve({ ws, confirms, send: (action, args) => { const id = ++msgId; return new Promise(res => { waiters.set(id, res); ws.send(JSON.stringify({ type: 'cmd', msgId: id, hash8: 't' + id, action, args })); }); }, close: () => ws.close(), sessionId: m.sessionId }); return; }
      if (m.type === 'confirm-required') { confirms.push(m.confirmId); ws.send(JSON.stringify({ type: 'confirm-resolve', confirmId: m.confirmId, approved: true })); return; }
      if (m.type === 'result') { const w = waiters.get(m.msgId); if (w) { waiters.delete(m.msgId); w(m.payload); } }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

test('two concurrent sessions get distinct sessionIds and isolated caches', async () => {
  const a = await makeClient('test-session-a');
  const b = await makeClient('test-session-b');
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.sessionId, 'test-session-a');
  assert.equal(b.sessionId, 'test-session-b');
  const ra = await a.send('computer_info', {});
  const rb = await b.send('computer_info', {});
  assert.ok(ra.ok && rb.ok);
  a.close();
  b.close();
});

test('commands on different sessions run concurrently without blocking', async () => {
  const a = await makeClient('test-concurrent-a');
  const b = await makeClient('test-concurrent-b');
  const start = Date.now();
  const [ra, rb] = await Promise.all([a.send('slow', {}), b.send('slow', {})]);
  const elapsed = Date.now() - start;
  assert.ok(ra.ok && rb.ok, 'both commands succeeded');
  assert.ok(elapsed < 900, `concurrent execution took ${elapsed}ms, expected < 900ms`);
  a.close();
  b.close();
});

test('confirm-required routes only to the initiating session', async () => {
  const a = await makeClient('test-confirm-a');
  const b = await makeClient('test-confirm-b');
  const ra = await a.send('need-confirm', {});
  assert.ok(ra.ok && ra.data.approved === true);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(a.confirms.length, 1);
  assert.equal(b.confirms.length, 0);
  a.close();
  b.close();
});
