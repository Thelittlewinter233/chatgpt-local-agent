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

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function atomicWrite(config, file, before, buffer, bypassRoots) {
  const target = checkPath(config, file, bypassRoots);
  const realTarget = fs.realpathSync(target);
  if (!bypassRoots && realTarget.toLowerCase() !== target.toLowerCase()) {
    checkPath(config, realTarget, false);
  }
  const temp = `${realTarget}.agent-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, buffer, { mode: fs.statSync(realTarget).mode });
    if (hash(fs.readFileSync(realTarget)) !== hash(before)) throw new Error('File changed during edit; retry after reading');
    replaceFile(temp, realTarget);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
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
    const bypass = !!(ctx && ctx.bypassRoots);
    const file = checkPath(config, args.path, bypass);
    if (typeof args.oldText !== 'string' || !args.oldText) throw new Error('oldText must be a non-empty string');
    if (typeof args.newText !== 'string') throw new Error('newText must be a string');
    const before = fs.readFileSync(file);
    if (args.expectedSha256 && hash(before) !== args.expectedSha256) throw new Error('Stale content: SHA-256 mismatch');
    const text = before.toString('utf8');
    const expected = args.expectedCount ?? 1;
    const count = text.split(args.oldText).length - 1;
    if (count !== expected) throw new Error(`Expected ${expected} occurrences, found ${count}; file unchanged`);
    const after = Buffer.from(text.split(args.oldText).join(args.newText), 'utf8');
    atomicWrite(config, file, before, after, bypass);
    return { path: fs.realpathSync(file), replacements: count, sha256: hash(after) };
  }

  async function editMulti(args, ctx) {
    const bypass = !!(ctx && ctx.bypassRoots);
    const file = checkPath(config, args.path, bypass);
    if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('edits must be a non-empty array');
    if (args.edits.length > 20) throw new Error('too many edits in one call (max 20)');
    const before = fs.readFileSync(file);
    if (args.expectedSha256 && hash(before) !== args.expectedSha256) throw new Error('Stale content: SHA-256 mismatch');
    let text = before.toString('utf8');
    let replacements = 0;
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i] || {};
      if (typeof e.oldText !== 'string' || !e.oldText) throw new Error(`edits[${i}].oldText must be a non-empty string`);
      if (typeof e.newText !== 'string') throw new Error(`edits[${i}].newText must be a string`);
      const expected = e.expectedCount ?? 1;
      const count = text.split(e.oldText).length - 1;
      if (count !== expected) throw new Error(`edits[${i}]: expected ${expected} occurrences, found ${count}; file unchanged`);
      text = text.split(e.oldText).join(e.newText);
      replacements += count;
    }
    const after = Buffer.from(text, 'utf8');
    atomicWrite(config, file, before, after, bypass);
    return { path: fs.realpathSync(file), edits: args.edits.length, replacements, sha256: hash(after) };
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

  async function glob(args, ctx) {
    const root = checkPath(config, args.path, ctx && ctx.bypassRoots);
    if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required');
    const re = globToRegex(args.pattern);
    const matches = [];
    const walk = dir => {
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= MAX_SEARCH_RESULTS) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full);
        } else if (re.test(path.relative(root, full).replace(/\\/g, '/'))) matches.push(full);
      }
    };
    walk(root);
    return { path: root, pattern: args.pattern, matches, truncated: matches.length >= MAX_SEARCH_RESULTS };
  }

  async function grep(args, ctx) {
    const root = checkPath(config, args.path, ctx && ctx.bypassRoots);
    if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required');
    let re;
    try { re = new RegExp(args.pattern, args.ignoreCase ? 'i' : ''); }
    catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
    const nameRe = args.glob ? globToRegex(args.glob) : null;
    const max = Math.min(Math.max(Number(args.maxResults) || 100, 1), MAX_SEARCH_RESULTS);
    const matches = [];
    let truncated = false;
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= max) { truncated = true; return; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.isSymbolicLink() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full);
          continue;
        }
        if (!e.isFile()) continue;
        if (nameRe && !nameRe.test(e.name)) continue;
        let buf;
        try { buf = fs.readFileSync(full); } catch { continue; }
        if (buf.length > 2 * 1024 * 1024 || buf.subarray(0, 8192).includes(0)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ file: full, line: i + 1, text: lines[i].slice(0, 500) });
            if (matches.length >= max) { truncated = true; break; }
          }
        }
      }
    };
    walk(root);
    return { path: root, pattern: args.pattern, glob: args.glob || null, matches, truncated };
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

  return { read, write, edit, editMulti, list, tree, search, glob, grep, move, mkdir, info, del };
}
