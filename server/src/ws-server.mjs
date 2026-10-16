import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAX_CACHE = 100;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function startWsServer(config, dispatch, log) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const blocked = new Map();
  const cache = new Map();
  const pendingConfirms = new Map();
  let confirmCounter = 0;

  const send = (ws, frame) => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); };
  const trimCache = () => { while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); };

  const failConfirmWaiters = () => {
    for (const entry of pendingConfirms.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    pendingConfirms.clear();
  };

  const makeCtx = ws => ({
    requestConfirm: preview => new Promise(resolve => {
      const confirmId = ++confirmCounter;
      const entry = {
        resolve: approved => { log(`confirm #${confirmId} -> ${approved ? 'approved' : 'rejected'}`); resolve(approved); },
        timer: setTimeout(() => { if (pendingConfirms.delete(confirmId)) { log(`confirm #${confirmId} -> timeout`); resolve(false); } }, 60000)
      };
      pendingConfirms.set(confirmId, entry);
      send(ws, { type: 'confirm-required', confirmId, preview });
    })
  });

  const fail = (ws, ip, reason) => {
    const entry = blocked.get(ip) || { fails: 0, until: 0 };
    entry.fails += 1;
    if (entry.fails >= 3) { entry.until = Date.now() + 60000; entry.fails = 0; }
    blocked.set(ip, entry);
    log(`auth failed from ${ip}: ${reason}`);
    try { ws.close(4401, reason); } catch { ws.terminate(); }
  };

  server.on('upgrade', (req, socket, head) => {
    const ip = socket.remoteAddress || '?';
    const entry = blocked.get(ip);
    if (entry && entry.until > Date.now()) { socket.destroy(); return; }
    const origin = req.headers.origin || '';
    if (!origin.startsWith('chrome-extension://')) { log(`rejected origin: ${origin || '(none)'}`); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, ip));
  });

  wss.on('connection', (ws, req, ip) => {
    let authed = false;
    let tail = Promise.resolve();
    const helloTimer = setTimeout(() => { if (!authed) fail(ws, ip, 'hello timeout'); }, 5000);
    log(`extension connected from ${ip}`);

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!authed) {
        if (m.type !== 'hello' || typeof m.token !== 'string') return fail(ws, ip, 'bad hello');
        if (!safeEqual(m.token, config.token)) return fail(ws, ip, 'bad token');
        authed = true;
        clearTimeout(helloTimer);
        log('extension authenticated');
        send(ws, { type: 'hello_ok' });
        return;
      }
      if (m.type === 'ping') return send(ws, { type: 'pong' });
      if (m.type === 'ack') { cache.delete(m.msgId); return; }
      if (m.type === 'confirm-resolve') {
        const id = Number(m.confirmId);
        const entry = pendingConfirms.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          pendingConfirms.delete(id);
          entry.resolve(!!m.approved);
        }
        return;
      }
      if (m.type === 'resume') {
        const last = Number(m.lastAckId) || 0;
        for (const [id, frame] of cache) if (id > last) send(ws, frame);
        return;
      }
      if (m.type !== 'cmd') return;
      if (!Number.isInteger(m.msgId) || typeof m.action !== 'string') return;
      tail = tail.then(async () => {
        const started = Date.now();
        let payload;
        try {
          const data = await dispatch(m.action, m.args || {}, makeCtx(ws));
          payload = { ok: true, data };
        } catch (error) {
          payload = error && error.denied
            ? { ok: false, denied: String(error.message) }
            : { ok: false, error: String((error && error.message) || error) };
        }
        const frame = { type: 'result', msgId: m.msgId, hash8: m.hash8, payload };
        cache.set(m.msgId, frame);
        trimCache();
        send(ws, frame);
        log(`cmd #${m.msgId} ${m.action} -> ${payload.ok ? 'ok' : payload.denied ? 'denied' : 'error'} (${Date.now() - started}ms)`);
      }).catch(() => { });
    });

    ws.on('close', () => { clearTimeout(helloTimer); failConfirmWaiters(); log('extension disconnected'); });
    ws.on('error', () => { });
  });

  server.listen(config.port, '127.0.0.1', () => log(`ws server listening on ws://127.0.0.1:${config.port}`));
  return server;
}
