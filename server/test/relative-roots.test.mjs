import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startWsServer } from '../src/ws-server.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relative-'));
const configDir = path.join(home, 'config');
const root = path.join(home, 'root');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'sample.txt'), 'relative-ok');
const configPath = path.join(configDir, 'config.local.json');
fs.writeFileSync(configPath, JSON.stringify({
  port: 9788,
  token: 'relative-roots-token',
  allowedRoots: ['..'],
  defaultCwd: '..',
  runtime: path.join(configDir, 'runtime')
}));
process.env.LOCAL_AGENT_CONFIG = configPath;

const { loadConfig } = await import('../src/engine/common.mjs');
const { createFsTools } = await import('../src/fs-tools.mjs');
const config = loadConfig();
const fsTools = createFsTools(config);
const expectedRoot = path.resolve(configDir, '..');
const dispatch = async (action, args, ctx) => {
  if (action === 'fs_read') return fsTools.read(args, ctx);
  if (action === 'default_cwd') return { path: config.defaultCwd };
  throw new Error('unknown action');
};
const server = startWsServer({ ...config, port: 0 }, dispatch, () => { });
await new Promise(r => server.once('listening', r));
test.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }));
const url = `ws://127.0.0.1:${server.address().port}`;

function makeClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: 'chrome-extension://relative-roots-test' });
    const waiters = new Map();
    let msgId = 0;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: config.token, v: 1, sessionId: 'relative-roots' })));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString('utf8'));
      if (m.type === 'hello_ok') {
        resolve({
          ws,
          send: (action, args) => {
            const id = ++msgId;
            return new Promise(res => {
              waiters.set(id, res);
              ws.send(JSON.stringify({ type: 'cmd', msgId: id, hash8: 't' + id, action, args }));
            });
          }
        });
        return;
      }
      if (m.type === 'result') {
        const w = waiters.get(m.msgId);
        if (w) {
          waiters.delete(m.msgId);
          w(m.payload);
        }
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

test('loadConfig resolves relative roots and cwd against the config directory', async () => {
  assert.deepEqual(config.allowedRoots, [expectedRoot]);
  assert.equal(config.defaultCwd, expectedRoot);
  assert.ok(fs.statSync(config.defaultCwd).isDirectory());
});

test('relative allowedRoots pass through server path checks', async () => {
  const client = await makeClient();
  try {
    const inside = await client.send('fs_read', { path: path.join(root, 'sample.txt') });
    assert.ok(inside.ok);
    assert.equal(inside.data.path, path.join(root, 'sample.txt'));
    assert.equal(inside.data.content, 'relative-ok');
    const outside = await client.send('fs_read', { path: path.join(expectedRoot, '..', 'relative-outside.txt') });
    assert.equal(outside.ok, false);
    assert.match(outside.denied, /Path outside allowedRoots/);
    const cwd = await client.send('default_cwd', {});
    assert.ok(cwd.ok);
    assert.equal(cwd.data.path, expectedRoot);
  } finally {
    client.ws.close();
  }
});
