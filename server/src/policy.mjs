import fs from 'node:fs';
import path from 'node:path';

const DENY_PATTERNS = [
  /\b(shutdown|taskkill|regedit|diskpart|bcdedit|vssadmin|cipher|wmic|deltree)\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(remove-item|stop-process|stop-computer|restart-computer|set-executionpolicy|clear-content|remove-itemproperty)\b/i,
  /(^|[;&|\s])(reg|sc|net|netsh|runas)\s/i,
  /\b(del|erase|rd|rmdir|rm)\b/i
];

export function checkPath(config, p) {
  if (typeof p !== 'string' || !p.trim()) {
    const e = new Error('path is required');
    e.denied = true;
    throw e;
  }
  const resolved = path.resolve(p);
  const norm = resolved.toLowerCase();
  const sep = path.sep;
  const ok = (config.allowedRoots || []).some(r => {
    const rr = path.resolve(r).toLowerCase();
    return norm === rr || norm.startsWith(rr.endsWith(sep) ? rr : rr + sep);
  });
  if (!ok) {
    const e = new Error(`Path outside allowedRoots: ${resolved}`);
    e.denied = true;
    throw e;
  }
  return resolved;
}

export function classifyCommand(config, command, cwd) {
  const deny = reason => ({ kind: 'deny', reason });
  if (typeof command !== 'string' || !command.trim()) return deny('command is required');
  if (command.length > 4000) return deny('command exceeds 4000 characters');
  try { checkPath(config, cwd || config.defaultCwd); }
  catch (e) { return { kind: 'deny', reason: e.message }; }
  for (const re of DENY_PATTERNS) if (re.test(command)) return deny(`blacklisted pattern in command: ${re}`);
  const policy = config.policy || {};
  if (policy.defaultAllow) return { kind: 'ok' };
  const whitelist = new Set((policy.whitelist || []).map(w => String(w).toLowerCase()));
  const segments = command.split(/;|\||\n|&&/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const head = seg.replace(/^[-&@\s]+/, '').split(/[\s(]/)[0].toLowerCase();
    if (whitelist.has(head)) continue;
    if (policy.confirmUnknown) return { kind: 'confirm', head, reason: `command head "${head}" is outside the whitelist` };
    return deny(`command head "${head}" is not whitelisted; add it to config.policy.whitelist or set policy.defaultAllow=true`);
  }
  return { kind: 'ok' };
}

export function checkCommand(config, command, cwd) {
  const verdict = classifyCommand(config, command, cwd);
  if (verdict.kind === 'deny') {
    const e = new Error(verdict.reason);
    e.denied = true;
    throw e;
  }
  if (verdict.kind === 'confirm') return { ok: true, needConfirm: true, head: verdict.head };
  return { ok: true };
}
