import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_PATH = process.env.LOCAL_AGENT_CONFIG || path.join(ROOT, 'config.local.json');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function replaceFile(source, target) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 49) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { replaceFile(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
export const secret = () => randomBytes(32).toString('hex');

export function loadConfig() {
  const config = readJson(CONFIG_PATH);
  config.runtime = path.resolve(ROOT, config.runtime || 'runtime');
  config.defaultShell ||= 'powershell';
  config.maxActiveSessions ||= 8;
  config.maxOutputBytes ||= 32 * 1024 * 1024;
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid port');
  if (!Array.isArray(config.allowedRoots) || !config.allowedRoots.length) throw new Error('allowedRoots must be configured');
  if (!config.defaultCwd || !fs.statSync(config.defaultCwd).isDirectory()) throw new Error('Invalid defaultCwd');
  fs.mkdirSync(config.runtime, { recursive: true });
  return config;
}

export function childEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (/^(CLOUDFLARE|CF_API|LOCAL_AGENT_TEST)/i.test(key)) delete env[key];
  return env;
}

export async function readBody(req, max = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}

export function sessionDir(config, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
  return path.join(config.runtime, 'sessions', id);
}

export function publicState(state) {
  const { token, port, ...rest } = state;
  return rest;
}

export function readOutput(dir, state, offset = 0, maxBytes = 65536) {
  const base = state.baseOffset || 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > state.outputBytes) throw new Error('Invalid output offset');
  const from = Math.max(offset, base);
  const chunks = [];
  let remaining = Math.min(Math.max(maxBytes, 1), 262144);
  let next = from;
  const logs = fs.readdirSync(dir).filter(name => /^\d+\.log$/.test(name)).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
  for (const name of logs) {
    const start = Number(name.split('.')[0]);
    const file = path.join(dir, name);
    let data;
    try { data = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (start + data.length <= next || start > next || remaining <= 0) continue;
    const part = data.subarray(next - start, next - start + remaining);
    chunks.push(part);
    next += part.length;
    remaining -= part.length;
  }
  let data = Buffer.concat(chunks);
  if (next < state.outputBytes && data.length) {
    let start = data.length - 1;
    while (start > 0 && (data[start] & 0xc0) === 0x80) start--;
    const lead = data[start];
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (data.length - start < width) { next -= data.length - start; data = data.subarray(0, start); }
  }
  return { ...publicState(state), output: data.toString('utf8'), offset: from, nextOffset: next, hasMore: next < state.outputBytes, outputEvicted: offset < base };
}
