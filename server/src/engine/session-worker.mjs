import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { loadConfig, readJson, atomicJson, readBody, json, readOutput, publicState, childEnv, sleep } from './common.mjs';

const dir = path.resolve(process.argv[2]);
const config = loadConfig();
const spec = readJson(path.join(dir, 'spec.json'));
const stateFile = path.join(dir, 'state.json');
const state = {
  id: spec.id, kind: spec.kind, shell: spec.shell, cwd: spec.cwd, label: spec.label,
  requestId: spec.requestId, workerPid: process.pid, createdAt: new Date().toISOString(), status: 'starting',
  token: spec.token, port: 0, pid: null, exitCode: null, outputBytes: 0, baseOffset: 0
};
let child, terminal, stopping = false, segmentStart = 0, segmentBytes = 0, exitScheduled = false;
const segmentLimit = Math.max(1024, Math.min(1024 * 1024, Math.floor(config.maxOutputBytes / 4)));
let segments = [];

const save = () => atomicJson(stateFile, state);

function append(data) {
  const bytes = Buffer.from(data, 'utf8');
  for (let pos = 0; pos < bytes.length;) {
    if (segmentBytes >= segmentLimit) { segmentStart = state.outputBytes; segmentBytes = 0; }
    const file = path.join(dir, `${segmentStart}.log`);
    if (!segments.some(x => x.start === segmentStart)) segments.push({ start: segmentStart, file });
    const slice = bytes.subarray(pos, pos + segmentLimit - segmentBytes);
    fs.appendFileSync(file, slice);
    pos += slice.length;
    segmentBytes += slice.length;
    state.outputBytes += slice.length;
    while (segments.length > 1 && state.outputBytes - segments[0].start > config.maxOutputBytes) {
      fs.unlinkSync(segments.shift().file);
      state.baseOffset = segments[0].start;
    }
  }
  save();
}

function complete(code, error) {
  if (state.status !== 'running' && state.status !== 'starting') return;
  state.status = error ? 'failed' : stopping ? 'terminated' : 'completed';
  state.exitCode = code;
  state.finishedAt = new Date().toISOString();
  if (error) state.error = String(error.message || error);
  save();
  if (!exitScheduled) {
    exitScheduled = true;
    setTimeout(() => server.close(() => process.exit(0)), 3000).unref();
  }
}

async function terminate() {
  if (state.status !== 'running') return;
  stopping = true;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(state.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', reject);
      killer.on('exit', code => code === 0 || state.status !== 'running' ? resolve() : reject(new Error(`taskkill failed: ${code}`)));
    });
  } else if (terminal) terminal.kill();
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  for (let i = 0; i < 40 && state.status === 'running'; i++) await sleep(100);
  if (state.status === 'running') throw new Error('Process has not confirmed termination');
}

const server = http.createServer(async (req, res) => {
  const auth = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${spec.token}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(res, 401, { error: 'Unauthorized' });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
  try {
    const args = await readBody(req);
    switch (req.url) {
      case '/status': return json(res, 200, publicState(state));
      case '/read': {
        const start = Date.now();
        const offset = args.offset ?? 0;
        const wait = Math.min(Math.max(args.waitMs || 0, 0), 20000);
        while (state.status === 'running' && state.outputBytes <= offset && Date.now() - start < wait) await sleep(50);
        return json(res, 200, readOutput(dir, state, offset, args.maxBytes));
      }
      case '/write': {
        if (state.status !== 'running') throw new Error(`Session is ${state.status}`);
        if (typeof args.input !== 'string') throw new Error('input must be a string');
        const input = args.input + (args.newline ? (terminal ? '\r' : '\n') : '');
        if (terminal) terminal.write(input);
        else if (!child.stdin.destroyed) child.stdin.write(input);
        else throw new Error('stdin is closed');
        return json(res, 200, { ...publicState(state), accepted: true });
      }
      case '/interrupt': {
        if (state.status !== 'running') throw new Error(`Session is ${state.status}`);
        if (!terminal) throw new Error('Ctrl+C requires a terminal; use session_close for a pipe job');
        terminal.write('\x03');
        return json(res, 200, publicState(state));
      }
      case '/close': await terminate(); return json(res, 200, publicState(state));
      default: return json(res, 404, { error: 'Unknown action' });
    }
  } catch (error) { json(res, 400, { error: error.message }); }
});

server.requestTimeout = 30000;
server.listen(0, '127.0.0.1', async () => {
  state.port = server.address().port;
  try {
    const executable = config.shells[spec.shell];
    const isBash = spec.shell === 'git-bash';
    const env = childEnv({ ...spec.env, TERM: 'xterm-256color' });
    if (spec.kind === 'terminal') {
      const pty = (await import('node-pty')).default;
      terminal = pty.spawn(executable, isBash ? ['--noprofile', '--norc', '-i'] : ['-NoLogo', '-NoProfile', '-NoExit'], {
        name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env,
        useConpty: true, useConptyDll: true
      });
      state.pid = terminal.pid;
      state.status = 'running';
      save();
      terminal.onData(append);
      terminal.onExit(({ exitCode }) => complete(exitCode));
      if (!isBash) terminal.write("[Console]::InputEncoding = New-Object System.Text.UTF8Encoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::OutputEncoding\r");
    } else {
      const file = path.join(dir, isBash ? 'command.sh' : 'command.ps1');
      const content = isBash ? spec.command : "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding\n$OutputEncoding = [Console]::OutputEncoding\n" + spec.command;
      fs.writeFileSync(file, (isBash ? '' : '\ufeff') + content, { mode: 0o600 });
      const args = isBash ? ['--noprofile', '--norc', file.replaceAll('\\', '/')] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
      child = spawn(executable, args, { cwd: spec.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      state.pid = child.pid;
      state.status = 'running';
      save();
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', data => append(stdoutDecoder.write(data)));
      child.stderr.on('data', data => append(stderrDecoder.write(data)));
      child.on('error', error => complete(null, error));
      child.on('close', code => { append(stdoutDecoder.end()); append(stderrDecoder.end()); complete(code); });
    }
  } catch (error) { complete(null, error); }
});

process.on('uncaughtException', error => { console.error(error); complete(null, error); process.exit(1); });
