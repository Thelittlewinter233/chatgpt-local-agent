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

test('delete removes a file and refuses directories', async () => {
  const f = path.join(root, 'to-delete.txt');
  fs.writeFileSync(f, 'bye');
  const d = await tools.del({ path: f });
  assert.equal(d.deleted, true);
  assert.ok(!fs.existsSync(f));
  const dir = path.join(root, 'sub');
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(() => tools.del({ path: dir }), /non-file/);
  await assert.rejects(() => tools.del({ path: path.join(root, 'missing.txt') }), /ENOENT/);
});

test('edit fails on stale sha256', async () => {
  await assert.rejects(() => tools.edit({ path: path.join(root, 'a.txt'), oldText: 'hello', newText: 'no', expectedSha256: '0'.repeat(64) }), /Stale/);
});

test('editMulti applies multiple edits in order', async () => {
  const f = path.join(root, 'multi.txt');
  fs.writeFileSync(f, 'alpha\nbeta\ngamma\n');
  const r = await tools.editMulti({
    path: f,
    edits: [
      { oldText: 'alpha', newText: 'ALPHA' },
      { oldText: 'beta', newText: 'BETA', expectedCount: 1 },
      { oldText: 'gamma', newText: 'GAMMA' }
    ]
  });
  assert.equal(r.edits, 3);
  assert.equal(r.replacements, 3);
  assert.equal(fs.readFileSync(f, 'utf8'), 'ALPHA\nBETA\nGAMMA\n');
});

test('editMulti is atomic: failing later edit leaves file unchanged', async () => {
  const f = path.join(root, 'multi-atomic.txt');
  const before = 'keep\nsave\n';
  fs.writeFileSync(f, before);
  await assert.rejects(() => tools.editMulti({
    path: f,
    edits: [
      { oldText: 'keep', newText: 'changed', expectedCount: 1 },
      { oldText: 'missing', newText: 'x' }
    ]
  }), /edits\[1\]: expected 1 occurrences, found 0/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('glob matches recursive patterns and skips node_modules and hidden dirs', async () => {
  await tools.mkdir({ path: path.join(root, 'g1', 'g2') });
  await tools.write({ path: path.join(root, 'g1', 'g2', 'x.py'), content: 'x' });
  await tools.write({ path: path.join(root, 'g1', 'y.py'), content: 'y' });
  fs.mkdirSync(path.join(root, 'g1', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'g1', 'node_modules', 'z.py'), 'z');
  fs.mkdirSync(path.join(root, 'g1', '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(root, 'g1', '.hidden', 'h.py'), 'h');
  const g = await tools.glob({ path: root, pattern: '**/*.py' });
  const rels = g.matches.map(p => path.relative(root, p).replace(/\\/g, '/')).sort();
  assert.deepEqual(rels, ['g1/g2/x.py', 'g1/y.py']);
  const single = await tools.glob({ path: root, pattern: '*.txt' });
  const singleRels = single.matches.map(p => path.relative(root, p).replace(/\\/g, '/'));
  assert.ok(singleRels.length > 0 && singleRels.every(p => !p.includes('/')));
});

test('grep finds content with line numbers and honors glob and maxResults', async () => {
  await tools.write({ path: path.join(root, 'src.txt'), content: 'foo bar\nBAZ qux\nnothing here\n' });
  await tools.write({ path: path.join(root, 'other.md'), content: 'foo in md\n' });
  const g1 = await tools.grep({ path: root, pattern: 'foo', glob: '*.txt' });
  assert.equal(g1.matches.length, 1);
  assert.equal(g1.matches[0].file, path.join(root, 'src.txt'));
  assert.equal(g1.matches[0].line, 1);
  const g2 = await tools.grep({ path: root, pattern: 'baz', ignoreCase: true, glob: '*.txt' });
  assert.equal(g2.matches[0].line, 2);
  const g3 = await tools.grep({ path: root, pattern: 'baz', glob: '*.txt' });
  assert.equal(g3.matches.length, 0);
  const g4 = await tools.grep({ path: root, pattern: 'e', glob: '*.txt', maxResults: 2 });
  assert.ok(g4.matches.length <= 2);
  await assert.rejects(() => tools.grep({ path: root, pattern: '([bad' }), /Invalid regex/);
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
