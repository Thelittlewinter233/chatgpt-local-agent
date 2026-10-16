let ws = null;
let authed = false;
let helloTimer = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let backoffIdx = 0;
let msgCounter = 0;
let lastAckId = 0;
let contentTabId = null;
const pending = new Map();
const BACKOFF = [1000, 2000, 5000, 10000, 30000];

const getStore = keys => chrome.storage.local.get(keys);
const setStatus = (status, error) => chrome.storage.local.set({ wsStatus: status, wsError: error || '' });

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
  if (m.type === 'confirm-required') {
    if (contentTabId != null) {
      chrome.tabs.sendMessage(contentTabId, { type: 'confirm-request', confirmId: m.confirmId, preview: m.preview }).catch(() => { });
    }
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
    sendResponse({ ok: true });
    return;
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

connect();
