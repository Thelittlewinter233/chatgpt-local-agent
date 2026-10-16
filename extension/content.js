const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj)
};

let opts = { paused: false, autoSend: true };
let guard = { step: 0, failStreak: 0, lastHash8: '' };
let seen = [];
let processing = false;
let checkTimer = null;
let lastDbgKey = '';

async function loadState() {
  const o = await store.get(['ab_opts', 'ab_guard', 'ab_seen']);
  opts = Object.assign({ paused: false, autoSend: true }, o.ab_opts || {});
  guard = Object.assign({ step: 0, failStreak: 0, lastHash8: '' }, o.ab_guard || {});
  seen = o.ab_seen || [];
}

const saveState = () => store.set({ ab_opts: opts, ab_guard: guard, ab_seen: seen.slice(-300) });
const markSeen = hash8 => { seen.push(hash8); if (seen.length > 500) seen = seen.slice(-300); saveState(); };

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
const norm = s => String(s || '').replace(/\s+/g, '');
const inputHasPending = el => norm((el.textContent || '') + (el.value || '')).includes('agent-result');

function isGenerating() {
  return !!(q(AGENT_SELECTORS.stop) || q(AGENT_SELECTORS.stopAlt));
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
  return latest ? latest.body : null;
}

function scheduleCheck(delay = 350) {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(checkCycle, delay);
}

async function checkCycle() {
  try {
    if (processing || opts.paused) return;
    if (isGenerating()) { dbg('generating'); return; }
    const raw1 = findLatestAgentBlock();
    if (!raw1) { dbg('no-agent-block-on-page'); return; }
    const normalized = raw1.trim();
    const hash8 = (await sha1(normalized)).slice(0, 8);
    if (seen.includes(hash8)) { dbg('block-already-seen', hash8); return; }
    await sleep(600);
    if (isGenerating()) return;
    const raw2 = findLatestAgentBlock();
    if (!raw2 || raw2.trim() !== normalized) { dbg('stability-wait'); scheduleCheck(1000); return; }
    dbg('agent-block-detected', normalized.slice(0, 80));
    processing = true;
    try { await handleBlock(normalized, hash8); }
    finally { processing = false; }
  } catch (e) {
    dbg('check-error', String((e && e.stack) || e));
    toast('AgentBridge 检测出错：' + String((e && e.message) || e));
  }
}

async function handleBlock(raw, hash8) {
  let cmd;
  try { cmd = JSON.parse(raw); }
  catch { await respond(hash8, { ok: false, error: 'invalid agent json' }); return; }
  if (!cmd || typeof cmd.action !== 'string') { await respond(hash8, { ok: false, error: 'agent block missing action' }); return; }
  if (cmd.action === 'done') {
    guard = { step: 0, failStreak: 0, lastHash8: '' };
    markSeen(hash8);
    saveState();
    toast('AgentBridge: 任务完成，计数已重置');
    return;
  }
  const o = await store.get('pend');
  const pend = o.pend || {};
  if (pend[hash8]) {
    const payload = pend[hash8].payload;
    delete pend[hash8];
    await store.set({ pend });
    await deliver(hash8, payload);
    return;
  }
  if (guard.step >= 15) { await respond(hash8, { ok: false, denied: 'single-task step limit (15) reached; press New Task in the popup to continue' }); return; }
  if (guard.failStreak >= 3) { await respond(hash8, { ok: false, denied: 'circuit breaker: 3 consecutive failures; check the agent server, then press New Task' }); return; }
  if (guard.lastHash8 && guard.lastHash8 === hash8) { await respond(hash8, { ok: false, denied: 'same command repeated; possible loop' }); return; }
  markSeen(hash8);
  toast('AgentBridge: 执行 ' + cmd.action + ' …');
  let payload;
  try {
    payload = await chrome.runtime.sendMessage({ type: 'agent-cmd', hash8, action: cmd.action, args: cmd.args || {} });
  } catch (e) {
    payload = { ok: false, error: 'bridge unavailable: ' + ((e && e.message) || e) };
  }
  dbg('cmd-done', cmd.action + ' -> ' + JSON.stringify(payload).slice(0, 120));
  await deliver(hash8, payload);
}

async function deliver(hash8, payload) {
  guard.step += 1;
  guard.failStreak = payload && payload.ok ? 0 : guard.failStreak + 1;
  guard.lastHash8 = hash8;
  await saveState();
  await respond(hash8, payload);
}

async function respond(hash8, payload) {
  const body = JSON.stringify({ for: hash8, ...payload });
  const trimmed = body.length > 8000 ? body.slice(0, 8000) + '...[truncated]' : body;
  const filled = await fillInput('```agent-result\n' + trimmed + '\n```');
  if (!filled) { dbg('fill-failed'); toast('AgentBridge: 回填失败（找不到输入框），请手动把结果发给 AI'); return; }
  const o = await store.get('ab_opts');
  const current = Object.assign({ paused: false, autoSend: true }, o.ab_opts || {});
  if (current.paused) { highlight(true); toast('AgentBridge: 已填入未发送（监听已暂停）'); return; }
  if (current.autoSend === false) { highlight(true); toast('AgentBridge: 已填入未发送（自动发送已关闭）'); return; }
  const sent = await sendCurrent();
  if (!sent) { highlight(true); toast('AgentBridge: 已填入未发送（发送失败），请手动按回车发送'); }
  else highlight(false);
}

async function fillInput(text) {
  const el = q(AGENT_SELECTORS.input) || q(AGENT_SELECTORS.inputAlt);
  if (!el) return false;
  el.focus();
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch { }
  await sleep(250);
  if (norm((el.textContent || '') + (el.value || '')).includes(norm(text).slice(0, 30))) return true;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.addRange(range);
    document.execCommand('insertText', false, text);
  } catch { }
  await sleep(250);
  if (norm((el.textContent || '') + (el.value || '')).includes(norm(text).slice(0, 30))) return true;
  if (el.tagName === 'TEXTAREA') {
    el.value = (el.value || '') + text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
}

async function sendCurrent() {
  const el = q(AGENT_SELECTORS.input) || q(AGENT_SELECTORS.inputAlt);
  if (!el) return false;
  for (let i = 0; i < 3; i++) {
    const btn = q(AGENT_SELECTORS.send) || q(AGENT_SELECTORS.sendAlt) || q(AGENT_SELECTORS.sendCn);
    if (btn && !btn.disabled) {
      btn.click();
      await sleep(500);
      if (!inputHasPending(el)) { dbg('send-ok', 'button click'); return true; }
    }
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(600);
    if (!inputHasPending(el)) { dbg('send-ok', 'enter key'); return true; }
    await sleep(400);
  }
  dbg('send-failed');
  return false;
}

function highlight(on) {
  const el = q(AGENT_SELECTORS.input) || q(AGENT_SELECTORS.inputAlt);
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
  let left = 60;
  timer.textContent = left + 's 后自动拒绝';
  const tick = setInterval(() => {
    left -= 1;
    if (left > 0) timer.textContent = left + 's 后自动拒绝';
  }, 1000);
  const resolve = approved => {
    clearInterval(tick);
    removeConfirmBar();
    try { chrome.runtime.sendMessage({ type: 'confirm-resolve', confirmId, approved }).catch(() => { }); } catch { }
  };
  yes.addEventListener('click', () => resolve(true));
  no.addEventListener('click', () => resolve(false));
  row.append(yes, no, timer);
  bar.append(label, code, row);
  document.body.appendChild(bar);
}

async function init() {
  await loadState();
  try { chrome.runtime.sendMessage({ type: 'content-hello' }).catch(() => { }); } catch { }
  new MutationObserver(() => scheduleCheck()).observe(document.body, { subtree: true, childList: true, characterData: true });
  setInterval(() => scheduleCheck(), 2500);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'confirm-request') {
      showConfirmBar(msg.confirmId, msg.preview);
      sendResponse({ ok: true });
      return;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ab_opts) opts = Object.assign({ paused: false, autoSend: true }, changes.ab_opts.newValue || {});
    if (changes.ab_seen) seen = changes.ab_seen.newValue || [];
    if (changes.ab_guard) guard = Object.assign({ step: 0, failStreak: 0, lastHash8: '' }, changes.ab_guard.newValue || {});
    if (changes.resetGuard) {
      guard = { step: 0, failStreak: 0, lastHash8: '' };
      seen = [];
      saveState();
      toast('AgentBridge: 新任务，计数已重置');
    }
  });
  dbg('content-script-active', location.host);
  scheduleCheck(500);
}

init();
