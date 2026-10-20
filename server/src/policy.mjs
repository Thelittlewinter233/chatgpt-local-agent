import fs from 'node:fs';
import path from 'node:path';

const DENY_PATTERNS = [
  /\b(shutdown|taskkill|regedit|diskpart|bcdedit|vssadmin|cipher|wmic|deltree)\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(remove-item|stop-process|stop-computer|restart-computer|set-executionpolicy|clear-content|remove-itemproperty)\b/i,
  /(^|[;&|\s])(reg|sc|net|netsh|runas)\s/i,
  /\b(del|erase|rd|rmdir|rm)\b/i
];

export function checkPath(config, p, bypassRoots) {
  if (typeof p !== 'string' || !p.trim()) {
    const e = new Error('path is required');
    e.denied = true;
    throw e;
  }
  const resolved = path.resolve(p);
  if (bypassRoots) return resolved;
  const norm = resolved.toLowerCase();
  const sep = path.sep;
  const ok = (config.allowedRoots || []).some(r => {
    const rr = path.resolve(r).toLowerCase();
    return norm === rr || norm.startsWith(rr.endsWith(sep) ? rr : rr + sep);
  });
  if (!ok) {
    const e = new Error(`Path outside allowedRoots: ${resolved}; ask the user to approve it in the confirm bar, or add this directory to allowedRoots in server/config.json and restart the server`);
    e.denied = true;
    throw e;
  }
  return resolved;
}

export function checkPathResolved(config, p, bypassRoots) {
  let resolved = checkPath(config, p, bypassRoots);
  let current = resolved;
  const missing = [];
  for (;;) {
    try { current = fs.realpathSync(current); break; }
    catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  let real = current;
  while (missing.length) real = path.join(real, missing.pop());
  if (real.toLowerCase() !== resolved.toLowerCase()) resolved = checkPath(config, real, bypassRoots);
  return resolved;
}

export function checkTerminalInput(config, input) {
  if (typeof input !== 'string' || !input) {
    const e = new Error('input is required');
    e.denied = true;
    throw e;
  }
  if (input.length > 100000) {
    const e = new Error('terminal input exceeds 100000 characters');
    e.denied = true;
    throw e;
  }
  for (const re of DENY_PATTERNS) if (re.test(input)) {
    const e = new Error(`blacklisted pattern in terminal input: ${re}`);
    e.denied = true;
    throw e;
  }
  return { ok: true };
}

export function classifyCommand(config, command, cwd, bypassRoots) {
  const deny = reason => ({ kind: 'deny', reason });
  if (typeof command !== 'string' || !command.trim()) return deny('command is required');
  if (command.length > 16000) return deny('command exceeds 16000 characters');
  try { checkPathResolved(config, cwd || config.defaultCwd, bypassRoots); }
  catch (e) { return { kind: 'deny', reason: e.message }; }
  for (const re of DENY_PATTERNS) if (re.test(command)) return deny(`blacklisted pattern in command: ${re}`);
  const policy = config.policy || {};
  if (policy.defaultAllow) return { kind: 'ok' };
  const whitelist = new Set((policy.whitelist || []).map(w => String(w).toLowerCase()));
  const segments = command.split(/[;|\n]|&{1,2}/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const head = seg.replace(/^[-&@\s]+/, '').split(/[\s(]/)[0].toLowerCase();
    if (whitelist.has(head)) continue;
    if (policy.confirmUnknown) return { kind: 'confirm', head, reason: `command head "${head}" is outside the whitelist` };
    if (config.policy?.allowOutOfRoots) continue;
    return deny(`command head "${head}" is not whitelisted; add it to config.policy.whitelist or set policy.defaultAllow=true`);
  }
  return { kind: 'ok' };
}

export function checkCommand(config, command, cwd, bypassRoots) {
  const verdict = classifyCommand(config, command, cwd, bypassRoots);
  if (verdict.kind === 'deny') {
    const e = new Error(verdict.reason);
    e.denied = true;
    throw e;
  }
  if (verdict.kind === 'confirm') return { ok: true, needConfirm: true, head: verdict.head };
  return { ok: true };
}
