import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ROOT, CONFIG_PATH, atomicJson, readJson, secret, sleep, sessionDir, publicState, readOutput, childEnv } from './common.mjs';

export class Sessions {
  constructor(config) { this.config = config; this.startQueue = Promise.resolve(); }

  async request(id, action = 'read', args = {}) {
    const dir = sessionDir(this.config, id);
    let state = readJson(path.join(dir, 'state.json'));
    if (state.status !== 'running') {
      if (action === 'read') return readOutput(dir, state, args.offset, args.maxBytes);
      if (action === 'close') return publicState(state);
      throw new Error(`Session is ${state.status}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout((args.waitMs || 0) + 5000)
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || `Worker HTTP ${response.status}`);
        error.workerResponse = true;
        throw error;
      }
      return result;
    } catch (error) {
      if (error.workerResponse) throw error;
      state = readJson(path.join(dir, 'state.json'));
      if (state.status !== 'running' && action === 'read') return readOutput(dir, state, args.offset, args.maxBytes);
      if (action === 'read') return readOutput(dir, { ...state, status: 'unreachable', note: 'Worker unavailable; output is the last saved snapshot.' }, args.offset, args.maxBytes);
      throw new Error(`Session worker unavailable; saved output remains on disk. ${error.message}`);
    }
  }

  async list() {
    const base = path.join(this.config.runtime, 'sessions');
    if (!fs.existsSync(base)) return [];
    const states = [];
    for (const id of fs.readdirSync(base).filter(x => /^[a-f0-9-]{36}$/.test(x))) {
      try {
        const state = readJson(path.join(base, id, 'state.json'));
        if (state.status === 'running') {
          try { await this.request(id, 'status'); }
          catch { state.status = 'unreachable'; state.note = 'Worker unavailable; logs retained.'; }
        }
        states.push(publicState(state));
      } catch { }
    }
    return states;
  }

  start(args) {
    const operation = this.startQueue.then(() => this.startOne(args));
    this.startQueue = operation.catch(() => { });
    return operation;
  }

  async startOne({ kind = 'job', shell, command, cwd, env = {}, cols = 120, rows = 30, label = '', requestId }) {
    shell ||= this.config.defaultShell;
    if (!this.config.shells[shell]) throw new Error(`Unknown shell: ${shell}`);
    if (kind === 'job' && !command) throw new Error('command is required');
    if (kind === 'terminal') throw new Error('Interactive terminals require node-pty, not available in this build');
    cwd ||= this.config.defaultCwd;
    if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an existing directory');
    if (requestId) {
      const match = (await this.list()).find(x => x.requestId === requestId);
      if (match) {
        const prior = readJson(path.join(sessionDir(this.config, match.id), 'spec.json'));
        if (prior.kind !== kind || prior.shell !== shell || prior.command !== command || prior.cwd !== cwd || JSON.stringify(prior.env) !== JSON.stringify(env)) throw new Error('requestId was already used for a different request');
        return match;
      }
    }
    const active = (await this.list()).filter(x => x.status === 'running');
    if (active.length >= this.config.maxActiveSessions) throw new Error('Active session limit reached; close unused sessions');
    const id = randomUUID();
    const dir = sessionDir(this.config, id);
    const spec = { id, kind, shell, command, cwd: path.resolve(cwd), env, cols, rows, label, requestId, token: secret() };
    atomicJson(path.join(dir, 'spec.json'), spec);
    const out = fs.openSync(path.join(dir, 'worker.stdout.log'), 'a');
    const err = fs.openSync(path.join(dir, 'worker.stderr.log'), 'a');
    let worker;
    try {
      worker = spawn(process.execPath, [path.join(ROOT, 'src', 'engine', 'session-worker.mjs'), dir], {
        cwd: ROOT, env: { ...childEnv(), LOCAL_AGENT_CONFIG: CONFIG_PATH },
        detached: true, windowsHide: true, stdio: ['ignore', out, err]
      });
      worker.unref();
    } finally { fs.closeSync(out); fs.closeSync(err); }
    let spawnError;
    worker.on('error', error => { spawnError = error; });
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      const file = path.join(dir, 'state.json');
      if (fs.existsSync(file)) {
        const state = readJson(file);
        if (state.status === 'failed') throw new Error(state.error);
        return publicState(state);
      }
      await sleep(100);
    }
    throw new Error(`Worker startup timed out; inspect ${dir}`);
  }
}
