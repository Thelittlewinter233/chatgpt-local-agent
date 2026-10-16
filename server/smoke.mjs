import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.local.json'), 'utf8'));
const url = `ws://127.0.0.1:${config.port}`;
let msgId = 0;
const waiters = new Map();
const timeout = setTimeout(() => { console.error('SMOKE FAIL: timeout'); process.exit(1); }, 60000);

const ws = new WebSocket(url, { origin: 'chrome-extension://smoke-test' });
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: config.token, v: 1 })));
ws.on('message', raw => {
  const m = JSON.parse(raw.toString('utf8'));
  if (m.type === 'hello_ok') run();
  if (m.type === 'confirm-required') {
    console.log('ok - confirm requested:', m.preview);
    ws.send(JSON.stringify({ type: 'confirm-resolve', confirmId: m.confirmId, approved: true }));
  }
  if (m.type === 'result') {
    const w = waiters.get(m.msgId);
    if (w) { waiters.delete(m.msgId); w(m.payload); }
  }
});
ws.on('error', e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

function cmd(action, args) {
  return new Promise(resolve => {
    const id = ++msgId;
    waiters.set(id, resolve);
    ws.send(JSON.stringify({ type: 'cmd', msgId: id, hash8: 't' + id, action, args }));
  });
}

const assert = (cond, name) => {
  if (!cond) { console.error('SMOKE FAIL:', name); process.exit(1); }
  console.log('ok -', name);
};

async function run() {
  const info = await cmd('computer_info', {});
  assert(info.ok && info.data.platform === 'win32', 'computer_info roundtrip');
  const target = path.join(config.allowedRoots[0], 'tmp', 'smoke.txt');
  const wf = await cmd('fs_write', { path: target, content: '你好 smoke\n' });
  assert(wf.ok && wf.data.bytes > 0, 'fs_write with CJK content');
  const rd = await cmd('fs_read', { path: target });
  assert(rd.ok && rd.data.content.includes('你好'), 'fs_read roundtrip');
  const sh = await cmd('shell', { command: 'node -v', waitMs: 15000 });
  assert(sh.ok && sh.data.exitCode === 0 && /v\d+/.test(sh.data.output), 'shell node -v with real exit code');
  const black = await cmd('shell', { command: 'node -e "1" ; del x' });
  assert(!black.ok && black.denied, 'blacklist denial');
  const outside = await cmd('fs_read', { path: 'c:\\Windows\\win.ini' });
  assert(!outside.ok && outside.denied, 'path outside roots denial');
  const confirmed = await cmd('shell', { command: 'Get-Date -Format o', waitMs: 10000 });
  assert(confirmed.ok && confirmed.data.exitCode === 0, 'confirm flow approves non-whitelisted command');
  console.log('SMOKE PASS');
  clearTimeout(timeout);
  ws.close();
  const evil = new WebSocket(url, { origin: 'https://evil.com' });
  evil.on('open', () => { console.error('SMOKE FAIL: evil origin accepted'); process.exit(1); });
  evil.on('error', () => { });
  evil.on('close', () => { console.log('ok - non-extension origin rejected'); process.exit(0); });
  setTimeout(() => { console.error('SMOKE FAIL: evil origin test timeout'); process.exit(1); }, 8000).unref();
}
