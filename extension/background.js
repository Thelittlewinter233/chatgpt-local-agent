if (typeof importScripts === 'function') importScripts('sites.js');

const tabSessions = new Map();
let globalMsgCounter = 0;
let rotateWaiter = null;
let policyWaiter = null;
const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const undeliveredResults = new Map();
const kaMainInjected = new Map();
const confirmOwners = new Map();
const PRIVILEGED = new Set(['set-policy', 'rotate-token', 'add-site-domain', 'probe-site-domains']);
let driveLogQueue = Promise.resolve();

function driveLog(name, tabId, out) {
  const entry = { ts: Date.now(), name: String(name || ''), tabId: tabId == null ? null : tabId, out: String(out || '') };
  driveLogQueue = driveLogQueue.then(async () => {
    const stored = await chrome.storage.local.get('ab_drive_log').catch(() => ({}));
    const rows = Array.isArray(stored.ab_drive_log) ? stored.ab_drive_log : [];
    await chrome.storage.local.set({ ab_drive_log: [...rows, entry].slice(-50) });
  }).catch(e => console.warn('[AgentBridge][drive-log]', String(e && e.message || e)));
  return driveLogQueue;
}

function forgetTabConfirms(tabId) {
  for (const [id, owner] of confirmOwners) if (owner === tabId) confirmOwners.delete(id);
}

function mainKeepAlive(url) {
  if (window.__abKaMainUrl === url) return;
  window.__abKaMainUrl = url;
  try {
    if (window.__abKaMainWs) { window.__abKaMainWs.onclose = null; window.__abKaMainWs.onerror = null; window.__abKaMainWs.close(); }
    if (window.__abKaMainTimer) clearInterval(window.__abKaMainTimer);
    if (window.__abKaMainRetry) clearTimeout(window.__abKaMainRetry);
  } catch (e) { }
  const backoff = [1000, 5000, 30000];
  let idx = 0;
  let tries = 0;
  const notify = state => { try { window.dispatchEvent(new CustomEvent('ab-main-ka-' + state)); } catch (e) { } };
  const schedule = () => {
    if (window.__abKaMainUrl !== url) return;
    if (window.__abKaMainRetry) clearTimeout(window.__abKaMainRetry);
    const delay = backoff[Math.min(idx, backoff.length - 1)] + Math.floor(Math.random() * 400);
    idx += 1;
    window.__abKaMainRetry = setTimeout(connect, delay);
  };
  const connect = () => {
    if (window.__abKaMainUrl !== url) return;
    if (tries >= 20) { notify('blocked'); return; }
    tries += 1;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { notify('blocked'); schedule(); return; }
    window.__abKaMainWs = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      idx = 0;
      tries = 0;
      notify('ok');
      if (window.__abKaMainTimer) clearInterval(window.__abKaMainTimer);
      window.__abKaMainTimer = setInterval(() => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { } }, 20000);
    };
    ws.onclose = () => {
      if (window.__abKaMainTimer) { clearInterval(window.__abKaMainTimer); window.__abKaMainTimer = null; }
      if (window.__abKaMainWs === ws) window.__abKaMainWs = null;
      notify(opened ? 'closed' : 'blocked');
      schedule();
    };
    ws.onerror = () => { };
  };
  connect();
}

async function kaMainUrl() {
  const o = await getStore(['serverUrl', 'token']);
  const base = o.serverUrl || 'ws://127.0.0.1:9752';
  const token = o.token || '';
  if (!token) return null;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const u = new URL(base);
    u.searchParams.set('ka', hex);
    return u.toString();
  } catch (e) { return null; }
}

async function injectMainKeepAlive(tabId) {
  if (tabId == null || !chrome.scripting || !chrome.scripting.executeScript) return;
  const url = await kaMainUrl();
  if (!url) return;
  if (kaMainInjected.get(tabId) === url) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: mainKeepAlive, args: [url] });
    kaMainInjected.set(tabId, url);
  } catch (e) { }
}

const getStore = keys => chrome.storage.local.get(keys);
const BADGE = {
  connected: { text: '\u2713', color: '#10b981' },
  connecting: { text: '\u2026', color: '#eab308' },
  disconnected: { text: '!', color: '#ef4444' },
  unpaired: { text: '?', color: '#eab308' }
};

const setStatus = (status, error) => {
  chrome.storage.local.set({ wsStatus: status, wsError: error || '' });
  const m = BADGE[status] || { text: '', color: '#6b7280' };
  try {
    chrome.action.setBadgeText({ text: m.text });
    chrome.action.setBadgeBackgroundColor({ color: m.color });
  } catch { }
};

function sessionSend(s, frame) {
  if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(frame));
}

function clearSessionTimers(s) {
  if (s.helloTimer) { clearTimeout(s.helloTimer); s.helloTimer = null; }
  if (s.heartbeatTimer) { clearInterval(s.heartbeatTimer); s.heartbeatTimer = null; }
}

function swNote(stage, tabId, extra) {
  const rec = { stage, tabId: tabId == null ? null : tabId, extra: extra == null ? '' : String(extra), ts: Date.now() };
  console.log('[AgentBridge][sw]', stage, rec.tabId, rec.extra);
  try { chrome.storage.local.set({ ab_sw: rec }); } catch (e) { }
}

function ensureSession(tabId) {
  let s = tabSessions.get(tabId);
  if (!s) {
    s = { tabId, ws: null, authed: false, helloTimer: null, heartbeatTimer: null, reconnectTimer: null, backoffIdx: 0, msgCounter: 0, lastAckId: 0, pending: new Map(), sessionId: null };
    tabSessions.set(tabId, s);
  }
  return s;
}

function scheduleSessionReconnect(s) {
  s.authed = false;
  if (tabSessions.size <= 1) setStatus('disconnected');
  if (s.reconnectTimer) { swNote('reconnect-already-pending', s.tabId); return; }
  const delay = BACKOFF[Math.min(s.backoffIdx, BACKOFF.length - 1)] + Math.floor(Math.random() * 400);
  s.backoffIdx += 1;
  swNote('reconnect-scheduled', s.tabId, delay + 'ms idx=' + s.backoffIdx);
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    swNote('reconnect-fire', s.tabId);
    connectSession(s.tabId);
  }, delay);
}

function closeSessionSocket(s) {
  if (!s.ws) return;
  const socket = s.ws;
  s.ws = null;
  socket.onclose = null;
  socket.onmessage = null;
  try { socket.close(); } catch { }
}

async function connectSession(tabId) {
  const s = ensureSession(tabId);
  if (s.ws && (s.ws.readyState === 0 || s.ws.readyState === 1)) return;
  const { url, token } = await (async () => {
    const o = await getStore(['serverUrl', 'token']);
    return { url: o.serverUrl || 'ws://127.0.0.1:9752', token: o.token || '' };
  })();
  if (!token) { swNote('connect-no-token', tabId); setStatus('unpaired', 'popup \u4e2d\u5c1a\u672a\u4fdd\u5b58 token'); return; }
  if (tabSessions.size <= 1) setStatus('connecting');
  try { s.ws = new WebSocket(url); }
  catch (e) {
    swNote('connect-threw', tabId, e && e.message || e);
    setStatus('disconnected', String(e && e.message || e));
    scheduleSessionReconnect(s);
    return;
  }
  s.ws.onopen = () => {
    s.helloTimer = setTimeout(() => { try { s.ws && s.ws.close(); } catch { } }, 6000);
    sessionSend(s, { type: 'hello', token, v: 1, sessionId: 'tab-' + tabId + '-' + Date.now() });
  };
  s.ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handleFrame(m, s);
  };
  s.ws.onclose = ev => {
    s.ws = null;
    clearSessionTimers(s);
    swNote('session-closed', tabId, ev && ev.code != null ? 'code=' + ev.code : '');
    scheduleSessionReconnect(s);
  };
  s.ws.onerror = () => { };
}


async function activeTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length && tabs[0].id != null) return tabs[0].id;
  } catch { }
  return null;
}

async function broadcastTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => t.id).filter(id => id != null);
  } catch { }
  return [];
}

let protocolCache = null;

async function getProtocolText() {
  if (protocolCache) return protocolCache;
  const r = await fetch(chrome.runtime.getURL('assets/chat-prompt.txt'));
  protocolCache = await r.text();
  return protocolCache;
}

async function handleFrame(m, s) {
  if (m.type === 'hello_ok') {
    s.authed = true;
    s.backoffIdx = 0;
    s.sessionId = m.sessionId || s.sessionId;
    swNote('session-authed', s.tabId, s.sessionId || '');
    if (s.helloTimer) { clearTimeout(s.helloTimer); s.helloTimer = null; }
    setStatus('connected');
    s.heartbeatTimer = setInterval(() => sessionSend(s, { type: 'ping' }), 20000);
    const storageKey = 'lastAckId_' + s.tabId;
    const o = await getStore(storageKey);
    s.lastAckId = o[storageKey] || 0;
    sessionSend(s, { type: 'resume', lastAckId: s.lastAckId });
    return;
  }
  if (m.type === 'pong') return;
  if (m.type === 'policy-updated' || m.type === 'policy') {
    if (policyWaiter) {
      const r = policyWaiter;
      policyWaiter = null;
      r(m.policy || {});
    }
    return;
  }
  if (m.type === 'token-rotated') {
    if (rotateWaiter) {
      const r = rotateWaiter;
      rotateWaiter = null;
      r(m.token);
    }
    return;
  }
  if (m.type === 'rotate-failed') {
    if (rotateWaiter) {
      const r = rotateWaiter;
      rotateWaiter = null;
      r(null);
    }
    return;
  }
  if (m.type === 'confirm-required') {
    (async () => {
      const preview = { type: 'confirm-request', confirmId: m.confirmId, preview: m.preview };
      if (s.tabId != null) {
        confirmOwners.set(Number(m.confirmId), s.tabId);
        if (confirmOwners.size > 50) confirmOwners.delete(confirmOwners.keys().next().value);
        try {
          await chrome.tabs.sendMessage(s.tabId, preview);
          return;
        } catch { }
        await new Promise(r => setTimeout(r, 1500));
        try {
          await chrome.tabs.sendMessage(s.tabId, preview);
          return;
        } catch { }
      }
      console.log('[AgentBridge] confirm required but tab unreachable:', s.tabId);
    })();
    return;
  }
  if (m.type === 'ack') {
    if (Number(m.msgId) > s.lastAckId) { s.lastAckId = Number(m.msgId); chrome.storage.local.set({ ['lastAckId_' + s.tabId]: s.lastAckId }); }
    return;
  }
  if (m.type === 'result') {
    if (Number(m.msgId) > s.lastAckId) { s.lastAckId = Number(m.msgId); chrome.storage.local.set({ ['lastAckId_' + s.tabId]: s.lastAckId }); }
    const waiter = s.pending.get(m.msgId);
    if (waiter) { s.pending.delete(m.msgId); waiter(m.payload); }
    else if (m.hash8) {
      const o = await getStore('pend');
      const pend = o.pend || {};
      pend[m.hash8] = { payload: m.payload, at: Date.now(), tabId: s.tabId };
      const keys = Object.keys(pend);
      if (keys.length > 20) {
        keys.sort((a, b) => pend[a].at - pend[b].at);
        for (const k of keys.slice(0, keys.length - 20)) delete pend[k];
      }
      await chrome.storage.local.set({ pend });
    }
    sessionSend(s, { type: 'ack', msgId: m.msgId });
    if (s.tabId != null && m.hash8) {
      const frame = { type: 'result-frame', hash8: m.hash8, payload: m.payload, msgId: m.msgId };
      try { await chrome.tabs.sendMessage(s.tabId, frame); }
      catch (e) {
        let list = undeliveredResults.get(s.tabId);
        if (!list) { list = []; undeliveredResults.set(s.tabId, list); }
        list.push(frame);
        if (list.length > 20) list.splice(0, list.length - 20);
      }
    }
    return;
  }
}

function sendCmd(msg, tabId) {
  return new Promise(async resolve => {
    const deadline = Date.now() + 10000;
    let target;
    if (tabId != null) {
      ensureSession(tabId);
      connectSession(tabId);
      target = tabSessions.get(tabId) || null;
    } else {
      target = [...tabSessions.values()].find(x => x.authed) || null;
    }
    while (target && !target.authed && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));
    if (!target || !target.authed) { resolve({ ok: false, error: 'server offline' }); return; }
    const msgId = ++globalMsgCounter;
    const timer = setTimeout(() => {
      if (target.pending.has(msgId)) {
        target.pending.delete(msgId);
        resolve({ ok: false, error: 'agent server response timeout (300s)' });
      }
    }, 300000);
    target.pending.set(msgId, payload => { clearTimeout(timer); resolve(payload); });
    sessionSend(target, { type: 'cmd', msgId, hash8: msg.hash8, action: msg.action, args: msg.args || {} });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId = sender.tab ? sender.tab.id : null;
  if (senderTabId != null && PRIVILEGED.has(msg.type)) {
    sendResponse({ ok: false, error: 'not allowed from page context' });
    return;
  }
  if (msg.type === 'content-hello') {
    if (senderTabId != null) {
      ensureSession(senderTabId);
      connectSession(senderTabId);
      injectMainKeepAlive(senderTabId);
    }
    sendResponse({ ok: true, tabId: senderTabId });
    return;
  }
  if (msg.type === 'pull-results') {
    const frames = senderTabId != null ? (undeliveredResults.get(senderTabId) || []) : [];
    if (senderTabId != null) undeliveredResults.delete(senderTabId);
    sendResponse({ ok: true, frames });
    return;
  }
  if (msg.type === 'mini-state') {
    (async () => {
      try {
        const tabId = await activeTabId();
        if (tabId == null) { sendResponse({ ok: false, error: 'no-active-tab' }); return; }
        const tab = await chrome.tabs.get(tabId);
        const win = await chrome.windows.get(tab.windowId);
        const patterns = [...staticMatches(), ...(await dynamicSiteMatches())];
        sendResponse({ ok: true, isAiSite: matchesRegisteredSite(tab.url, patterns), isMini: win.type === 'popup', tabId });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'mini-popout') {
    (async () => {
      try {
        const tabId = await activeTabId();
        if (tabId == null) { sendResponse({ ok: false, error: '\u672a\u627e\u5230\u6d3b\u52a8\u6807\u7b7e\u9875' }); return; }
        const tab = await chrome.tabs.get(tabId);
        const win = await chrome.windows.get(tab.windowId);
        if (win.type === 'popup') { await chrome.windows.update(win.id, { focused: true }); sendResponse({ ok: true, already: true }); return; }
        const patterns = [...staticMatches(), ...(await dynamicSiteMatches())];
        if (!matchesRegisteredSite(tab.url, patterns)) { sendResponse({ ok: false, error: '\u5f53\u524d\u6807\u7b7e\u4e0d\u662f\u5df2\u6ce8\u518c\u7684 AI \u7ad9\u70b9' }); return; }
        await chrome.windows.create({ tabId, type: 'popup', width: 480, height: 700, top: 40, left: 1100, focused: true });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'test-confirm') {
    (async () => {
      const tabId = await activeTabId();
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: 'confirm-request', confirmId: 'test', preview: '[\u4ec5 UI \u6d4b\u8bd5] \u771f\u5b9e\u573a\u666f\u4f1a\u663e\u793a\u5f85\u6267\u884c\u7684\u547d\u4ee4' }).catch(() => { });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '\u672a\u627e\u5230 chatgpt.com \u6807\u7b7e\u9875\uff0c\u8bf7\u5148\u6253\u5f00\u5e76\u5237\u65b0' });
      }
    })();
    return true;
  }
  if (msg.type === 'get-prompt') {
    getProtocolText().then(t => sendResponse({ ok: true, text: t })).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'rotate-token') {
    (async () => {
      const anyAuthed = [...tabSessions.values()].some(s => s.authed);
      if (!anyAuthed) { sendResponse({ ok: false, error: 'not connected' }); return; }
      const target = [...tabSessions.values()].find(s => s.authed);
      const token = await new Promise(resolve => {
        rotateWaiter = resolve;
        sessionSend(target, { type: 'rotate-token' });
        setTimeout(() => { if (rotateWaiter === resolve) { rotateWaiter = null; resolve(null); } }, 8000);
      });
      if (!token) { sendResponse({ ok: false, error: 'rotate timeout or refused' }); return; }
      await chrome.storage.local.set({ token });
      sendResponse({ ok: true, token });
    })();
    return true;
  }
  if (msg.type === 'get-policy') {
    (async () => {
      const target = [...tabSessions.values()].find(s => s.authed);
      if (!target) { sendResponse({ ok: false, error: 'not connected' }); return; }
      const policy = await new Promise(resolve => {
        policyWaiter = resolve;
        sessionSend(target, { type: 'get-policy' });
        setTimeout(() => { if (policyWaiter === resolve) { policyWaiter = null; resolve(null); } }, 8000);
      });
      if (!policy) { sendResponse({ ok: false, error: 'policy query timeout' }); return; }
      sendResponse({ ok: true, policy });
    })();
    return true;
  }
  if (msg.type === 'set-policy') {
    (async () => {
      const target = [...tabSessions.values()].find(s => s.authed);
      if (!target) { sendResponse({ ok: false, error: 'not connected' }); return; }
      const policy = await new Promise(resolve => {
        policyWaiter = resolve;
        sessionSend(target, { type: 'set-policy', patch: msg.patch || {} });
        setTimeout(() => { if (policyWaiter === resolve) { policyWaiter = null; resolve(null); } }, 8000);
      });
      if (!policy) { sendResponse({ ok: false, error: 'policy update timeout' }); return; }
      sendResponse({ ok: true, policy });
    })();
    return true;
  }
  if (msg.type === 'inject-prompt') {
    (async () => {
      const candidates = [];
      const active = await activeTabId();
      if (active != null) candidates.push(active);
      for (const tabId of candidates) {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'inject-prompt' });
          sendResponse(r && r.ok ? r : { ok: false, error: (r && r.error) || 'content script rejected injection' });
          return;
        } catch { }
      }
      sendResponse({ ok: false, error: '\u5f53\u524d\u6fc0\u6d3b\u9875\u9762\u6ca1\u6709 AgentBridge \u811a\u672c\uff08\u8bf7\u786e\u8ba4\u5df2\u6253\u5f00\u652f\u6301\u7684 AI \u7ad9\u70b9\u5e76\u5237\u65b0\u9875\u9762\uff09' });
    })();
    return true;
  }
  if (msg.type === 'health-check-proxy') {
    (async () => {
      const tabId = await activeTabId();
      if (tabId == null) { sendResponse({ ok: false, error: '\u672a\u627e\u5230\u6d3b\u52a8\u6807\u7b7e\u9875' }); return; }
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'health-check' });
        sendResponse({ ok: true, tabId, data: r });
      } catch (e) {
        sendResponse({ ok: false, error: '\u6d3b\u52a8\u6807\u7b7e\u9875\u672a\u6ce8\u5165 content script\uff08\u8bf7\u5237\u65b0\u9875\u9762\uff09: ' + (e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'confirm-resolve') {
    const confirmId = Number(msg.confirmId);
    const ownerTab = confirmOwners.get(confirmId);
    const tabId = ownerTab != null ? ownerTab : senderTabId;
    if (tabId != null) confirmOwners.delete(confirmId);
    const s = tabId != null ? tabSessions.get(tabId) : null;
    if (s && s.authed) sessionSend(s, { type: 'confirm-resolve', confirmId: msg.confirmId, approved: msg.approved });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'agent-cmd') {
    sendCmd(msg, senderTabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'ping') {
    (async () => {
      const deadline = Date.now() + 8000;
      while (![...tabSessions.values()].some(s => s.authed) && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));
      if (![...tabSessions.values()].some(s => s.authed)) { sendResponse({ ok: false, error: 'not connected (check server and token)' }); return; }
      sendCmd({ action: 'computer_info', args: {} }, senderTabId).then(sendResponse);
    })();
    return true;
  }
  if (msg.type === 'probe-site-domains') {
    probeSiteDomains().then(r => sendResponse({ ok: true, report: r })).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'add-site-domain') {
    addSiteDomain(msg.host).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'wake') {
    if (senderTabId != null) connectSession(senderTabId);
    else for (const [tid] of tabSessions) connectSession(tid);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'sweep-ack') {
    sendResponse({ ok: true });
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.token || changes.serverUrl) {
    kaMainInjected.clear();
    for (const [tid] of tabSessions) injectMainKeepAlive(tid);
    for (const [, s] of tabSessions) {
      if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
      closeSessionSocket(s);
      clearSessionTimers(s);
      s.authed = false;
      s.backoffIdx = 0;
      connectSession(s.tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const s = tabSessions.get(tabId);
  if (s) {
    closeSessionSocket(s);
    clearSessionTimers(s);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    tabSessions.delete(tabId);
  }
  forgetTabConfirms(tabId);
  kaMainInjected.delete(tabId);
  undeliveredResults.delete(tabId);
  try { await chrome.storage.local.remove(['ab_ka_' + tabId, 'ab_dbg_timeline_' + tabId]); } catch (e) { }
});

async function probeTab(tabId) {
  const ok = await Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'sweep' }).then(r => !!(r && r.ok)).catch(() => false),
    new Promise(r => setTimeout(() => r(false), 1500))
  ]);
  if (!ok) return false;
  ensureSession(tabId);
  connectSession(tabId);
  injectMainKeepAlive(tabId);
  return true;
}

async function sweepTabs() {
  let ids = [...tabSessions.keys()];
  if (!ids.length) {
    try { ids = (await chrome.tabs.query({})).map(t => t.id).filter(id => id != null); } catch { return; }
  }
  await Promise.all(ids.map(id => probeTab(id)));
}

const driveInFlight = new Set();

function driveHook() {
  try {
    if (typeof window.__abCheck === 'function') return String(window.__abCheck('execute-script'));
    return 'no-hook';
  } catch (e) { return 'hook-error:' + String(e && e.message || e); }
}

function driveNote(tabId, out) {
  console.log('[AgentBridge][drive]', tabId, out);
  try { chrome.storage.local.set({ ab_drive: { tabId, out: String(out), ts: Date.now() } }); } catch (e) { }
}

async function driveTab(tabId) {
  if (driveInFlight.has(tabId)) {
    await driveLog('ab-drive', tabId, 'in-flight');
    return 'in-flight';
  }
  driveInFlight.add(tabId);
  let out = 'no-session';
  try {
    if (!tabSessions.has(tabId)) {
      out = 'no-session';
      await driveLog('ab-drive', tabId, out);
      return out;
    }
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: driveHook });
      out = r && r[0] ? String(r[0].result) : 'no-result';
    } catch (e) { out = 'exec-error:' + String(e && e.message || e); }
    if (out === 'no-hook' || out === 'no-result' || out.indexOf('exec-error:') === 0) {
      try {
        const m = await chrome.tabs.sendMessage(tabId, { type: 'drive' });
        const fallback = 'msg:' + String((m && m.out) || ((m && m.ok) ? 'ok' : 'none'));
        out = out.indexOf('exec-error:') === 0 ? out + ';fallback=' + fallback : fallback;
      } catch (e) {
        out = out.indexOf('exec-error:') === 0
          ? out + ';fallback-error:' + String(e && e.message || e)
          : 'exec-error:' + String(e && e.message || e);
      }
    }
    driveNote(tabId, out);
    await driveLog('ab-drive', tabId, out);
    return out;
  } catch (e) {
    out = 'exec-error:' + String(e && e.message || e);
    await driveLog('ab-drive', tabId, out);
    return out;
  } finally {
    driveInFlight.delete(tabId);
  }
}

function matchesRegisteredSite(url, patterns) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return patterns.some(pattern => {
    const m = String(pattern).match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/);
    if (!m) return false;
    if (m[1] !== '*' && m[1] !== parsed.protocol.slice(0, -1)) return false;
    const host = m[2];
    if (host !== '*' && host !== '<all_urls>' && host !== parsed.host && !(host.startsWith('*.') && (parsed.host === host.slice(2) || parsed.host.endsWith('.' + host.slice(2))))) return false;
    const path = m[3].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + path + '$').test(parsed.pathname + parsed.search);
  });
}

async function driveHiddenTabs() {
  let ids = [...tabSessions.keys()].filter(id => {
    const s = tabSessions.get(id);
    return !!(s && s.authed);
  });
  if (!ids.length) {
    let tabs = [];
    let patterns = [];
    try {
      [tabs, patterns] = await Promise.all([chrome.tabs.query({}), dynamicSiteMatches()]);
      patterns = [...staticMatches(), ...patterns];
    } catch (e) {
      await driveLog('ab-drive', null, 'exec-error:' + String(e && e.message || e));
      return;
    }
    ids = tabs.filter(t => t.id != null && matchesRegisteredSite(t.url, patterns)).map(t => t.id);
    for (const id of ids) {
      const probed = await probeTab(id).catch(() => false);
      if (!probed) {
        ensureSession(id);
        connectSession(id);
        injectMainKeepAlive(id);
      }
    }
    if (!ids.length) await driveLog('ab-drive', null, 'no-session');
  }
  await Promise.all(ids.map(id => driveTab(id)));
}

if (chrome.alarms && chrome.alarms.create) {
  chrome.alarms.onAlarm.addListener(a => {
    if (!a) return;
    if (a.name === 'ab-sweep') {
      driveLog(a.name, null, 'fired');
      sweepTabs().catch(e => driveLog(a.name, null, 'exec-error:' + String(e && e.message || e)));
    }
    else if (a.name === 'ab-drive') {
      driveLog(a.name, null, 'fired');
      driveHiddenTabs().catch(e => driveLog(a.name, null, 'exec-error:' + String(e && e.message || e)));
    }
  });
  try {
    Promise.resolve(chrome.alarms.create('ab-sweep', { periodInMinutes: 1 }))
      .catch(e => driveLog('ab-sweep', null, 'exec-error:' + String(e && e.message || e)));
  } catch (e) { driveLog('ab-sweep', null, 'exec-error:' + String(e && e.message || e)); }
  try {
    Promise.resolve(chrome.alarms.create('ab-drive', { periodInMinutes: 0.5 }))
      .catch(e => driveLog('ab-drive', null, 'exec-error:' + String(e && e.message || e)));
  } catch (e) { driveLog('ab-drive', null, 'exec-error:' + String(e && e.message || e)); }
}

const staticMatches = () => (chrome.runtime.getManifest().content_scripts || []).flatMap(cs => cs.matches || []);

async function dynamicSiteMatches() {
  const staticMs = staticMatches();
  const dyn = [];
  for (const s of (typeof __AB_SITE_ENTRIES !== 'undefined' ? __AB_SITE_ENTRIES : [])) {
    try { dyn.push(new URL(s.entry).origin + '/*'); } catch { }
  }
  const o = await getStore('ab_extra_domains');
  for (const d of (o.ab_extra_domains || [])) {
    const h = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (/^[a-z0-9.-]+$/.test(h)) dyn.push('https://' + h + '/*');
  }
  return [...new Set(dyn)].filter(m => !staticMs.includes(m));
}

async function syncDynamicScripts() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  try {
    const matches = await dynamicSiteMatches();
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const cur = registered.find(s => s.id === 'ab-dynamic');
    const same = cur && JSON.stringify([...(cur.matches || [])].sort()) === JSON.stringify([...matches].sort());
    if (same) return;
    if (cur) await chrome.scripting.unregisterContentScripts({ ids: ['ab-dynamic'] });
    if (matches.length) {
      const cs = chrome.runtime.getManifest().content_scripts[0];
      await chrome.scripting.registerContentScripts({ id: 'ab-dynamic', matches, js: cs.js, runAt: 'document_idle', persistAcrossSessions: true });
    }
    console.log('[AgentBridge] dynamic content scripts synced:', matches.join(' '));
  } catch (e) {
    console.log('[AgentBridge] dynamic scripts sync failed:', e && e.message || e);
  }
}

function probeOne(entry) {
  return new Promise(resolve => {
    let tabId = null;
    let done = false;
    const timer = setTimeout(finish, 15000);
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    function finish() {
      if (done) return;
      done = true;
      cleanup();
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => { });
      resolve(null);
    }
    function grab() {
      chrome.tabs.get(tabId).then(t => {
        if (done) return;
        if (t.url && /^https:/i.test(t.url) && t.status === 'complete') {
          done = true;
          cleanup();
          chrome.tabs.remove(tabId).catch(() => { });
          try { resolve(new URL(t.url).hostname); } catch { resolve(null); }
        }
      }).catch(() => { });
    }
    function onUpdated(id, info) { if (id === tabId && info.status === 'complete') setTimeout(grab, 800); }
    function onRemoved(id) { if (id === tabId && !done) { done = true; cleanup(); resolve(null); } }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.create({ url: entry, active: false }).then(t => { tabId = t.id; }).catch(() => finish());
  });
}

async function probeSiteDomains() {
  const staticMs = staticMatches();
  const results = [];
  const added = [];
  for (const s of (typeof __AB_SITE_ENTRIES !== 'undefined' ? __AB_SITE_ENTRIES : [])) {
    let entryHost = '';
    try { entryHost = new URL(s.entry).hostname; } catch { }
    const finalHost = await probeOne(s.entry);
    let moved = false;
    if (finalHost && finalHost !== entryHost) {
      moved = !staticMs.includes('https://' + finalHost + '/*');
      const o = await getStore('ab_extra_domains');
      const extras = o.ab_extra_domains || [];
      if (!extras.includes(finalHost)) {
        extras.push(finalHost);
        await chrome.storage.local.set({ ab_extra_domains: extras });
        added.push(s.id + ' \u2192 ' + finalHost);
      }
    }
    results.push({ id: s.id, entry: entryHost, final: finalHost || entryHost + '\uff08\u63a2\u6d4b\u8d85\u65f6\uff09', moved });
  }
  await syncDynamicScripts();
  const report = { at: Date.now(), results, added };
  await chrome.storage.local.set({ ab_domain_probe: report });
  return report;
}

async function addSiteDomain(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return { ok: false, error: '\u57df\u540d\u683c\u5f0f\u65e0\u6548\uff1a' + host };
  const o = await getStore('ab_extra_domains');
  const extras = o.ab_extra_domains || [];
  if (!extras.includes(h)) {
    extras.push(h);
    await chrome.storage.local.set({ ab_extra_domains: extras });
  }
  await syncDynamicScripts();
  return { ok: true, host: h };
}

syncDynamicScripts();

(async () => {
  swNote('sw-startup', null, 'sessions=' + tabSessions.size);
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(t => (t.id != null ? probeTab(t.id) : Promise.resolve(false))));
  } catch { }
})();
