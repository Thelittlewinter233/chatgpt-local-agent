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
  let confirms = 0;
  const origOnMessage = ws.listeners('message');
  ws.off('message', origOnMessage[0]);
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString('utf8'));
    if (m.type === 'hello_ok') return;
    if (m.type === 'confirm-required') {
      confirms += 1;
      console.log('ok - confirm requested:', m.preview);
      ws.send(JSON.stringify({ type: 'confirm-resolve', confirmId: m.confirmId, approved: true }));
      return;
    }
    if (m.type === 'policy-updated' || m.type === 'policy') {
      const w = waiters.get(-1);
      if (w) { waiters.delete(-1); w(m.policy); }
      return;
    }
    if (m.type === 'result') {
      const w = waiters.get(m.msgId);
      if (w) { waiters.delete(m.msgId); w(m.payload); }
    }
  });
  function frame(type, extra) { ws.send(JSON.stringify({ type, ...extra })); }
  function setPolicyMode(enabled) {
    return new Promise(resolve => { waiters.set(-1, resolve); frame('set-policy', { patch: { allowOutOfRoots: enabled } }); });
  }
  function getPolicy() {
    return new Promise(resolve => { waiters.set(-1, resolve); frame('get-policy', {}); });
  }
  const origPolicy = await getPolicy();
  const origAllow = !!origPolicy.allowOutOfRoots;
  if (origAllow) await setPolicyMode(false);
  const info = await cmd('computer_info', {});
  assert(info.ok && info.data.platform === 'win32', 'computer_info roundtrip');
  const target = path.join(config.allowedRoots[0], 'tmp', 'smoke.txt');
  const wf = await cmd('fs_write', { path: target, content: '你好 smoke\n' });
  assert(wf.ok && wf.data.bytes > 0, 'fs_write with CJK content');
  const rd = await cmd('fs_read', { path: target });
  assert(rd.ok && rd.data.content.includes('你好'), 'fs_read roundtrip');
  const multiT = path.join(config.allowedRoots[0], 'tmp', 'smoke-multi.txt');
  await cmd('fs_write', { path: multiT, content: 'smoke one\nsmoke two\nsmoke three\n' });
  const em = await cmd('fs_edit_multi', { path: multiT, edits: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'three', newText: 'THREE' }] });
  assert(em.ok && em.data.replacements === 2, 'fs_edit_multi applies batch edits atomically');
  const gl = await cmd('fs_glob', { path: config.allowedRoots[0], pattern: 'tmp/smoke*.txt' });
  assert(gl.ok && gl.data.matches.some(p => p.endsWith('smoke-multi.txt')), 'fs_glob matches glob pattern');
  const gr = await cmd('fs_grep', { path: path.join(config.allowedRoots[0], 'tmp'), pattern: 'smoke', glob: '*.txt' });
  assert(gr.ok && gr.data.matches.length >= 2 && gr.data.matches[0].line >= 1, 'fs_grep finds content with line numbers');
  const sh = await cmd('shell', { command: 'node -v', waitMs: 15000 });
  assert(sh.ok && sh.data.exitCode === 0 && /v\d+/.test(sh.data.output), 'shell node -v with real exit code');
  const black = await cmd('shell', { command: 'node -e "1" ; del x' });
  assert(!black.ok && black.denied, 'blacklist denial');
  const outside = await cmd('fs_read', { path: 'c:\\Windows\\win.ini' });
  assert(!outside.ok && outside.denied, 'path outside roots denial');
  const confirmed = await cmd('shell', { command: 'Get-Date -Format o', waitMs: 10000 });
  assert(confirmed.ok && confirmed.data.exitCode === 0, 'confirm flow approves non-whitelisted command');
  const outsideWrite = path.join(path.dirname(config.allowedRoots[0]), 'smoke-outer-confirm.txt');
  confirms = 0;
  const w1 = await cmd('fs_write', { path: outsideWrite, content: 'a' });
  assert(w1.ok && confirms === 1, 'out-of-roots write goes through confirm bar');
  const p1 = await setPolicyMode(true);
  assert(p1 && p1.allowOutOfRoots === true, 'policy hot-switch to allow mode');
  confirms = 0;
  const w2 = await cmd('fs_write', { path: outsideWrite, content: 'b' });
  assert(w2.ok && confirms === 0, 'out-of-roots write is direct in allow mode (no confirm)');
  const rOut = await cmd('fs_read', { path: outsideWrite });
  assert(rOut.ok && rOut.data.content === 'b', 'out-of-roots read is direct in allow mode (no confirm)');
  const d2 = await cmd('fs_delete', { path: outsideWrite });
  assert(d2.ok && d2.data.deleted && confirms === 0, 'fs_delete is confirm-free in allow mode');
  const p2 = await setPolicyMode(false);
  assert(p2 && p2.allowOutOfRoots === false, 'policy hot-switch back to confirm mode');
  const w3 = await cmd('fs_write', { path: outsideWrite, content: 'c' });
  assert(w3.ok && confirms === 1, 'out-of-roots write requires confirm again after switching back');
  const delOut = await cmd('fs_delete', { path: outsideWrite });
  assert(delOut.ok && delOut.data.deleted && confirms === 2, 'fs_delete requires confirm again after switching back');
  const term = await cmd('terminal_start', { shell: 'powershell' });
  assert(term.ok && term.data.sessionId, 'terminal_start returns sessionId');
  const tid = term.data.sessionId;
  await new Promise(r => setTimeout(r, 2000));
  const wr = await cmd('session_write', { sessionId: tid, input: 'Write-Output smoke-term-ok', newline: true });
  assert(wr.ok, 'session_write accepted');
  let tout = '';
  let toffset = 0;
  const tdeadline = Date.now() + 15000;
  while (Date.now() < tdeadline) {
    const r = await cmd('session_read', { sessionId: tid, offset: toffset, maxBytes: 262144, waitMs: 500 });
    tout += (r.data && r.data.output) || '';
    toffset = (r.data && r.data.nextOffset) || toffset;
    if (tout.includes('smoke-term-ok')) break;
  }
  assert(tout.includes('smoke-term-ok'), 'interactive terminal output roundtrip');
  const deniedWrite = await cmd('session_write', { sessionId: tid, input: 'Remove-Item x' });
  assert(!deniedWrite.ok && deniedWrite.denied, 'terminal input blacklist denial');
  const cl = await cmd('session_close', { sessionId: tid });
  assert(cl.ok, 'terminal close');
  if (origAllow) await setPolicyMode(true);
  console.log('SMOKE PASS');
  clearTimeout(timeout);
  ws.close();
  const evil = new WebSocket(url, { origin: 'https://evil.com' });
  evil.on('open', () => { console.error('SMOKE FAIL: evil origin accepted'); process.exit(1); });
  evil.on('error', () => { });
  evil.on('close', () => { console.log('ok - non-extension origin rejected'); process.exit(0); });
  setTimeout(() => { console.error('SMOKE FAIL: evil origin test timeout'); process.exit(1); }, 8000).unref();
}
