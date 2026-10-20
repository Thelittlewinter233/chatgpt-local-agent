const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj)
};

let opts = { paused: false, autoSend: true, maxSteps: 30 };
let guard = { step: 0, failStreak: 0, lastHash8: '' };
let seen = [];
let lastResults = {};
const respondedEls = new WeakSet();
let processing = false;
let cycleRunning = false;
let cooldownUntil = 0;
let checkTimer = null;
let lastDbgKey = '';
let lastDriveHash = '';
let lastDriveAt = 0;
const pendingFillHandlers = new Map();
const recentDeliveries = new Map();
let dbgTimeline = [];
let dbgTabKey = 'x';
let timelineFlushTimer = null;
let myTabId = null;

const NOISY_STAGES = new Set(['no-agent-block-on-page', 'generating', 'block-already-seen', 'stability-wait', 'drive-check']);
const PEND_MAX_AGE = 10 * 60 * 1000;
const DELIVERY_DEDUP_MS = 60 * 1000;

const timelineKey = () => 'ab_dbg_timeline_' + dbgTabKey;
const kaStateKey = () => 'ab_ka_' + dbgTabKey;

function flushTimeline() {
  if (timelineFlushTimer) { clearTimeout(timelineFlushTimer); timelineFlushTimer = null; }
  try { store.set({ [timelineKey()]: dbgTimeline.slice(-50) }); } catch { }
}

function queueTimelineFlush(immediate) {
  if (immediate) { flushTimeline(); return; }
  if (!timelineFlushTimer) timelineFlushTimer = setTimeout(flushTimeline, 1000);
}

function adoptTimelineKey(key) {
  dbgTabKey = String(key);
  flushTimeline();
}

function kaSet(state, code) {
  try { store.set({ [kaStateKey()]: { state, code: code == null ? null : code, ts: Date.now(), host: location.host } }); } catch { }
}

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
  const ts = Date.now();
  const important = !NOISY_STAGES.has(stage);
  if (important) {
    dbgTimeline.push({ stage, extra: extra || '', ts, host: location.host });
    if (dbgTimeline.length > 60) dbgTimeline = dbgTimeline.slice(-50);
  }
  queueTimelineFlush(important);
  try { await store.set({ ab_dbg: { stage, extra: extra || '', ts, tab: dbgTabKey } }); } catch { }
  console.log('[AgentBridge]', stage, extra || '');
}

function markDelivered(hash8) {
  recentDeliveries.set(hash8, Date.now());
  for (const [k, t] of recentDeliveries) if (Date.now() - t > DELIVERY_DEDUP_MS) recentDeliveries.delete(k);
}

const recentlyDelivered = hash8 => {
  const at = recentDeliveries.get(hash8);
  return !!at && Date.now() - at < DELIVERY_DEDUP_MS;
};

async function takePend(key, hash8) {
  const o = await store.get('pend');
  const pend = o.pend || {};
  const found = pend[key] || pend[hash8];
  if (!found) return null;
  if (found.tabId != null && myTabId != null && String(found.tabId) !== String(myTabId)) return null;
  delete pend[key];
  delete pend[hash8];
  await store.set({ pend });
  if (Date.now() - (found.at || 0) >= PEND_MAX_AGE) return null;
  return found;
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
  const header = cleanHeader(pre.querySelector('div, header, span')?.textContent);
  const candidates = [
    ...pre.querySelectorAll('code'),
    ...pre.querySelectorAll('[class*="code-body" i]'),
    ...pre.querySelectorAll('span')
  ];
  for (const code of candidates) {
    const body = (code.textContent || '').trim();
    if (!body) continue;
    const tokens = [...(code.classList || [])];
    const isCodeEl = code.tagName === 'CODE';
    if (tokens.includes('language-agent') || body.startsWith('{"action"') || (isCodeEl && header === 'agent')) return body;
  }
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



async function checkCycle() {
  if (document.visibilityState === 'hidden' || cycleRunning) return;
  cycleRunning = true;
  try {
    if (processing || opts.paused) return;
    if (Date.now() < cooldownUntil) return;
    if (isGenerating()) { dbg('generating'); return; }
    const raw1 = findLatestAgentBlock();
    if (!raw1) { dbg('no-agent-block-on-page'); return; }
    const normalized = raw1.body.trim();
    const hash8 = (await sha1(normalized)).slice(0, 8);
    const dedupKey = ADAPTER.id + ':' + hash8;
    if (seen.includes(dedupKey)) {
      if (respondedEls.has(raw1.el)) {
        dbg('skip-responded-el', dedupKey);
        return;
      }
      const hit = lastResults[dedupKey];
      if (hit && hit.payload && hit.payload.ok) {
        dbg('replay-cached-new-el', dedupKey);
        processing = true;
        try { await respond(hash8, hit.payload, raw1.el); } finally { processing = false; }
        return;
      }
      dbg('rerun-seen-new-el', dedupKey);
      processing = true;
      try { await handleBlock(normalized, dedupKey, hash8, raw1.el); }
      finally { processing = false; }
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
  finally { cycleRunning = false; }
}

function driveCheck(source) {
  if (!ADAPTER) return 'no-adapter';
  if (kaWs && kaWs.readyState === WebSocket.OPEN) {
    try { kaWs.send(JSON.stringify({ type: 'ping' })); } catch { restartKeepAlive(); }
  } else restartKeepAlive();
  pullUndelivered();
  const hidden = document.visibilityState === 'hidden';
  let out;
  if (!hidden) out = 'visible';
  else if (processing || cycleRunning) out = 'busy';
  else if (opts.paused) out = 'paused';
  else if (Date.now() < cooldownUntil) out = 'cooldown';
  else if (source === 'execute-script') {
    if (isGenerating()) {
      lastDriveHash = '';
      out = 'generating';
    } else {
      const block = findLatestAgentBlock();
      if (!block) {
        lastDriveHash = '';
        out = 'no-block';
      } else {
        const normalized = block.body.trim();
        const now = Date.now();
        const stable = normalized === lastDriveHash && now - lastDriveAt >= 25000;
        lastDriveHash = normalized;
        lastDriveAt = now;
        if (!stable) out = 'stabilizing';
        else {
          processing = true;
          out = 'triggered';
          sha1(normalized).then(async hash => {
            const hash8 = hash.slice(0, 8);
            const dedupKey = ADAPTER.id + ':' + hash8;
            if (seen.includes(dedupKey)) {
              if (respondedEls.has(block.el)) {
                dbg('skip-responded-el', dedupKey);
                return;
              }
              const hit = lastResults[dedupKey];
              if (hit && hit.payload && hit.payload.ok) {
                dbg('replay-cached-new-el', dedupKey);
                await respond(hash8, hit.payload, block.el);
                return;
              }
              dbg('rerun-seen-new-el', dedupKey);
              await handleBlock(normalized, dedupKey, hash8, block.el);
              return;
            }
            dbg('agent-block-detected', normalized.slice(0, 80));
            await handleBlock(normalized, dedupKey, hash8, block.el);
          }).catch(e => {
            dbg('check-error', String((e && e.stack) || e));
            toast('AgentBridge 检测出错：' + String((e && e.message) || e));
          }).finally(() => { processing = false; });
        }
      }
    }
  } else { out = 'triggered'; checkCycle(); }
  dbg('drive-check', (hidden ? 'hidden' : 'visible') + ':' + out + ':' + Math.floor(Date.now() / 60000));
  return out;
}

window.__abCheck = driveCheck;

async function pullUndelivered() {
  if (!pendingFillHandlers.size) return 0;
  let frames = [];
  try {
    const r = await chrome.runtime.sendMessage({ type: 'pull-results' });
    if (r && r.ok && Array.isArray(r.frames)) frames = r.frames;
  } catch { return 0; }
  let hit = 0;
  for (const f of frames) {
    if (!f || !f.hash8) continue;
    const h = pendingFillHandlers.get(f.hash8);
    if (!h) continue;
    pendingFillHandlers.delete(f.hash8);
    hit += 1;
    dbg('pull-result-applied', String(f.hash8));
    h(f.payload);
  }
  return hit;
}

let mainKaLogged = '';

function logMainKa(state) {
  if (mainKaLogged === state) return;
  mainKaLogged = state;
  dbg(state === 'ok' ? 'main-ka-ok' : 'main-ka-' + state);
}

window.addEventListener('ab-main-ka-ok', () => logMainKa('ok'));
window.addEventListener('ab-main-ka-blocked', () => logMainKa('blocked'));
window.addEventListener('ab-main-ka-closed', () => logMainKa('closed'));

const RESULT_CHAR_LIMIT = 16000;
const FIELD_CHAR_LIMIT = 12000;

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
  lastResults[key] = { payload, at: Date.now(), el: el || null };
  const keys = Object.keys(lastResults);
  if (keys.length > 50) {
    keys.sort((a, b) => lastResults[a].at - lastResults[b].at);
    for (const k of keys.slice(0, keys.length - 50)) delete lastResults[k];
  }
}

async function runCmd(hash8, cmd) {
  const fillRace = new Promise(resolve => { pendingFillHandlers.set(hash8, resolve); });
  dbg('cmd-sent', cmd.action + ':' + hash8);
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({ type: 'agent-cmd', hash8, action: cmd.action, args: cmd.args || {} }),
      fillRace
    ]);
  } finally {
    pendingFillHandlers.delete(hash8);
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
    await respond(hash8, { ok: false, error: 'invalid agent json' }, el);
    return;
  }
  if (!cmd || typeof cmd.action !== 'string') {
    markSeen(key);
    cacheResult(key, { ok: false, error: 'agent block missing action' }, el);
    await respond(hash8, { ok: false, error: 'agent block missing action' }, el);
    return;
  }
  if (cmd.action === 'done') {
    guard = { step: 0, failStreak: 0, lastHash8: '' };
    markSeen(key);
    saveState();
    toast('AgentBridge: 任务完成，计数已重置');
    return;
  }
  const pendHit = await takePend(key, hash8);
  if (pendHit) {
    await deliver(key, hash8, pendHit.payload, el);
    return;
  }
  const limit = Math.min(Math.max(Number(opts.maxSteps) || 30, 10), 100);
  if (guard.step >= limit) {
    markSeen(key);
    cacheResult(key, { ok: false, denied: `single-task step limit (${limit}) reached; press New Task in the popup to continue` }, el);
    await respond(hash8, { ok: false, denied: `single-task step limit (${limit}) reached; press New Task in the popup to continue` }, el);
    return;
  }
  if (guard.failStreak >= 3) {
    markSeen(key);
    cacheResult(key, { ok: false, denied: 'circuit breaker: 3 consecutive failures; check the agent server, then press New Task' }, el);
    await respond(hash8, { ok: false, denied: 'circuit breaker: 3 consecutive failures; check the agent server, then press New Task' }, el);
    return;
  }
  markSeen(key);
  toast('AgentBridge: 执行 ' + cmd.action + ' …');
  let payload;
  try { payload = await runCmd(hash8, cmd); }
  catch (e) { payload = { ok: false, error: 'bridge unavailable: ' + ((e && e.message) || e) }; }
  if (payload && payload.ok === false && payload.error === 'server offline') {
    dbg('bridge-wake-retry', hash8);
    try { await chrome.runtime.sendMessage({ type: 'wake' }); } catch { }
    await sleep(2500);
    try { payload = await runCmd(hash8, cmd); }
    catch (e) { payload = { ok: false, error: 'bridge unavailable: ' + ((e && e.message) || e) }; }
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
  await respond(hash8, payload, el);
}

async function respond(hash8, payload, el) {
  try {
  const text = '```agent-result\n' + buildResultBody(hash8, payload) + '\n```';
  dbg('fill-start', hash8);
  const filled = await ADAPTER.insertText(text);
  if (!filled) { dbg('fill-failed', hash8); toast('AgentBridge: 回填失败（找不到输入框），请手动把结果发给 AI'); return; }
  dbg('fill-done', hash8);
  const o = await store.get('ab_opts');
  const current = Object.assign({ paused: false, autoSend: true, maxSteps: 30 }, o.ab_opts || {});
  if (current.paused) { highlight(true); toast('AgentBridge: 已填入未发送（监听已暂停）'); return; }
  if (current.autoSend === false) { highlight(true); toast('AgentBridge: 已填入未发送（自动发送已关闭）'); return; }
  const sent = await ADAPTER.send();
  if (!sent) { dbg('send-failed', hash8); highlight(true); toast('AgentBridge: 已填入未发送（发送失败），请手动按回车发送'); }
  else { dbg('send-done', hash8); highlight(false); }
  cooldownUntil = Date.now() + 5000;
  } finally {
    if (el) respondedEls.add(el);
  }
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
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = '关闭（忽略此请求，不执行也不回复结果）';
  close.style.cssText = 'position:absolute;top:6px;right:8px;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:#9ca3af;font-size:16px;line-height:22px;cursor:pointer';
  close.addEventListener('mouseenter', () => { close.style.color = '#f9fafb'; close.style.background = '#374151'; });
  close.addEventListener('mouseleave', () => { close.style.color = '#9ca3af'; close.style.background = 'transparent'; });
  close.addEventListener('click', () => removeConfirmBar());
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
  bar.append(label, code, row, close);
  document.body.appendChild(bar);
}

const PROTOCOL_MARKER = '## 你是谁';

const KA_BACKOFF = [1000, 5000, 30000];
let kaWs = null;
let kaReconnectTimer = null;
let kaPingTimer = null;
let kaBackoffIdx = 0;
let kaTabId = null;
let kaLastPing = 0;

async function kaDigest(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function scheduleKaReconnect() {
  if (kaReconnectTimer) return;
  const delay = KA_BACKOFF[Math.min(kaBackoffIdx, KA_BACKOFF.length - 1)] + Math.floor(Math.random() * 400);
  kaBackoffIdx += 1;
  kaReconnectTimer = setTimeout(() => { kaReconnectTimer = null; startKeepAlive(kaTabId); }, delay);
}

async function startKeepAlive(tabId) {
  if (tabId != null) kaTabId = tabId;
  if (kaWs && (kaWs.readyState === 0 || kaWs.readyState === 1)) return;
  const o = await store.get(['serverUrl', 'token']);
  const base = o.serverUrl || 'ws://127.0.0.1:9752';
  const token = o.token || '';
  if (!token) { scheduleKaReconnect(); return; }
  let url;
  try {
    const u = new URL(base);
    u.searchParams.set('ka', await kaDigest(token));
    url = u.toString();
  } catch { scheduleKaReconnect(); return; }
  let sock;
  try { sock = new WebSocket(url); } catch { scheduleKaReconnect(); return; }
  kaWs = sock;
  sock.onopen = () => {
    kaSet('connecting');
    dbg('ka-ws-open', base);
    try { sock.send(JSON.stringify({ type: 'hello', token, v: 1, sessionId: 'ka-' + (kaTabId || 'x') + '-' + Math.random().toString(36).slice(2, 8) })); } catch { }
  };
  sock.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello_ok') {
      kaBackoffIdx = 0;
      kaSet('connected');
      dbg('ka-ws-ok', 'ka-' + (kaTabId || 'x'));
      if (kaPingTimer) clearInterval(kaPingTimer);
      kaLastPing = Date.now();
      kaPingTimer = setInterval(() => {
        const now = Date.now();
        const gap = Math.round((now - kaLastPing) / 1000);
        kaLastPing = now;
        if (gap > 90) dbg('freeze-detected', 'gap=' + gap + 's');
        try { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping' })); } catch { }
      }, 20000);
    }
  };
  sock.onclose = ev => {
    const code = ev && ev.code != null ? ev.code : null;
    kaSet('disconnected', code);
    dbg('ka-ws-close', String(code));
    if (kaPingTimer) { clearInterval(kaPingTimer); kaPingTimer = null; }
    if (kaWs === sock) kaWs = null;
    scheduleKaReconnect();
  };
  sock.onerror = () => { };
}

function restartKeepAlive() {
  if (kaReconnectTimer) { clearTimeout(kaReconnectTimer); kaReconnectTimer = null; }
  if (kaPingTimer) { clearInterval(kaPingTimer); kaPingTimer = null; }
  if (kaWs) {
    const sock = kaWs;
    kaWs = null;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    try { sock.close(); } catch { }
  }
  kaBackoffIdx = 0;
  startKeepAlive(kaTabId);
}

function acquireKeepAliveLock() {
  try {
    if (navigator.locks && navigator.locks.request) navigator.locks.request('agent-bridge-keepalive-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), () => { dbg('lock-acquired'); return new Promise(() => { }); });
  } catch { }
}

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
  acquireKeepAliveLock();
  (async () => {
    let tabId = null;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'content-hello' });
      if (r && r.tabId != null) tabId = String(r.tabId);
    } catch { }
    if (tabId) { myTabId = tabId; adoptTimelineKey(tabId); }
    startKeepAlive(tabId);
  })();
  new MutationObserver(() => scheduleCheck()).observe(document.body, { subtree: true, childList: true, characterData: true });
  document.addEventListener('visibilitychange', () => {
    dbg(document.hidden ? 'page-hidden' : 'page-visible');
    if (!document.hidden) {
      if (!kaWs || kaWs.readyState !== WebSocket.OPEN) restartKeepAlive();
      pullUndelivered();
      scheduleCheck(0);
    }
  });
  setInterval(() => scheduleCheck(), 2500);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'result-frame') {
      dbg('result-frame-received', String(msg.hash8) + (pendingFillHandlers.has(msg.hash8) ? '' : ':no-handler'));
      const h = pendingFillHandlers.get(msg.hash8);
      if (h) { pendingFillHandlers.delete(msg.hash8); h(msg.payload); }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'sweep') {
      sendResponse({ ok: true, tabId: myTabId, host: location.host });
      return;
    }
    if (msg.type === 'drive') {
      sendResponse({ ok: true, out: driveCheck('message') });
      return;
    }
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
    if (changes.token || changes.serverUrl) restartKeepAlive();
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
