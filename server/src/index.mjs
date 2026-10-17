import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, atomicJson, readJson, secret, sleep } from './engine/common.mjs';
import { Sessions } from './engine/sessions.mjs';
import { createFsTools } from './fs-tools.mjs';
import { classifyCommand, checkTerminalInput, checkPath } from './policy.mjs';
import { startWsServer } from './ws-server.mjs';

const base = readJson(path.join(ROOT, 'config.json'));
const localPath = path.join(ROOT, 'config.local.json');
const local = fs.existsSync(localPath) ? readJson(localPath) : {};
const token = local.token || secret();
atomicJson(localPath, { ...base, token });
const config = loadConfig();

const sessions = new Sessions(config);
const fsTools = createFsTools(config);

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

function audit(event) {
  try {
    const dir = path.join(config.runtime, 'audit');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (e) { log('audit write failed:', String(e && e.message || e)); }
}

function clip(v, n = 400) {
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function computerInfo() {
  return {
    platform: process.platform,
    node: process.version,
    defaultShell: config.defaultShell,
    shells: Object.keys(config.shells),
    defaultCwd: config.defaultCwd,
    policyMode: config.policy?.defaultAllow ? 'blacklist-only' : 'whitelist',
    limits: { maxActiveSessions: config.maxActiveSessions, waitMsMax: 60000, commandMaxLength: 16000 },
    notes: [
      'File tools are restricted to allowedRoots; shell cwd must also be inside allowedRoots.',
      'shell runs as the current Windows user; whitelist gates command heads, blacklist always wins.',
      'terminal_start opens a persistent interactive PTY (variables/cwd/REPL persist across steps); use session_write then session_read; Ctrl+C via session_interrupt; close unused terminals. Terminal input is checked against the blacklist only.',
      'End a task with action "done" so the bridge resets its step counters.'
    ]
  };
}

async function runShell(args, ctx) {
  const verdict = classifyCommand(config, args.command, args.cwd, ctx && ctx.bypassRoots);
  if (verdict.kind === 'deny') {
    const e = new Error(verdict.reason);
    e.denied = true;
    throw e;
  }
  if (verdict.kind === 'confirm' && !config.policy?.allowOutOfRoots) {
    const preview = `shell [${verdict.head}] ${String(args.command).slice(0, 160)}`;
    let approved = false;
    try { if (ctx && ctx.requestConfirm) approved = await ctx.requestConfirm(preview); }
    catch { approved = false; }
    if (!approved) {
      const e = new Error(`command "${verdict.head}" was rejected by the user or confirm timed out (60s)`);
      e.denied = true;
      throw e;
    }
  }
  const state = await sessions.start({
    kind: 'job',
    command: args.command,
    shell: args.shell,
    cwd: args.cwd,
    env: {},
    label: args.label || '',
    requestId: args.requestId
  });
  if (args.mode === 'detach') return { ...state, sessionId: state.id, detached: true };
  const waitMs = Math.min(Math.max(Number(args.waitMs) || 5000, 0), 60000);
  const end = Date.now() + waitMs;
  let result;
  do {
    result = await sessions.request(state.id, 'read', { offset: 0, maxBytes: 65536, waitMs: 0 });
    if (result.status !== 'running' || Date.now() >= end) break;
    await sleep(50);
  } while (true);
  return { ...result, sessionId: state.id };
}

const FS_MUTATING = new Set(['fs_write', 'fs_edit', 'fs_edit_multi', 'fs_move', 'fs_mkdir', 'fs_delete']);

async function dispatch(action, args, ctx) {
  const mutating = ['fs_write', 'fs_edit', 'fs_edit_multi', 'fs_move', 'fs_mkdir', 'fs_delete', 'shell', 'terminal_start', 'session_write', 'session_close'];
  const started = Date.now();
  let outcome = 'ok';
  let bypassed = false;
  try {
    return await route(action, args, ctx);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const allowAllFs = config.policy?.allowOutOfRoots && action.startsWith('fs_');
    const bypassEligible = FS_MUTATING.has(action) || allowAllFs || action === 'shell' || action === 'terminal_start';
    if (e && e.denied && /Path outside allowedRoots/.test(msg)
      && bypassEligible && ctx && typeof ctx.requestConfirm === 'function' && !ctx.bypassRoots) {
      const target = clip(args.path || args.from || args.cwd || '', 200);
      if (config.policy?.allowOutOfRoots) {
        bypassed = true;
        return await route(action, args, { ...ctx, bypassRoots: true });
      }
      const approved = await ctx.requestConfirm(`放行 ${action} 到 allowedRoots 外路径：${target}${args.to ? ' → ' + clip(args.to, 200) : ''}`);
      if (approved) {
        try {
          bypassed = true;
          return await route(action, args, { ...ctx, bypassRoots: true });
        } catch (e2) {
          outcome = e2 && e2.denied ? 'denied' : 'error';
          throw e2;
        }
      }
      outcome = 'denied';
      const denied = new Error(`user rejected out-of-roots ${action} to ${target}; add the directory to allowedRoots in server/config.json to allow it permanently`);
      denied.denied = true;
      throw denied;
    }
    outcome = e && e.denied ? 'denied' : 'error';
    throw e;
  } finally {
    if (mutating.includes(action)) {
      audit({
        action,
        outcome,
        bypass: bypassed || undefined,
        ms: Date.now() - started,
        target: clip(args.path || args.from || args.to || args.command || args.input || args.sessionId || '', 400),
        shell: args.shell
      });
    }
  }
}

async function route(action, args, ctx) {
  switch (action) {
    case 'computer_info': return computerInfo();
    case 'fs_read': return fsTools.read(args, ctx);
    case 'fs_write': return fsTools.write(args, ctx);
    case 'fs_edit': return fsTools.edit(args, ctx);
    case 'fs_edit_multi': return fsTools.editMulti(args, ctx);
    case 'fs_glob': return fsTools.glob(args, ctx);
    case 'fs_grep': return fsTools.grep(args, ctx);
    case 'fs_list': return fsTools.list(args, ctx);
    case 'fs_tree': return fsTools.tree(args, ctx);
    case 'fs_search': return fsTools.search(args, ctx);
    case 'fs_move': return fsTools.move(args, ctx);
    case 'fs_mkdir': return fsTools.mkdir(args, ctx);
    case 'fs_info': return fsTools.info(args, ctx);
    case 'fs_delete': {
      const p = String(args.path || '');
      let outOfRoots = false;
      try { checkPath(config, p); }
      catch (e) {
        if (e && e.denied && /Path outside allowedRoots/.test(String(e.message || ''))) outOfRoots = true;
        else throw e;
      }
      if (config.policy?.allowOutOfRoots) {
        return fsTools.del(args, outOfRoots ? { ...ctx, bypassRoots: true } : ctx);
      }
      const preview = outOfRoots ? `删除文件（路径在 allowedRoots 之外，将临时放行）：${p}` : `删除文件：${p}`;
      const approved = await ctx.requestConfirm(preview);
      if (!approved) {
        const denied = new Error(`user rejected deletion of ${p}`);
        denied.denied = true;
        throw denied;
      }
      return fsTools.del(args, outOfRoots ? { ...ctx, bypassRoots: true } : ctx);
    }
    case 'shell': return runShell(args, ctx);
    case 'session_read': return sessions.request(args.sessionId, 'read', args);
    case 'session_list': return { sessions: await sessions.list() };
    case 'session_close': return sessions.request(args.sessionId, 'close');
    case 'terminal_start': {
      checkPath(config, args.cwd || config.defaultCwd, ctx && ctx.bypassRoots);
      const state = await sessions.start({
        kind: 'terminal',
        shell: args.shell,
        cwd: args.cwd,
        env: {},
        cols: args.cols,
        rows: args.rows,
        label: args.label || ''
      });
      return { ...state, sessionId: state.id };
    }
    case 'session_write': {
      checkTerminalInput(config, args.input);
      return sessions.request(args.sessionId, 'write', args);
    }
    case 'session_interrupt': return sessions.request(args.sessionId, 'interrupt');
    case 'session_resize': return sessions.request(args.sessionId, 'resize', args);
    case 'done': return { acknowledged: true };
    default: throw new Error(`Unknown action: ${action}`);
  }
}

function rotateToken() {
  const t = secret();
  config.token = t;
  const cur = readJson(localPath);
  cur.token = t;
  atomicJson(localPath, cur);
  return t;
}

function setPolicy(patch) {
  if (!patch || typeof patch !== 'object') return { allowOutOfRoots: !!config.policy?.allowOutOfRoots };
  if ('allowOutOfRoots' in patch) config.policy.allowOutOfRoots = !!patch.allowOutOfRoots;
  const base = readJson(path.join(ROOT, 'config.json'));
  base.policy = { ...base.policy, allowOutOfRoots: !!config.policy.allowOutOfRoots };
  atomicJson(path.join(ROOT, 'config.json'), base);
  log('policy updated via extension:', JSON.stringify({ allowOutOfRoots: !!config.policy.allowOutOfRoots }));
  return { allowOutOfRoots: !!config.policy.allowOutOfRoots };
}

startWsServer(config, dispatch, log, rotateToken, setPolicy);
log('config:', JSON.stringify({
  port: config.port,
  allowedRoots: config.allowedRoots,
  defaultShell: config.defaultShell,
  policyMode: config.policy?.defaultAllow ? 'blacklist-only' : 'whitelist'
}));
log(`pairing token stored in ${path.join(ROOT, 'config.local.json')}`);
