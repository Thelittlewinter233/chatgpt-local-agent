const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj)
};

let opts = { paused: false, autoSend: true, maxSteps: 30 };
let guard = { step: 0, failStreak: 0, lastHash8: '' };
let seen = [];
let lastResults = {};
let processing = false;
let cooldownUntil = 0;
let checkTimer = null;
let lastDbgKey = '';

async function loadState() {
  const o = await store.get(['ab_opts', 'ab_guard', 'ab_seen']);
  opts = Object.assign({ paused: false, autoSend: true, maxSteps: 30 }, o.ab_opts || {});
  guard = Object.assign({ step: 0, failStreak: 0, lastHash8: '' }, o.ab_guard || {});
  seen = o.ab_seen || [];
}

const saveState = () => store.set({ ab_opts: opts, ab_guard: guard, ab_seen: seen.slice(-300) });
const markSeen = key => { seen.push(key); if (seen.length > 500) seen = seen.slice(-300); saveState(); };

async function dbg(stage, extra) {
  const key = stage + '|' + (extra || '');
  if (key === lastDbgKey) return;
  lastDbgKey = key;
  try { await store.set({ ab_dbg: { stage, extra: extra || '', ts: Date.now() } }); } catch { }
  console.log('[AgentBridge]', stage, extra || '');
}

async function sha1(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const q = sel => document.querySelector(sel);

const ADAPTER = __AB_ADAPTER;

function isGenerating() {
  return ADAPTER.isGenerating();
}

function cleanHeader(text) {
  return String(text || '').replace(/copy( code)?|复制代码|复制/gi, '').trim().toLowerCase();
}

function codeBodyIfAgent(pre) {
  const code = pre.querySelector('code');
  if (!code) return null;
  const body = (code.textContent || '').trim();
  if (!body) return null;
  const tokens = [...(code.classList || [])];
  const header = cleanHeader(pre.querySelector('div, header, span')?.textContent);
  if (tokens.includes('language-agent') || header === 'agent' || body.startsWith('{"action"')) return body;
  return null;
}

function findLatestAgentBlock() {
  let latest = null;
  for (const pre of document.querySelectorAll('pre')) {
    const body = codeBodyIfAgent(pre);
    if (!body) continue;
    if (!latest || (latest.el.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING)) latest = { el: pre, body };
  }
  for (const code of document.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const body = (code.textContent || '').trim();
    if (body.startsWith('{"action"') && body.endsWith('}')) {
      if (!latest || (latest.el.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING)) latest = { el: code, body };
    }
  }
  return latest;
}

function scheduleCheck(delay = 350) {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(checkCycle, delay);
}

let leaderCache = null;

async function isLeader() {
  if (leaderCache && Date.now() - leaderCache.at < 5000) return leaderCache.value;
  let value = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'am-i-leader' });
    value = !!(r && r.leader);
  } catch { }
  leaderCache = { at: Date.now(), value };
  ensureLeaderPill(value);
  return value;
}

function ensureLeaderPill(isLeader) {
  const old = document.getElementById('ab-leader-pill');
  if (isLeader) {
    if (old) old.remove();
    return;
  }
  if (old) return;
  const pill = document.createElement('div');
  pill.id = 'ab-leader-pill';
  pill.textContent = '此页非任务标签 · 点击接管';
  pill.style.cssText = 'position:fixed;z-index:2147483647;left:16px;bottom:16px;padding:8px 14px;background:#7c2d12;color:#fff;font:12px/18px system-ui,sans-serif;border-radius:999px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3)';
  pill.addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ type: 'claim-leader' }); } catch { }
    leaderCache = { at: 0, value: true };
    pill.remove();
    toast('AgentBridge: 本标签已接管为任务标签');
    scheduleCheck(200);
  });
  document.body.appendChild(pill);
}

async function checkCycle() {
  try {
    if (processing || opts.paused) return;
    if (Date.now() < cooldownUntil) return;
    if (isGenerating()) { dbg('generating'); return; }
    const raw1 = findLatestAgentBlock();
    if (!raw1) { dbg('no-agent-block-on-page'); return; }
    if (!(await isLeader())) { dbg('not-leader-tab'); return; }
    const normalized = raw1.body.trim();
    const hash8 = (await sha1(normalized)).slice(0, 8);
    const dedupKey = ADAPTER.id + ':' + hash8;
    if (seen.includes(dedupKey)) {
      const hit = lastResults[dedupKey];
      if (hit && Date.now() - hit.at < 10 * 60 * 1000 && (hit.count || 0) < 1 && raw1.el !== hit.el) {
        hit.count = (hit.count || 0) + 1;
        hit.at = Date.now();
        hit.el = raw1.el;
        dbg('replay-cached-result', dedupKey);
        await sleep(600);
        if (isGenerating()) return;
        processing = true;
        try { await respond(hash8, hit.payload); } finally { processing = false; }
        return;
      }
      dbg('block-already-seen', dedupKey);
      return;
    }
    await sleep(600);
    if (isGenerating()) return;
    const raw2 = findLatestAgentBlock();
    if (!raw2 || raw2.body.trim() !== normalized) { dbg('stability-wait'); scheduleCheck(1000); return; }
    dbg('agent-block-detected', normalized.slice(0, 80));
    processing = true;
    try { await handleBlock(normalized, dedupKey, hash8, raw1.el); }
    finally { processing = false; }
  } catch (e) {
    dbg('check-error', String((e && e.stack) || e));
    toast('AgentBridge 检测出错：' + String((e && e.message) || e));
  }
}

const RESULT_CHAR_LIMIT = 12000;
const FIELD_CHAR_LIMIT = 9000;

function buildResultBody(hash8, payload) {
  const hint = '输出被截断。shell/会话结果用 session_read {sessionId, offset} 续读（offset 用返回的 nextOffset）；文件用 fs_read {path, offsetBytes} 续读（offsetBytes 用返回的 nextOffset），或 tailBytes 读末尾。';
  let slim = payload;
  if (payload && payload.ok && payload.data && typeof payload.data === 'object') {
    const d = { ...payload.data };
    let cut = false;
    for (const key of ['output', 'content']) {
      if (typeof d[key] === 'string' && d[key].length > FIELD_CHAR_LIMIT) {
        d[key] = d[key].slice(0, FIELD_CHAR_LIMIT) + '\n…[bridge-truncated]';
        cut = true;
      }
    }
    if (cut) slim = { ...payload, data: d, truncated: true, hint };
  }
  let body = JSON.stringify({ for: hash8, ...slim });
  if (body.length > RESULT_CHAR_LIMIT) {
    body = JSON.stringify({ for: hash8, ok: !!(payload && payload.ok), truncated: true, hint, preview: body.slice(0, RESULT_CHAR_LIMIT - 400) });
  }
  return body;
}

function cacheResult(key, payload, el) {
  const hit = lastResults[key];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
    hit.count = (hit.count || 0) + 1;
    hit.at = Date.now();
    if (el) hit.el = el;
  } else {
    lastResults[key] = { payload, at: Date.now(), count: 0, el: el || null };
  }
  const keys = Object.keys(lastResults);
  if (keys.length > 50) {
    keys.sort((a, b) => lastResults[a].at - lastResults[b].at);
    for (const k of keys.slice(0, keys.length - 50)) delete lastResults[k];
  }
}

async function handleBlock(raw, key, hash8, el) {
  let cmd;
  try { cmd = JSON.parse(raw); }
  catch {
    markSeen(key);
    const t = raw.trim();
    if (t.startsWith('{') && !t.endsWith('}')) {
      dbg('incomplete-agent-block', t.slice(0, 40));
      return;
    }
    cacheResult(key, { ok: false, error: 'invalid agent json' }, el);
    await respond(hash8, { ok: false, error: 'invalid agent json' });
    return;
  }
  if (!cmd || typeof cmd.action !== 'string') {
    markSeen(key);
    cacheResult(key, { ok: false, error: 'agent block missing action' }, el);
    await respond(hash8, { ok: false, error: 'agent block missing action' });
    return;
  }
  if (cmd.action === 'done') {
    guard = { step: 0, failStreak: 0, lastHash8: '' };
    markSeen(key);
    saveState();
    toast('AgentBridge: 任务完成，计数已重置');
    return;
  }
  const o = await store.get('pend');
  const pend = o.pend || {};
  const PEND_MAX_AGE = 10 * 60 * 1000;
  if (pend[key]) {
    if (Date.now() - (pend[key].at || 0) < PEND_MAX_AGE) {
      const payload = pend[key].payload;
      delete pend[key];
      await store.set({ pend });
      await deliver(key, hash8, payload);
      return;
    }
    delete pend[key];
    await store.set({ pend });
  }
  const limit = Math.min(Math.max(Number(opts.maxSteps) || 30, 10), 100);
  if (guard.step >= limit) {
    markSeen(key);
    cacheResult(key, { ok: false, denied: `single-task step limit (${limit}) reached; press New Task in the popup to continue` }, el);
    await respond(hash8, { ok: false, denied: `single-task step limit (${limit}) reached; press New Task in the popup to continue` });
    return;
  }
  if (guard.failStreak >= 3) {
    markSeen(key);
    cacheResult(key, { ok: false, denied: 'circuit breaker: 3 consecutive failures; check the agent server, then press New Task' }, el);
    await respond(hash8, { ok: false, denied: 'circuit breaker: 3 consecutive failures; check the agent server, then press New Task' });
    return;
  }
  if (guard.lastHash8 && guard.lastHash8 === key) {
    markSeen(key);
    cacheResult(key, { ok: false, denied: 'same command repeated; possible loop' }, el);
    await respond(hash8, { ok: false, denied: 'same command repeated; possible loop' });
    return;
  }
  markSeen(key);
  toast('AgentBridge: 执行 ' + cmd.action + ' …');
  let payload;
  try {
    payload = await chrome.runtime.sendMessage({ type: 'agent-cmd', hash8, action: cmd.action, args: cmd.args || {} });
  } catch (e) {
    payload = { ok: false, error: 'bridge unavailable: ' + ((e && e.message) || e) };
  }
  dbg('cmd-done', cmd.action + ' -> ' + JSON.stringify(payload).slice(0, 120));
  await deliver(key, hash8, payload, el);
}

async function deliver(key, hash8, payload, el) {
  guard.step += 1;
  guard.failStreak = payload && payload.ok ? 0 : guard.failStreak + 1;
  guard.lastHash8 = key;
  cacheResult(key, payload, el);
  await saveState();
  await respond(hash8, payload);
}

async function respond(hash8, payload) {
  const text = '```agent-result\n' + buildResultBody(hash8, payload) + '\n```';
  const filled = await ADAPTER.insertText(text);
  if (!filled) { dbg('fill-failed'); toast('AgentBridge: 回填失败（找不到输入框），请手动把结果发给 AI'); return; }
  const o = await store.get('ab_opts');
  const current = Object.assign({ paused: false, autoSend: true, maxSteps: 30 }, o.ab_opts || {});
  if (current.paused) { highlight(true); toast('AgentBridge: 已填入未发送（监听已暂停）'); return; }
  if (current.autoSend === false) { highlight(true); toast('AgentBridge: 已填入未发送（自动发送已关闭）'); return; }
  const sent = await ADAPTER.send();
  if (!sent) { highlight(true); toast('AgentBridge: 已填入未发送（发送失败），请手动按回车发送'); }
  else highlight(false);
  cooldownUntil = Date.now() + 5000;
}

function highlight(on) {
  const el = ADAPTER.findInput();
  if (el) el.style.outline = on ? '2px solid #f59e0b' : '';
}

function toast(message) {
  const old = document.getElementById('ab-toast');
  if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'ab-toast';
  div.textContent = message;
  div.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:10px 14px;background:#111827;color:#f9fafb;font:13px/18px system-ui,sans-serif;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);opacity:.96';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

function removeConfirmBar() {
  const old = document.getElementById('ab-confirm');
  if (old) old.remove();
}

function showConfirmBar(confirmId, preview) {
  removeConfirmBar();
  const bar = document.createElement('div');
  bar.id = 'ab-confirm';
  bar.style.cssText = 'position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);top:14px;max-width:640px;width:calc(100% - 32px);padding:12px 14px;background:#111827;color:#f9fafb;font:13px/18px system-ui,sans-serif;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35)';
  const label = document.createElement('div');
  label.textContent = 'AgentBridge 请求执行以下命令（白名单外）：';
  const code = document.createElement('div');
  code.textContent = preview;
  code.style.cssText = 'margin:6px 0 10px;padding:6px 8px;background:#1f2937;border-radius:6px;font:12px/16px monospace;word-break:break-all;color:#e5e7eb';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center';
  const yes = document.createElement('button');
  yes.textContent = '批准执行';
  yes.style.cssText = 'padding:5px 14px;border:0;border-radius:6px;background:#10b981;color:#04281a;font-weight:600;cursor:pointer';
  const no = document.createElement('button');
  no.textContent = '拒绝';
  no.style.cssText = 'padding:5px 14px;border:0;border-radius:6px;background:#374151;color:#f9fafb;cursor:pointer';
  const timer = document.createElement('span');
  timer.style.cssText = 'margin-left:auto;color:#9ca3af;font-size:12px';
  timer.textContent = '等待你的选择（不自动拒绝）';
  const resolve = approved => {
    removeConfirmBar();
    try { chrome.runtime.sendMessage({ type: 'confirm-resolve', confirmId, approved }).catch(() => { }); } catch { }
  };
  yes.addEventListener('click', () => resolve(true));
  no.addEventListener('click', () => resolve(false));
  row.append(yes, no, timer);
  bar.append(label, code, row);
  document.body.appendChild(bar);
}

const PROTOCOL_MARKER = '## 你是谁';

let protocolText = null;
let injecting = false;

async function injectProtocol() {
  if (injecting) return;
  injecting = true;
  try {
    const el = ADAPTER.findInput();
    const existing = String((el && el.textContent) || '') + String((el && el.value) || '');
    if (existing.includes(PROTOCOL_MARKER)) {
      toast('AgentBridge: 输入框已含协议，无需重复注入');
      return;
    }
    if (!protocolText) {
      const r = await chrome.runtime.sendMessage({ type: 'get-prompt' }).catch(e => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) { toast('AgentBridge: 协议获取失败 ' + ((r && r.error) || '')); return; }
      protocolText = r.text;
    }
    const filled = await ADAPTER.insertText(protocolText);
    if (filled) {
      highlight(true);
      toast('AgentBridge: 协议已注入，可补充任务后发送（Alt+P 随时再注入）');
    } else {
      toast('AgentBridge: 注入失败（找不到输入框）');
    }
  } finally {
    injecting = false;
  }
}

async function init() {
  await loadState();
  if (!ADAPTER) {
    dbg('no-adapter-for-this-site', location.host);
    return;
  }
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.code === 'KeyP' || e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      injectProtocol();
    }
  }, true);
  try { chrome.runtime.sendMessage({ type: 'content-hello' }).catch(() => { }); } catch { }
  new MutationObserver(() => scheduleCheck()).observe(document.body, { subtree: true, childList: true, characterData: true });
  setInterval(() => scheduleCheck(), 2500);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'inject-prompt') {
      (async () => {
        try {
          await injectProtocol();
          sendResponse({ ok: true, filled: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true;
    }
    if (msg.type === 'health-check') {
      sendResponse({
        ok: true,
        adapter: ADAPTER.id,
        host: location.host,
        inputFound: !!ADAPTER.findInput(),
        generating: isGenerating(),
        codeBlocks: document.querySelectorAll('pre code').length,
        agentBlocks: !!findLatestAgentBlock(),
        seen: seen.length,
        step: guard.step,
        failStreak: guard.failStreak
      });
      return;
    }
    if (msg.type === 'confirm-request') {
      showConfirmBar(msg.confirmId, msg.preview);
      sendResponse({ ok: true });
      return;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ab_opts) opts = Object.assign({ paused: false, autoSend: true, maxSteps: 30 }, changes.ab_opts.newValue || {});
    if (changes.ab_seen) seen = changes.ab_seen.newValue || [];
    if (changes.ab_guard) guard = Object.assign({ step: 0, failStreak: 0, lastHash8: '' }, changes.ab_guard.newValue || {});
    if (changes.resetGuard) {
      guard = { step: 0, failStreak: 0, lastHash8: '' };
      seen = [];
      saveState();
      toast('AgentBridge: 新任务，计数已重置');
    }
  });
  dbg('content-script-active', ADAPTER.id + '@' + location.host);
  scheduleCheck(500);
}

init();
