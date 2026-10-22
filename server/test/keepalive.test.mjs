import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { startWsServer } from '../src/ws-server.mjs';

const config = { port: 0, token: 'ka-test-token' };
const dispatch = async action => {
  if (action === 'computer_info') return { platform: 'test' };
  throw new Error('unknown action');
};
const server = startWsServer(config, dispatch, () => { });
await new Promise(r => server.once('listening', r));
test.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }));
const url = `ws://127.0.0.1:${server.address().port}`;
const kaCred = createHash('sha256').update(config.token).digest('hex').slice(0, 16);

function connect(targetUrl, origin) {
  return new Promise(resolve => {
    const ws = new WebSocket(targetUrl, origin ? { origin } : undefined);
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      resolve({ ws, outcome });
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: config.token, v: 1, sessionId: 'ka-test-1' }));
    });
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString('utf8'));
      if (m.type === 'hello_ok') finish('hello_ok');
    });
    ws.on('error', () => finish('error'));
    ws.on('close', () => finish('closed'));
    setTimeout(() => finish('timeout'), 4000);
  });
}

test('page-origin connection without ka credential is rejected', async () => {
  const r = await connect(url, 'https://chat.deepseek.com');
  assert.ok(r.outcome === 'error' || r.outcome === 'closed', 'expected rejection, got ' + r.outcome);
  try { r.ws.close(); } catch { }
});

test('page-origin connection with valid ka credential authenticates and pings', async () => {
  const r = await connect(`${url}/?ka=${kaCred}`, 'https://chat.deepseek.com');
  assert.equal(r.outcome, 'hello_ok');
  const pong = await new Promise(resolve => {
    const t = setTimeout(() => resolve('timeout'), 3000);
    r.ws.on('message', raw => {
      const m = JSON.parse(raw.toString('utf8'));
      if (m.type === 'pong') { clearTimeout(t); resolve('pong'); }
    });
    r.ws.send(JSON.stringify({ type: 'ping' }));
  });
  assert.equal(pong, 'pong');
  r.ws.close();
});

test('page-origin connection with wrong ka credential is rejected', async () => {
  const r = await connect(`${url}/?ka=${'0'.repeat(16)}`, 'https://chat.deepseek.com');
  assert.ok(r.outcome === 'error' || r.outcome === 'closed', 'expected rejection, got ' + r.outcome);
  try { r.ws.close(); } catch { }
});

test('extension origin still connects without ka credential', async () => {
  const r = await connect(url, 'chrome-extension://ka-test');
  assert.equal(r.outcome, 'hello_ok');
  r.ws.close();
});

test('ka auth failures are attributed per credential and origin', async () => {
  for (let i = 0; i < 4; i += 1) {
    const r = await connect(`${url}/?ka=${'f'.repeat(16)}`, 'https://evil.example');
    assert.ok(r.outcome === 'error' || r.outcome === 'closed', 'expected rejection, got ' + r.outcome);
    try { r.ws.close(); } catch { }
  }
  const ext = await connect(url, 'chrome-extension://ka-test-attribution');
  assert.equal(ext.outcome, 'hello_ok');
  ext.ws.close();
  const other = await connect(`${url}/?ka=${kaCred}`, 'https://chat.deepseek.com');
  assert.equal(other.outcome, 'hello_ok');
  other.ws.close();
});
