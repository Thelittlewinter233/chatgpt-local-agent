import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkPathResolved as checkPath } from './policy.mjs';
import { replaceFile } from './engine/common.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const MAX_READ = 256 * 1024;
const MAX_TREE_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 200;

function assertText(buffer) {
  const probe = buffer.subarray(0, 8192);
  if (probe.includes(0)) throw new Error('File appears to be binary; only UTF-8 text files are supported');
}

function toRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function createFsTools(config) {
  async function read(args, ctx) {
    const file = checkPath(config, args.path, ctx && ctx.bypassRoots);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
    let data, offset;
    if (args.tailBytes) {
      const tail = Math.min(Math.max(Number(args.tailBytes), 1), MAX_READ);
      offset = Math.max(0, stat.size - tail);
      const fd = fs.openSync(file, 'r');
      try {
        data = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, data, 0, data.length, offset);
      } finally { fs.closeSync(fd); }
    } else {
      offset = Math.min(Math.max(Number(args.offsetBytes) || 0, 0), stat.size);
      const maxBytes = Math.min(Math.max(Number(args.maxBytes) || MAX_READ, 1024), MAX_READ);
      const fd = fs.openSync(file, 'r');
      try {
        data = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
        fs.readSync(fd, data, 0, data.length, offset);
      } finally { fs.closeSync(fd); }
    }
    assertText(data);
    const nextOffset = offset + data.length;
    const result = {
      path: file,
      size: stat.size,
      offset,
      nextOffset,
      hasMore: nextOffset < stat.size,
      truncated: nextOffset < stat.size,
      content: data.toString('utf8')
    };
    if (nextOffset >= stat.size) result.sha256 = hash(data);
    return result;
  }

  async function write(args, ctx) {
    const file = checkPath(config, args.path, ctx && ctx.bypassRoots);
    if (typeof args.content !== 'string') throw new Error('content must be a string');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buffer = Buffer.from(args.content, 'utf8');
    fs.writeFileSync(file, buffer);
    return { path: file, bytes: buffer.length, sha256: hash(buffer) };
  }

  async function edit(args, ctx) {
    const file = checkPath(config, args.path, ctx && ctx.bypassRoots);
    if (typeof args.oldText !== 'string' || !args.oldText) throw new Error('oldText must be a non-empty string');
    if (typeof args.newText !== 'string') throw new Error('newText must be a string');
    const before = fs.readFileSync(file);
    if (args.expectedSha256 && hash(before) !== args.expectedSha256) throw new Error('Stale content: SHA-256 mismatch');
    const text = before.toString('utf8');
    const expected = args.expectedCount ?? 1;
    const count = text.split(args.oldText).length - 1;
    if (count !== expected) throw new Error(`Expected ${expected} occurrences, found ${count}; file unchanged`);
    const after = Buffer.from(text.split(args.oldText).join(args.newText), 'utf8');
    const target = fs.realpathSync(file);
    const temp = `${target}.agent-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, after, { mode: fs.statSync(target).mode });
      if (hash(fs.readFileSync(target)) !== hash(before)) throw new Error('File changed during edit; retry after reading');
      replaceFile(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return { path: target, replacements: count, sha256: hash(after) };
  }

  async function list(args, ctx) {
    const dir = checkPath(config, args.path, ctx && ctx.bypassRoots);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' }));
    return { path: dir, entries };
  }

  async function tree(args, ctx) {
    const root = checkPath(config, args.path, ctx && ctx.bypassRoots);
    const maxDepth = Math.min(Math.max(Number(args.depth) || 2, 1), 4);
    const entries = [];
    const walk = (dir, depth) => {
      if (depth > maxDepth || entries.length >= MAX_TREE_ENTRIES) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entries.length >= MAX_TREE_ENTRIES) return;
        const full = path.join(dir, e.name);
        entries.push({ path: full, type: e.isDirectory() ? 'dir' : 'file' });
        if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
      }
    };
    walk(root, 1);
    return { path: root, entries };
  }

  async function search(args, ctx) {
    const root = checkPath(config, args.path, ctx && ctx.bypassRoots);
    if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required');
    const re = toRegex(args.pattern);
    const matches = [];
    const walk = dir => {
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= MAX_SEARCH_RESULTS) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full);
        } else if (re.test(e.name)) matches.push(full);
      }
    };
    walk(root);
    return { path: root, pattern: args.pattern, matches };
  }

  async function move(args, ctx) {
    const from = checkPath(config, args.from, ctx && ctx.bypassRoots);
    const to = checkPath(config, args.to, ctx && ctx.bypassRoots);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) throw new Error(`Target already exists: ${to}`);
    const temp = `${to}.agent-move-${process.pid}.tmp`;
    fs.renameSync(from, temp);
    try { replaceFile(temp, to); }
    catch (e) { try { fs.renameSync(temp, from); } catch { } ; throw e; }
    return { from, to };
  }

  async function mkdir(args, ctx) {
    const dir = checkPath(config, args.path, ctx && ctx.bypassRoots);
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir };
  }

  async function info(args, ctx) {
    const file = checkPath(config, args.path, ctx && ctx.bypassRoots);
    const stat = fs.statSync(file);
    return {
      path: file, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(),
      createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString()
    };
  }

  async function del(args, ctx) {
    const file = checkPath(config, args.path, ctx && ctx.bypassRoots);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`Refusing to delete non-file target: ${file}`);
    fs.unlinkSync(file);
    return { path: file, deleted: true };
  }

  return { read, write, edit, list, tree, search, move, mkdir, info, del };
}
