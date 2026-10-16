import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsTools } from '../src/fs-tools.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fs-'));
const config = { allowedRoots: [root], defaultCwd: root };
const tools = createFsTools(config);

test('write and read roundtrip', async () => {
  const w = await tools.write({ path: path.join(root, 'a.txt'), content: 'hello\nworld\n' });
  assert.equal(w.bytes, 12);
  const r = await tools.read({ path: path.join(root, 'a.txt') });
  assert.equal(r.content, 'hello\nworld\n');
  assert.equal(r.sha256, w.sha256);
});

test('out-of-roots write is denied without ctx and allowed with bypassRoots', async () => {
  const outside = path.join(path.dirname(root), 'agent-bypass-probe.txt');
  await assert.rejects(() => tools.write({ path: outside, content: 'x' }), /Path outside allowedRoots/);
  const w = await tools.write({ path: outside, content: 'x' }, { bypassRoots: true });
  assert.equal(w.bytes, 1);
  assert.ok(fs.existsSync(outside));
  fs.unlinkSync(outside);
});

test('out-of-roots read is denied without ctx (dispatch never grants bypass for reads)', async () => {
  const outside = path.join(path.dirname(root), 'agent-bypass-probe-2.txt');
  fs.writeFileSync(outside, 'secret');
  await assert.rejects(() => tools.read({ path: outside }), /Path outside allowedRoots/);
  fs.unlinkSync(outside);
});

test('read tailBytes', async () => {
  const r = await tools.read({ path: path.join(root, 'a.txt'), tailBytes: 6 });
  assert.equal(r.content, 'world\n');
});

test('edit replaces exactly and reports hash', async () => {
  const before = await tools.read({ path: path.join(root, 'a.txt') });
  const e = await tools.edit({ path: path.join(root, 'a.txt'), oldText: 'world', newText: 'there', expectedSha256: before.sha256 });
  assert.equal(e.replacements, 1);
  const after = await tools.read({ path: path.join(root, 'a.txt') });
  assert.equal(after.content, 'hello\nthere\n');
  assert.notEqual(after.sha256, before.sha256);
});

test('edit fails on wrong occurrence count and leaves file unchanged', async () => {
  const before = await tools.read({ path: path.join(root, 'a.txt') });
  await assert.rejects(() => tools.edit({ path: path.join(root, 'a.txt'), oldText: 'l', newText: 'L', expectedCount: 5 }), /found 2/);
  const after = await tools.read({ path: path.join(root, 'a.txt') });
  assert.equal(after.sha256, before.sha256);
});

test('edit fails on stale sha256', async () => {
  await assert.rejects(() => tools.edit({ path: path.join(root, 'a.txt'), oldText: 'hello', newText: 'no', expectedSha256: '0'.repeat(64) }), /Stale/);
});

test('list, tree, search, mkdir, move, info', async () => {
  await tools.mkdir({ path: path.join(root, 'sub', 'deep') });
  await tools.write({ path: path.join(root, 'sub', 'deep', 'b.log'), content: 'x' });
  const list = await tools.list({ path: root });
  assert.ok(list.entries.some(e => e.name === 'a.txt'));
  const tree = await tools.tree({ path: root, depth: 3 });
  assert.ok(tree.entries.some(e => e.path.endsWith('b.log')));
  const found = await tools.search({ path: root, pattern: '*.log' });
  assert.equal(found.matches.length, 1);
  const moved = await tools.move({ from: path.join(root, 'sub', 'deep', 'b.log'), to: path.join(root, 'c.log') });
  assert.ok(moved.to.endsWith('c.log'));
  const info = await tools.info({ path: path.join(root, 'c.log') });
  assert.equal(info.isFile, true);
});

test('paths outside roots are denied', async () => {
  await assert.rejects(() => tools.read({ path: 'c:\\Windows\\win.ini' }), e => e.denied === true);
  await assert.rejects(() => tools.write({ path: path.join(root, '..', 'escape.txt'), content: 'x' }), e => e.denied === true);
});

test('binary files are rejected on read', async () => {
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  await assert.rejects(() => tools.read({ path: path.join(root, 'bin.dat') }), /binary/);
});
