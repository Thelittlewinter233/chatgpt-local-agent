import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAX_CACHE_PER_SESSION = 100;
const REPLAY_MAX_AGE = 10 * 60 * 1000;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function startWsServer(config, dispatch, log, onRotate, onSetPolicy) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const blocked = new Map();
  const sessions = new Map();
  let globalConfirmCounter = 0;
  const pendingConfirms = new Map();
  const kaIdleMs = Number(config.kaIdleMs) > 0 ? Number(config.kaIdleMs) : 120000;

  const send = (ws, frame) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame)); };

  const keepAliveCred = () => createHash('sha256').update(String(config.token || '')).digest('hex').slice(0, 16);

  const kaParamOf = req => {
    try { return new URL(req.url, 'http://127.0.0.1').searchParams.get('ka') || ''; } catch { return ''; }
  };

  const noteFailure = ip => {
    const entry = blocked.get(ip) || { fails: 0, until: 0 };
    entry.fails += 1;
    if (entry.fails >= 3) { entry.until = Date.now() + 60000; entry.fails = 0; }
    blocked.set(ip, entry);
  };

  const isExtOrigin = origin => origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');

  const keepAliveCredValid = req => {
    const cred = keepAliveCred();
    if (!cred || !config.token) return false;
    const ka = kaParamOf(req);
    if (!ka || ka.length !== cred.length) return false;
    try { return safeEqual(ka, cred); } catch { return false; }
  };

  const fail = (ws, ip, reason) => {
    noteFailure(ip);
    log(`auth failed from ${ip}: ${reason}`);
    try { ws.close(4401, reason); } catch { ws.terminate(); }
  };

  const failSessionConfirms = session => {
    for (const [id, entry] of pendingConfirms) {
      if (entry.sessionId === session.id) {
        clearTimeout(entry.timer);
        entry.resolve(false);
        pendingConfirms.delete(id);
      }
    }
  };

  const makeCtx = session => ({
    sessionId: session.id,
    bypassRoots: false,
    requestConfirm: preview => new Promise(resolve => {
      const confirmId = ++globalConfirmCounter;
      const entry = {
        sessionId: session.id,
        resolve: approved => { log(`confirm #${confirmId} session=${session.id} -> ${approved ? 'approved' : 'rejected'}`); resolve(approved); },
        timer: null
      };
      pendingConfirms.set(confirmId, entry);
      send(session.ws, { type: 'confirm-required', confirmId, preview });
    })
  });

  server.on('upgrade', (req, socket, head) => {
    const ip = socket.remoteAddress || '?';
    const entry = blocked.get(ip);
    if (entry && entry.until > Date.now()) { socket.destroy(); return; }
    const origin = req.headers.origin || '';
    const extOrigin = isExtOrigin(origin);
    const kaPassive = !extOrigin && keepAliveCredValid(req);
    if (!extOrigin && !kaPassive) {
      if (kaParamOf(req)) { noteFailure(ip); log(`rejected keepalive credential from ${ip} origin=${origin || '(none)'}`); }
      else log(`rejected origin: ${origin || '(none)'}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, ip, kaPassive));
  });

  wss.on('connection', (ws, req, ip, kaPassive) => {
    let authed = false;
    let session = null;
    const origin = req.headers.origin || '';
    const helloTimer = setTimeout(() => { if (!authed && !kaPassive) fail(ws, ip, 'hello timeout'); }, 5000);
    let idleTimer = null;
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const armIdle = () => {
      if (!kaPassive || authed) return;
      clearIdle();
      idleTimer = setTimeout(() => {
        if (authed) return;
        log(`closing idle keepalive socket from ${ip} origin=${origin || '(none)'}`);
        try { ws.close(4408, 'idle keepalive'); } catch { ws.terminate(); }
      }, kaIdleMs);
    };
    armIdle();
    log(`extension connected from ${ip} origin=${origin || '(none)'}${kaPassive ? ' ka-passive' : ''}`);

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!authed) {
        if (m.type === 'ping' && kaPassive) { armIdle(); return send(ws, { type: 'pong' }); }
        if (kaPassive && m.type !== 'hello') return;
        if (m.type !== 'hello' || typeof m.token !== 'string') return fail(ws, ip, 'bad hello');
        if (!safeEqual(m.token, config.token)) return fail(ws, ip, 'bad token');
        authed = true;
        clearTimeout(helloTimer);
        clearIdle();
        blocked.delete(ip);
        const sessionId = (typeof m.sessionId === 'string' && m.sessionId) || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        session = { id: sessionId, ws, cache: new Map(), msgCounter: 0 };
        sessions.set(sessionId, session);
        log(`extension authenticated session=${sessionId}`);
        send(ws, { type: 'hello_ok', sessionId });
        return;
      }
      if (m.type === 'ping') return send(ws, { type: 'pong' });
      if (m.type === 'rotate-token') {
        if (typeof onRotate !== 'function') return send(ws, { type: 'rotate-failed', error: 'rotation not configured' });
        const token = onRotate();
        blocked.clear();
        send(ws, { type: 'token-rotated', token });
        log('token rotated via authenticated request');
        return;
      }
      if (m.type === 'set-policy') {
        if (typeof onSetPolicy !== 'function') return send(ws, { type: 'policy-updated', policy: { allowOutOfRoots: !!config.policy?.allowOutOfRoots } });
        const policy = onSetPolicy(m.patch);
        send(ws, { type: 'policy-updated', policy });
        return;
      }
      if (m.type === 'get-policy') {
        send(ws, { type: 'policy', policy: { allowOutOfRoots: !!config.policy?.allowOutOfRoots, confirmUnknown: !!config.policy?.confirmUnknown, defaultAllow: !!config.policy?.defaultAllow } });
        return;
      }
      if (m.type === 'ack') { if (session) session.cache.delete(m.msgId); return; }
      if (m.type === 'confirm-resolve') {
        const id = Number(m.confirmId);
        const entry = pendingConfirms.get(id);
        if (entry && (!session || entry.sessionId === session.id)) {
          clearTimeout(entry.timer);
          pendingConfirms.delete(id);
          entry.resolve(!!m.approved);
        }
        return;
      }
      if (m.type === 'resume') {
        if (!session) return;
        const last = Number(m.lastAckId) || 0;
        const cutoff = Date.now() - REPLAY_MAX_AGE;
        for (const [id, frame] of session.cache) if (id > last && frame.ts > cutoff) send(ws, frame);
        return;
      }
      if (m.type !== 'cmd') return;
      if (!Number.isInteger(m.msgId) || typeof m.action !== 'string') return;
      const started = Date.now();
      (async () => {
        let payload;
        try {
          const data = await dispatch(m.action, m.args || {}, makeCtx(session));
          payload = { ok: true, data };
        } catch (error) {
          payload = error && error.denied
            ? { ok: false, denied: String(error.message) }
            : { ok: false, error: String((error && error.message) || error) };
        }
        const frame = { type: 'result', msgId: m.msgId, hash8: m.hash8, ts: Date.now(), payload };
        if (session) {
          session.cache.set(m.msgId, frame);
          while (session.cache.size > MAX_CACHE_PER_SESSION) session.cache.delete(session.cache.keys().next().value);
        }
        send(ws, frame);
        log(`cmd #${m.msgId} ${m.action} session=${session ? session.id : '?'} -> ${payload.ok ? 'ok' : payload.denied ? 'denied' : 'error'} (${Date.now() - started}ms)`);
      })();
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearIdle();
      if (session) {
        failSessionConfirms(session);
        sessions.delete(session.id);
        log(`extension disconnected session=${session.id}`);
      } else {
        log(kaPassive ? 'keepalive socket closed (passive)' : 'extension disconnected (unauthenticated)');
      }
    });
    ws.on('error', () => { });
  });

  server.listen(config.port, '127.0.0.1', () => log(`ws server listening on ws://127.0.0.1:${config.port}`));
  return server;
}
