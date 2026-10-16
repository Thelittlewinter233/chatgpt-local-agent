import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ses-'));
const configPath = path.join(root, 'config.local.json');
fs.writeFileSync(configPath, JSON.stringify({
  port: 9799,
  allowedRoots: [root],
  defaultCwd: root,
  defaultShell: 'powershell',
  shells: { powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
  runtime: path.join(root, 'runtime'),
  maxActiveSessions: 4,
  maxOutputBytes: 1048576
}));
process.env.LOCAL_AGENT_CONFIG = configPath;

const { Sessions } = await import('../src/engine/sessions.mjs');

test('job session runs a powershell command and returns output with exit code', async () => {
  const sessions = new Sessions(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const started = await sessions.start({ kind: 'job', command: 'Write-Output "中文OK"; Write-Output "session-ok"; exit 0' });
  assert.equal(started.status, 'running');
  const id = started.id;
  let state;
  for (let i = 0; i < 100; i++) {
    state = await sessions.request(id, 'read', { offset: 0, maxBytes: 65536, waitMs: 200 });
    if (state.status !== 'running') break;
  }
  assert.equal(state.status, 'completed');
  assert.equal(state.exitCode, 0);
  assert.ok(state.output.includes('中文OK'));
  assert.ok(state.output.includes('session-ok'));
});

test('requestId reuse returns the same session without double spawn', async () => {
  const sessions = new Sessions(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const first = await sessions.start({ kind: 'job', command: 'Write-Output "once"', requestId: 'task-1' });
  const again = await sessions.start({ kind: 'job', command: 'Write-Output "once"', requestId: 'task-1' });
  assert.equal(first.id, again.id);
});

test('unknown session id is rejected', async () => {
  const sessions = new Sessions(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  await assert.rejects(() => sessions.request('not-a-uuid', 'read'));
});

test('terminal kind is rejected in this build', async () => {
  const sessions = new Sessions(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  await assert.rejects(() => sessions.start({ kind: 'terminal' }), /node-pty/);
});
