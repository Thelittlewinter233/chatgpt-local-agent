import fs from 'node:fs';
import path from 'node:path';

const DENY_PATTERNS = [
  /\b(shutdown|taskkill|regedit|diskpart|bcdedit|vssadmin|cipher|wmic|deltree)\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(remove-item|stop-process|stop-computer|restart-computer|set-executionpolicy|clear-content|remove-itemproperty)\b/i,
  /(^|[;&|\s])(reg|sc|net|netsh|runas)\s/i,
  /\b(del|erase|rd|rmdir|rm)\b/i
];

function denied(reason) {
  const error = new Error(reason);
  error.denied = true;
  return error;
}

export function checkPath(config, p, bypassRoots) {
  if (typeof p !== 'string' || !p.trim()) throw denied('path is required');
  const resolved = path.resolve(p);
  if (bypassRoots) return resolved;
  const norm = resolved.toLowerCase();
  const sep = path.sep;
  const ok = (config.allowedRoots || []).some(root => {
    const resolvedRoot = path.resolve(root).toLowerCase();
    return norm === resolvedRoot || norm.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
  });
  if (!ok) throw denied(`Path outside allowedRoots: ${resolved}; ask the user to approve it in the confirm bar, or add this directory to allowedRoots in server/config.json and restart the server`);
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
  if (typeof input !== 'string' || !input) throw denied('input is required');
  if (input.length > 100000) throw denied('terminal input exceeds 100000 characters');
  for (const re of DENY_PATTERNS) if (re.test(input)) throw denied(`blacklisted pattern in terminal input: ${re}`);
  return { ok: true };
}

function splitCommands(command) {
  const segments = [];
  const frames = [{ kind: 'command', closer: '', text: '', quote: '', escaped: false }];
  let expansionDepth = 0;
  const pushSegment = frame => {
    if (frame.text.trim()) segments.push(frame.text.trim());
    frame.text = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] || '';
    const frame = frames[frames.length - 1];
    if (frame.escaped) {
      frame.text += char;
      frame.escaped = false;
      continue;
    }
    if (char === '\\' && frame.quote !== "'") {
      frame.text += char;
      frame.escaped = true;
      continue;
    }
    if (frame.quote) {
      if (frame.quote === '"' && char === '$' && (next === '(' || next === '{')) {
        frame.text += char + next;
        frames.push({ kind: next === '(' ? 'command' : 'brace', closer: next === '(' ? ')' : '}', text: '', quote: '', escaped: false });
        expansionDepth += 1;
        if (expansionDepth > 8) throw new Error('command expansion nesting exceeds 8');
        index += 1;
      } else {
        if (char === frame.quote) frame.quote = '';
        frame.text += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      frame.quote = char;
      frame.text += char;
      continue;
    }
    if (char === '$' && (next === '(' || next === '{')) {
      frame.text += char + next;
      frames.push({ kind: next === '(' ? 'command' : 'brace', closer: next === '(' ? ')' : '}', text: '', quote: '', escaped: false });
      expansionDepth += 1;
      if (expansionDepth > 8) throw new Error('command expansion nesting exceeds 8');
      index += 1;
      continue;
    }
    if (frame.closer === char) {
      pushSegment(frame);
      frames.pop();
      expansionDepth -= 1;
      frames[frames.length - 1].text += char;
      continue;
    }
    if (frame.kind === 'command' && (char === ';' || char === '|' || char === '\n' || char === '&')) {
      pushSegment(frame);
      if (char === '&' && next === '&') index += 1;
      continue;
    }
    frame.text += char;
  }
  if (frames.some(frame => frame.quote)) throw new Error('unmatched quote in command');
  if (frames.length !== 1) throw new Error('unmatched command expansion');
  pushSegment(frames[0]);
  return segments;
}

function commandInfo(segment) {
  const cleaned = segment.trim().replace(/^[-@&\s]+/, '');
  if (!cleaned) return { head: '', args: '' };
  const quote = cleaned[0] === "'" || cleaned[0] === '"' || cleaned[0] === '`' ? cleaned[0] : '';
  let end = 0;
  if (quote) {
    end = 1;
    let escaped = false;
    for (; end < cleaned.length; end += 1) {
      const char = cleaned[end];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) break;
    }
    return { head: cleaned.slice(1, end).toLowerCase(), args: cleaned.slice(Math.min(end + 1, cleaned.length)) };
  }
  while (end < cleaned.length && !/[\s(){}]/.test(cleaned[end])) end += 1;
  return { head: cleaned.slice(0, end).toLowerCase(), args: cleaned.slice(end) };
}

function isInterpreterInline(head, args) {
  const base = head.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (base === 'node') return /(?:^|\s)(?:-e|--eval)(?:\s|=|$)/i.test(args);
  if (/^(?:python|python\d(?:\.\d+)?)$/.test(base)) return /(?:^|\s)-c(?:\s|$)/i.test(args);
  if (/^(?:powershell|pwsh)$/.test(base)) return /(?:^|\s)(?:-command|-c)(?:\s|$)/i.test(args);
  if (base === 'cmd') return /(?:^|\s)\/c(?:\s|$)/i.test(args);
  return false;
}

export function classifyCommand(config, command, cwd, bypassRoots) {
  const deny = reason => ({ kind: 'deny', reason });
  if (typeof command !== 'string' || !command.trim()) return deny('command is required');
  if (command.length > 16000) return deny('command exceeds 16000 characters');
  try { checkPathResolved(config, cwd || config.defaultCwd, bypassRoots); }
  catch (error) { return deny(error.message); }
  for (const re of DENY_PATTERNS) if (re.test(command)) return deny(`blacklisted pattern in command: ${re}`);
  const policy = config.policy || {};
  let segments;
  try { segments = splitCommands(command); }
  catch (error) { return deny(error.message); }
  const whitelist = new Set((policy.whitelist || []).map(value => String(value).toLowerCase()));
  const interpreterPolicy = ['confirm', 'deny', 'allow'].includes(policy.interpreterPolicy) ? policy.interpreterPolicy : 'confirm';
  for (const segment of segments) {
    const { head, args } = commandInfo(segment);
    if (!head) continue;
    if (isInterpreterInline(head, args)) {
      if (interpreterPolicy === 'deny') return deny(`inline interpreter command is denied: ${head}`);
      if (interpreterPolicy === 'confirm' && !policy.allowOutOfRoots) return { kind: 'confirm', head, reason: `inline interpreter command requires approval: ${head}` };
      continue;
    }
    if (policy.defaultAllow || whitelist.has(head) || policy.allowOutOfRoots === true) continue;
    if (policy.confirmUnknown !== false) return { kind: 'confirm', head, reason: `command head "${head}" is outside the whitelist` };
    return deny(`command head "${head}" is not whitelisted; add it to config.policy.whitelist or set policy.defaultAllow=true`);
  }
  return { kind: 'ok' };
}

export function checkCommand(config, command, cwd, bypassRoots) {
  const verdict = classifyCommand(config, command, cwd, bypassRoots);
  if (verdict.kind === 'deny') throw denied(verdict.reason);
  if (verdict.kind === 'confirm') return { ok: true, needConfirm: true, head: verdict.head };
  return { ok: true };
}
