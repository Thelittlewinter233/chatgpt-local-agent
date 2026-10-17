let ws = null;
let authed = false;
let helloTimer = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let backoffIdx = 0;
let msgCounter = 0;
let lastAckId = 0;
let contentTabId = null;
let leaderTabId = null;
let rotateWaiter = null;
let policyWaiter = null;
const pending = new Map();
const BACKOFF = [1000, 2000, 5000, 10000, 30000];

const getStore = keys => chrome.storage.local.get(keys);
const BADGE = {
  connected: { text: '✓', color: '#10b981' },
  connecting: { text: '…', color: '#eab308' },
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

function send(frame) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
}

function clearTimers() {
  if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function scheduleReconnect() {
  authed = false;
  setStatus('disconnected');
  if (reconnectTimer) return;
  const delay = BACKOFF[Math.min(backoffIdx, BACKOFF.length - 1)] + Math.floor(Math.random() * 400);
  backoffIdx += 1;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function closeSocket() {
  if (!ws) return;
  const socket = ws;
  ws = null;
  socket.onclose = null;
  socket.onmessage = null;
  try { socket.close(); } catch { }
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const { url, token } = await (async () => {
    const o = await getStore(['serverUrl', 'token']);
    return { url: o.serverUrl || 'ws://127.0.0.1:9752', token: o.token || '' };
  })();
  if (!token) { setStatus('unpaired', 'popup 中尚未保存 token'); return; }
  setStatus('connecting');
  try { ws = new WebSocket(url); }
  catch (e) { setStatus('disconnected', String(e && e.message || e)); scheduleReconnect(); return; }
  ws.onopen = () => {
    helloTimer = setTimeout(() => { try { ws && ws.close(); } catch { } }, 6000);
    send({ type: 'hello', token, v: 1 });
  };
  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handleFrame(m);
  };
  ws.onclose = () => { ws = null; clearTimers(); scheduleReconnect(); };
  ws.onerror = () => { };
}

async function targetTabId() {
  if (leaderTabId != null) return leaderTabId;
  const o = await getStore('leaderTabId');
  if (o.leaderTabId != null) { leaderTabId = o.leaderTabId; return leaderTabId; }
  if (contentTabId != null) return contentTabId;
  const o2 = await getStore('contentTabId');
  return o2.contentTabId != null ? o2.contentTabId : null;
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

async function handleFrame(m) {
  if (m.type === 'hello_ok') {
    authed = true;
    backoffIdx = 0;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    setStatus('connected');
    heartbeatTimer = setInterval(() => send({ type: 'ping' }), 20000);
    const o = await getStore('lastAckId');
    lastAckId = o.lastAckId || 0;
    send({ type: 'resume', lastAckId });
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
      const preferred = [];
      const active = await activeTabId();
      if (active != null) preferred.push(active);
      const leader = await targetTabId();
      if (leader != null && !preferred.includes(leader)) preferred.push(leader);
      for (const id of preferred) {
        try {
          await chrome.tabs.sendMessage(id, preview);
          return;
        } catch { }
      }
      const ids = await broadcastTabs();
      for (const id of ids) {
        if (preferred.includes(id)) continue;
        try {
          await chrome.tabs.sendMessage(id, preview);
          return;
        } catch { }
      }
      console.log('[AgentBridge] confirm required but no content-script tab reachable');
    })();
    return;
  }
  if (m.type === 'ack') {
    if (Number(m.msgId) > lastAckId) { lastAckId = Number(m.msgId); chrome.storage.local.set({ lastAckId }); }
    return;
  }
  if (m.type === 'result') {
    if (Number(m.msgId) > lastAckId) { lastAckId = Number(m.msgId); chrome.storage.local.set({ lastAckId }); }
    const waiter = pending.get(m.msgId);
    if (waiter) { pending.delete(m.msgId); waiter(m.payload); }
    else if (m.hash8) {
      const o = await getStore('pend');
      const pend = o.pend || {};
      pend[m.hash8] = { payload: m.payload, at: Date.now() };
      const keys = Object.keys(pend);
      if (keys.length > 20) {
        keys.sort((a, b) => pend[a].at - pend[b].at);
        for (const k of keys.slice(0, keys.length - 20)) delete pend[k];
      }
      await chrome.storage.local.set({ pend });
    }
    send({ type: 'ack', msgId: m.msgId });
    return;
  }
}

function sendCmd(msg) {
  return new Promise(async resolve => {
    const deadline = Date.now() + 10000;
    while (!authed && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));
    if (!authed) { resolve({ ok: false, error: 'server offline' }); return; }
    const msgId = ++msgCounter;
    const timer = setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        resolve({ ok: false, error: 'agent server response timeout (120s)' });
      }
    }, 120000);
    pending.set(msgId, payload => { clearTimeout(timer); resolve(payload); });
    send({ type: 'cmd', msgId, hash8: msg.hash8, action: msg.action, args: msg.args || {} });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'content-hello') {
    contentTabId = sender.tab ? sender.tab.id : null;
    if (contentTabId != null) chrome.storage.local.set({ contentTabId });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'am-i-leader') {
    (async () => {
      let id = leaderTabId;
      if (id == null) {
        const o = await getStore('leaderTabId');
        id = o.leaderTabId != null ? o.leaderTabId : null;
      }
      if (id != null) {
        try { await chrome.tabs.get(id); }
        catch {
          id = null;
          leaderTabId = null;
          await chrome.storage.local.set({ leaderTabId: null });
        }
      }
      if (id == null && sender.tab) {
        id = sender.tab.id;
        leaderTabId = id;
        await chrome.storage.local.set({ leaderTabId: id });
      }
      sendResponse({ leader: !!(sender.tab && sender.tab.id === id) });
    })();
    return true;
  }
  if (msg.type === 'claim-leader') {
    (async () => {
      if (sender.tab) {
        leaderTabId = sender.tab.id;
        await chrome.storage.local.set({ leaderTabId });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'test-confirm') {
    (async () => {
      const tabId = await targetTabId();
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: 'confirm-request', confirmId: 'test', preview: '[仅 UI 测试] 真实场景会显示待执行的命令' }).catch(() => { });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '未找到 chatgpt.com 标签页，请先打开并刷新' });
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
      if (!authed) { sendResponse({ ok: false, error: 'not connected' }); return; }
      const token = await new Promise(resolve => {
        rotateWaiter = resolve;
        send({ type: 'rotate-token' });
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
      if (!authed) { sendResponse({ ok: false, error: 'not connected' }); return; }
      const policy = await new Promise(resolve => {
        policyWaiter = resolve;
        send({ type: 'get-policy' });
        setTimeout(() => { if (policyWaiter === resolve) { policyWaiter = null; resolve(null); } }, 8000);
      });
      if (!policy) { sendResponse({ ok: false, error: 'policy query timeout' }); return; }
      sendResponse({ ok: true, policy });
    })();
    return true;
  }
  if (msg.type === 'set-policy') {
    (async () => {
      if (!authed) { sendResponse({ ok: false, error: 'not connected' }); return; }
      const policy = await new Promise(resolve => {
        policyWaiter = resolve;
        send({ type: 'set-policy', patch: msg.patch || {} });
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
      const fallback = await targetTabId();
      if (fallback != null && !candidates.includes(fallback)) candidates.push(fallback);
      for (const tabId of candidates) {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'inject-prompt' });
          sendResponse(r && r.ok ? r : { ok: false, error: (r && r.error) || 'content script rejected injection' });
          return;
        } catch { }
      }
      sendResponse({ ok: false, error: '当前激活页面没有 AgentBridge 脚本（请确认已打开支持的 AI 站点并刷新页面）' });
    })();
    return true;
  }
  if (msg.type === 'health-check-proxy') {
    (async () => {
      const tabId = await targetTabId();
      if (tabId == null) { sendResponse({ ok: false, error: '未找到任务标签页' }); return; }
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'health-check' });
        sendResponse({ ok: true, tabId, data: r });
      } catch (e) {
        sendResponse({ ok: false, error: '任务标签页未注入 content script（请刷新页面）: ' + (e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'confirm-resolve') {
    send({ type: 'confirm-resolve', confirmId: msg.confirmId, approved: msg.approved });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'agent-cmd') {
    sendCmd(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'ping') {
    (async () => {
      const deadline = Date.now() + 8000;
      while (!authed && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));
      if (!authed) { sendResponse({ ok: false, error: 'not connected (check server and token)' }); return; }
      sendCmd({ action: 'computer_info', args: {} }).then(sendResponse);
    })();
    return true;
  }
  if (msg.type === 'wake') {
    connect();
    sendResponse({ ok: true });
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.token || changes.serverUrl) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    closeSocket();
    clearTimers();
    authed = false;
    backoffIdx = 0;
    connect();
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (leaderTabId === tabId) {
    leaderTabId = null;
    await chrome.storage.local.set({ leaderTabId: null });
  } else {
    const o = await getStore('leaderTabId');
    if (o.leaderTabId === tabId) await chrome.storage.local.set({ leaderTabId: null });
  }
  if (contentTabId === tabId) contentTabId = null;
});

connect();
