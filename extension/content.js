const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj)
};

let opts = { paused: false, autoSend: true, maxSteps: 30 };
const VOLATILE_KEYS = new Set(['id', 'pid', 'workerpid', 'sessionid', 'createdat', 'startedat', 'finishedat', 'ts', 'timestamp', 'time', 'durationms', 'cpums', 'nextoffset', 'hash8', 'for']);
const freshGuard = () => ({ step: 0, failStreak: 0, lastHash8: '', loopSignature: '', loopCount: 0, loopCommandSignature: '', autoConcluded: false, noBlockStreak: 0, plainHintShown: false });
const DONE_BLOCK_HINT = 'Output exactly this block to finish:\n\n```agent\n{\"action\":\"done\",\"args\":{\"summary\":\"task complete\"}}\n```';
let guard = freshGuard();
let seen = [];
let lastResults = {};
const respondedEls = new WeakSet();
const fillAttempts = new WeakMap();
const POLL_ACTIONS = new Set(['session_read', 'session_list']);
const replayCounts = new Map();
const rerunCounts = new Map();
const REPLAY_MAX = 2;
const RERUN_MAX = 1;
const isDoneBlock = normalized => normalized.includes('"action":"done"');
let processing = false;
let cycleRunning = false;
let cooldownUntil = 0;
let checkTimer = null;
let lastDbgKey = '';
let lastDriveHash = '';
let lastDriveAt = 0;
let fullSpeedTimers = false;
const pendingFillHandlers = new Map();
const recentDeliveries = new Map();
const deliveryFlights = new Set();
let dbgTimeline = [];
let dbgTabKey = 'x';
let timelineFlushTimer = null;
let myTabId = null;
let writeSeq = 0;
let probeDelta = { mutations: 0, addedNodes: 0, rafQueued: 0, rafExecuted: 0, hidreads: 0 };

window.addEventListener('ab-probe', event => {
  try {
    const data = event.detail || {};
    for (const key of Object.keys(probeDelta)) probeDelta[key] += Math.max(0, Number(data[key]) || 0);
  } catch { }
});

const NOISY_STAGES = new Set(['no-agent-block-on-page', 'generating', 'block-already-seen', 'stability-wait', 'drive-check']);
const PEND_MAX_AGE = 10 * 60 * 1000;
const DELIVERY_DEDUP_MS = 60 * 1000;
const MAX_FILL_ATTEMPTS = 3;

const timelineKey = () => 'ab_dbg_timeline_' + dbgTabKey;
const kaStateKey = () => 'ab_ka_' + dbgTabKey;
const guardKey = () => 'ab_guard_' + dbgTabKey;
const seenKey = () => 'ab_seen_' + dbgTabKey;
const seqKey = () => 'ab_seq_' + dbgTabKey;

function flushTimeline() {
  if (timelineFlushTimer) { clearTimeout(timelineFlushTimer); timelineFlushTimer = null; }
  try { store.set({ [timelineKey()]: dbgTimeline.slice(-50) }); } catch { }
}

function queueTimelineFlush(immediate) {
  if (immediate) { flushTimeline(); return; }
  if (!timelineFlushTimer) timelineFlushTimer = setTimeout(flushTimeline, 1000);
}

function kaSet(state, code) {
  try { store.set({ [kaStateKey()]: { state, code: code == null ? null : code, ts: Date.now(), host: location.host } }); } catch { }
}

async function loadState() {
  const gk = guardKey();
  const sk = seenKey();
  const o = await store.get(['ab_opts', gk, sk, seqKey(), 'ab_guard', 'ab_seen', 'ab_state_migrated']);
  opts = Object.assign({ paused: false, autoSend: true, maxSteps: 30 }, o.ab_opts || {});
  const adoptLegacy = dbgTabKey !== 'x' && !o.ab_state_migrated && o[gk] === undefined && o[sk] === undefined;
  guard = Object.assign(freshGuard(), o[gk] || (adoptLegacy ? o.ab_guard : null) || {});
  seen = o[sk] || (adoptLegacy ? o.ab_seen : null) || [];
  writeSeq = Number(o[seqKey()]) || 0;
  if (adoptLegacy) await store.set({ ab_state_migrated: Date.now() });
}

const saveState = () => store.set({ ab_opts: opts, [guardKey()]: guard, [seenKey()]: seen.slice(-300), [seqKey()]: ++writeSeq });
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

function markDelivered(key) {
  recentDeliveries.set(key, Date.now());
  for (const [k, t] of recentDeliveries) if (Date.now() - t > DELIVERY_DEDUP_MS) recentDeliveries.delete(k);
}

const recentlyDelivered = key => {
  const at = recentDeliveries.get(key);
  return !!at && Date.now() - at < DELIVERY_DEDUP_MS;
};

function isStatusPoll(cmd, payload) {
  if (!cmd || !POLL_ACTIONS.has(cmd.action)) return false;
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') return false;
  if (cmd.action === 'session_list') return Array.isArray(data.sessions) && data.sessions.some(s => s && s.status === 'running');
  return data.status === 'running' || data.running === true;
}

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

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') return Object.keys(value).reduce((result, key) => {
    if (!VOLATILE_KEYS.has(key.toLowerCase())) result[key] = stripVolatile(value[key]);
    return result;
  }, {});
  return value;
}

const q = sel => document.querySelector(sel);

const ADAPTER = __AB_ADAPTER;

function isGenerating() {
  return ADAPTER.isGenerating();
}

function cleanHeader(text) {
  return String(text || '').replace(/copy( code)?|复制代码|复制/gi, '').trim().toLowerCase();
}

function isBareDoneCandidate(el, block) {
  const body = (el.textContent || '').trim();
  if (body.toLowerCase() !== 'done') return false;
  const container = el.closest?.('code, [class*="code-body" i]') || block || el;
  return (container.textContent || '').trim().toLowerCase() === 'done';
}

const AGENT_CLASS_RE = /(^|[\s_/-])agent([\s_/-]|$)/i;

function hasAgentClass(el) {
  const cls = el ? (typeof el.className === 'string' ? el.className : String((el.getAttribute && el.getAttribute('class')) || '')) : '';
  if (!cls || /agent-result/i.test(cls)) return false;
  return AGENT_CLASS_RE.test(cls);
}

function preIsAgentFenced(pre, header) {
  if (header === 'agent' || hasAgentClass(pre)) return true;
  for (const el of pre.querySelectorAll('[class*="agent" i]')) if (hasAgentClass(el)) return true;
  return false;
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
    if (body.toLowerCase() === 'done' && isBareDoneCandidate(code, pre) && preIsAgentFenced(pre, header)) return { code, body: '{"action":"done","args":{}}' };
    const tokens = [...(code.classList || [])];
    const isCodeEl = code.tagName === 'CODE';
    if (tokens.includes('language-agent') || body.startsWith('{"action"') || (isCodeEl && header === 'agent')) return { code, body };
  }
  return null;
}

const REBUILD_TTL = 5000;
const REBUILD_DONE_TTL = 30000;
const MAX_SCROLL_STEPS = 64;
const HARD_SCROLL_STEPS = 512;
const MAX_STEPS_PER_PASS = 32;
const MAX_HEAD_RESETS = 4;
const MAX_STALLS = 3;
const MAX_REBUILD_PASSES = 6;
const rebuildState = new WeakMap();

const stepBudget = (max, step) => Math.min(HARD_SCROLL_STEPS, Math.max(MAX_SCROLL_STEPS, Math.ceil((max + step) / Math.max(1, step)) + 4));

const parses = text => { try { JSON.parse(text); return true; } catch { return false; } };

function suspectTruncated(body) {
  const text = String(body || '').trim();
  if (!text) return false;
  if (text.startsWith('<')) return true;
  if (!text.startsWith('{')) return false;
  return !parses(text);
}

function horizontalScroller(el) {
  let node = el;
  let pad = 1;
  while (node && node.nodeType === 1) {
    if (node.clientWidth > 0 && node.scrollWidth > node.clientWidth + pad) return node;
    node = node.parentElement;
    pad = 10;
  }
  return null;
}

function overlapLength(base, next) {
  const limit = Math.min(base.length, next.length);
  if (limit <= 0) return 0;
  const probe = next.slice(0, limit) + '\u0000' + base.slice(base.length - limit);
  const fail = new Int32Array(probe.length);
  let k = 0;
  for (let i = 1; i < probe.length; i += 1) {
    while (k > 0 && probe[i] !== probe[k]) k = fail[k - 1];
    if (probe[i] === probe[k]) k += 1;
    fail[i] = k;
  }
  return fail[probe.length - 1];
}

function overlapJoin(base, next) {
  if (!next) return base;
  if (!base) return next;
  const k = overlapLength(base, next);
  if (k >= next.length) return base;
  if (k > 0) return base + next.slice(k);
  const trimmed = base.replace(/\s+$/, '');
  if (trimmed.length !== base.length) {
    const k2 = overlapLength(trimmed, next);
    if (k2 >= next.length) return trimmed;
    if (k2 > 0) return trimmed + next.slice(k2);
  }
  if (base.length >= next.length && base.indexOf(next) >= 0) return base;
  return base + next;
}

function mergeLines(target, text) {
  const parts = String(text).split('\n');
  for (let i = 0; i < parts.length; i += 1) {
    if (i < target.length) target[i] = overlapJoin(target[i], parts[i]);
    else target.push(parts[i]);
  }
}

const taskYield = () => new Promise(resolve => {
  let settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  try {
    const channel = new MessageChannel();
    channel.port1.onmessage = finish;
    channel.port2.postMessage(0);
  } catch { }
  try { requestAnimationFrame(finish); } catch { }
  setTimeout(finish, 60);
});

const nextPaint = async () => { await taskYield(); await taskYield(); };

function notifyScroll(scroller) {
  try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch { }
}

function finishRebuild(st, scroller) {
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  st.finished = st.pos > max || st.steps >= st.budget || (st.resets || 0) > MAX_HEAD_RESETS;
  st.at = Date.now();
  st.text = st.lines.join('\n').trim();
  st.parseable = parses(st.text);
  if (st.parseable && st.pieces > 1) dbg('rebuild-ok', 'pieces=' + st.pieces + ' len=' + st.text.length + ' steps=' + st.steps);
  return st.text;
}

async function advanceRebuild(code, st, scroller) {
  const origin = scroller.scrollLeft;
  const step = Math.max(24, Math.floor(scroller.clientWidth * 0.8));
  let max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  let pass = 1;
  try {
    scroller.scrollLeft = 0;
    notifyScroll(scroller);
    await nextPaint();
    const head = code.textContent || '';
    if (st.head === null || head !== st.head) {
      st.lines = [];
      st.head = head;
      st.pos = step;
      st.pieces = head ? 1 : 0;
      st.stalls = 0;
      st.lastText = '';
      st.steps = 1;
      st.passes = 1;
      st.resets = (st.resets || 0) + 1;
      st.budget = stepBudget(max, step);
      pass = 1;
      if (head) mergeLines(st.lines, head);
    } else st.steps += 1;
    if (max <= 0) return finishRebuild(st, scroller);
    while (st.steps < st.budget && pass < MAX_STEPS_PER_PASS) {
      const target = Math.min(st.pos, max);
      scroller.scrollLeft = target;
      notifyScroll(scroller);
      await nextPaint();
      pass += 1;
      st.steps += 1;
      const text = code.textContent || '';
      if (text && text === st.lastText) {
        st.stalls += 1;
        if (st.stalls >= MAX_STALLS) break;
      } else st.stalls = 0;
      st.lastText = text;
      if (text) { st.pieces += 1; mergeLines(st.lines, text); }
      const live = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      if (live > max) { max = live; st.budget = stepBudget(max, step); }
      if (target >= max) { st.pos = max + 1; break; }
      st.pos = Math.max(scroller.scrollLeft, target) + step;
    }
    return finishRebuild(st, scroller);
  } finally {
    try { scroller.scrollLeft = origin; } catch { }
  }
}

async function readFullBody(code, initial) {
  if (!code || !suspectTruncated(initial)) return initial;
  const now = Date.now();
  const cached = rebuildState.get(code);
  if (cached && now - cached.at < (cached.parseable ? REBUILD_DONE_TTL : REBUILD_TTL)) return cached.text || initial;
  const scroller = horizontalScroller(code);
  if (!scroller) return initial;
  let st = cached && cached.scroller === scroller && !cached.finished ? cached : null;
  if (!st) {
    st = { scroller, head: null, pos: 0, steps: 0, budget: MAX_SCROLL_STEPS, resets: 0, passes: 0, pieces: 0, stalls: 0, lastText: '', lines: [], text: '', at: 0, finished: false, parseable: false };
    rebuildState.set(code, st);
  }
  st.passes += 1;
  try {
    return (await advanceRebuild(code, st, scroller)) || initial;
  } catch {
    st.at = Date.now();
    st.finished = true;
    return initial;
  }
}

function peekRebuild(code) {
  const st = code ? rebuildState.get(code) : null;
  if (!st || !st.parseable || Date.now() - st.at >= REBUILD_DONE_TTL) return '';
  return st.text;
}

function rebuildStats(code) {
  const st = code ? rebuildState.get(code) : null;
  return { pieces: st ? st.pieces : 0, len: st && st.text ? st.text.length : 0 };
}

function scanLatestAgentBlock() {
  let latest = null;
  for (const pre of document.querySelectorAll('pre')) {
    const cand = codeBodyIfAgent(pre);
    if (!cand) continue;
    if (!latest || (latest.el.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING)) latest = { el: pre, code: cand.code, body: cand.body };
  }
  for (const code of document.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const body = (code.textContent || '').trim();
    const bareDone = isBareDoneCandidate(code, code) && (hasAgentClass(code) || hasAgentClass(code.parentElement));
    if (bareDone || (body.startsWith('{"action"') && body.endsWith('}'))) {
      const normalized = bareDone ? '{"action":"done","args":{}}' : body;
      if (!latest || (latest.el.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING)) latest = { el: code, code, body: normalized };
    }
  }
  return latest;
}

async function findLatestAgentBlock() {
  const cand = scanLatestAgentBlock();
  if (!cand) return null;
  const body = await readFullBody(cand.code, cand.body);
  return { el: cand.el, code: cand.code, body };
}

function scheduleCheck(delay = 350) {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(checkCycle, delay);
}

async function noteNoBlock() {
  guard.noBlockStreak += 1;
  if (document.visibilityState === 'hidden' && fullSpeedTimers) {
    try { const se = document.scrollingElement; if (se && se.scrollHeight - se.scrollTop - se.clientHeight > 40) { se.scrollTop = se.scrollHeight; notifyScroll(se); } } catch { }
  }
  if (guard.step > 0 && !guard.plainHintShown && guard.noBlockStreak >= 4) {
    guard.plainHintShown = true;
    await saveState();
    dbg('plain-text-nudge', 'no-agent-block');
    toast('AI 未输出 agent 块也未输出 done；若任务已完成可让它输出 done 块（格式见协议）');
  }
  dbg('no-agent-block-on-page');
}

async function checkCycle() {
  if (cycleRunning) return;
  if (document.visibilityState === 'hidden' && !fullSpeedTimers) return;
  cycleRunning = true;
  try {
    if (processing || opts.paused) return;
    if (Date.now() < cooldownUntil) return;
    if (isGenerating()) {
      guard.noBlockStreak = 0;
      dbg('generating');
      return;
    }
    const raw1 = await findLatestAgentBlock();
    if (!raw1) {
      await noteNoBlock();
      return;
    }
    const normalized = raw1.body.trim();
    const hash8 = (await sha1(normalized)).slice(0, 8);
    const dedupKey = ADAPTER.id + ':' + hash8;
    if (seen.includes(dedupKey)) {
      if (respondedEls.has(raw1.el)) {
        guard.noBlockStreak = 0;
        if (document.visibilityState === 'hidden' && fullSpeedTimers && scrollChatToBottom(raw1.el)) dbg('chat-scroll-bottom', dedupKey);
        dbg('skip-responded-el', dedupKey);
        return;
      }
      if (guard.noBlockStreak) {
        guard.noBlockStreak = 0;
        await saveState();
      }
      const hit = lastResults[dedupKey];
      if (isDoneBlock(normalized)) { dbg('skip-done-replay', dedupKey); return; }
      if (hit && hit.payload && (hit.payload.ok || hit.el === raw1.el)) {
        const count = replayCounts.get(dedupKey) || 0;
        if (count >= REPLAY_MAX) { dbg('skip-replay-cap', dedupKey); return; }
        replayCounts.set(dedupKey, count + 1);
        dbg(hit.payload.ok ? 'replay-cached-new-el' : 'refill-same-el', dedupKey);
        processing = true;
        try { await respond(hash8, hit.payload, raw1.el); } finally { processing = false; }
        return;
      }
      const rerunCount = rerunCounts.get(dedupKey) || 0;
      if (rerunCount >= RERUN_MAX) { dbg('skip-rerun-cap', dedupKey); return; }
      rerunCounts.set(dedupKey, rerunCount + 1);
      dbg('rerun-seen-new-el', dedupKey);
      processing = true;
      try { await handleBlock(normalized, dedupKey, hash8, raw1.el); }
      finally { processing = false; }
      return;
    }
    if (guard.noBlockStreak) {
      guard.noBlockStreak = 0;
      await saveState();
    }
    await sleep(600);
    if (isGenerating()) return;
    const raw2 = await findLatestAgentBlock();
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

let rebuildFlight = false;

function scrollChatToBottom(el) {
  try {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.clientHeight > 150 && node.scrollHeight > node.clientHeight + 50) {
        if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) {
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event('scroll', { bubbles: true }));
          return true;
        }
        return false;
      }
      node = node.parentElement;
    }
  } catch { }
  return false;
}

async function driveTriggerBlock(block, tag) {
  const normalized = String(block.body || '').trim();
  const hash = await sha1(normalized);
  const hash8 = hash.slice(0, 8);
  const dedupKey = ADAPTER.id + ':' + hash8;
  dbg(tag, hash8 + ' len=' + normalized.length + ' seen=' + seen.includes(dedupKey));
  if (seen.includes(dedupKey)) {
    if (document.visibilityState === 'hidden' && scrollChatToBottom(block.el)) dbg('chat-scroll-bottom', dedupKey);
    if (respondedEls.has(block.el)) {
      dbg('skip-responded-el', dedupKey);
      return;
    }
    if (isDoneBlock(normalized)) { dbg('skip-done-replay', dedupKey); return; }
    const hit = lastResults[dedupKey];
    if (hit && hit.payload && hit.payload.ok) {
      const count = replayCounts.get(dedupKey) || 0;
      if (count >= REPLAY_MAX) { dbg('skip-replay-cap', dedupKey); return; }
      replayCounts.set(dedupKey, count + 1);
      dbg('replay-cached-new-el', dedupKey);
      await respond(hash8, hit.payload, block.el);
      return;
    }
    const rerunCount = rerunCounts.get(dedupKey) || 0;
    if (rerunCount >= RERUN_MAX) { dbg('skip-rerun-cap', dedupKey); return; }
    rerunCounts.set(dedupKey, rerunCount + 1);
    dbg('rerun-seen-new-el', dedupKey);
    await handleBlock(normalized, dedupKey, hash8, block.el);
    return;
  }
  dbg('agent-block-detected', normalized.slice(0, 80));
  await handleBlock(normalized, dedupKey, hash8, block.el);
}

async function driveRebuild(cand) {
  if (rebuildFlight || processing || cycleRunning) return;
  rebuildFlight = true;
  try {
    const full = String((await readFullBody(cand.code, cand.body)) || cand.body).trim();
    if (!parses(full)) {
      const stats = rebuildStats(cand.code);
      const st = rebuildState.get(cand.code);
      if (st && !st.finished && (st.passes || 0) < MAX_REBUILD_PASSES) dbg('rebuild-partial', 'pieces=' + stats.pieces + ' len=' + full.length + ' steps=' + st.steps + '/' + st.budget);
      else dbg('rebuild-failed', 'pieces=' + stats.pieces + ' len=' + full.length + ' steps=' + (st ? st.steps : 0));
      dbg('stabilizing', 'len=' + full.length + ' head=' + full.slice(0, 60));
      return;
    }
    processing = true;
    try { await driveTriggerBlock({ el: cand.el, body: full }, 'drive-rebuild-triggered'); }
    finally { processing = false; }
  } catch (e) {
    dbg('check-error', String((e && e.stack) || e));
    toast('AgentBridge 检测出错：' + String((e && e.message) || e));
  } finally {
    rebuildFlight = false;
  }
}

function driveCheck(source) {
  const probe = probeDelta;
  probeDelta = { mutations: 0, addedNodes: 0, rafQueued: 0, rafExecuted: 0, hidreads: 0 };
  dbgTimeline.push({ stage: 'probe', extra: `mut=${probe.mutations}/${probe.addedNodes} raf=${probe.rafQueued}/${probe.rafExecuted} hidreads=${probe.hidreads}`, ts: Date.now(), host: location.host });
  if (dbgTimeline.length > 60) dbgTimeline = dbgTimeline.slice(-50);
  queueTimelineFlush(false);
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
      out = 'generating';
    } else {
      const cand = scanLatestAgentBlock();
      if (!cand) {
        if (document.visibilityState === 'hidden') {
          try { const se = document.scrollingElement; if (se && se.scrollHeight - se.scrollTop - se.clientHeight > 40) { se.scrollTop = se.scrollHeight; notifyScroll(se); dbg('chat-scroll-bottom', 'doc'); } } catch { }
        }
        out = 'no-block';
      } else {
        const rebuilt = peekRebuild(cand.code);
        const normalized = (rebuilt || cand.body).trim();
        const complete = parses(normalized);
        const rb = rebuildState.get(cand.code);
        const exhausted = !!rb && !rb.parseable && (rb.finished || (rb.passes || 0) >= MAX_REBUILD_PASSES);
        const now = Date.now();
        const stable = normalized === lastDriveHash && now - lastDriveAt >= 25000;
        lastDriveHash = normalized;
        lastDriveAt = now;
        if (!complete && !exhausted && suspectTruncated(normalized)) {
          out = 'rebuilding';
          try { cand.el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { }
          dbg('rebuild-start', 'len=' + normalized.length + ' head=' + normalized.slice(0, 60));
          driveRebuild(cand);
        } else if (!complete && !stable) {
          out = 'stabilizing';
          try { cand.el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { }
          dbg('stabilizing', 'len=' + normalized.length + ' head=' + normalized.slice(0, 60));
        } else {
          processing = true;
          out = 'triggered';
          driveTriggerBlock({ el: cand.el, body: normalized }, 'drive-triggered').catch(e => {
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

function flattenArgs(cmd) {
  if (!cmd || typeof cmd !== 'object') return cmd;
  if (cmd.args && typeof cmd.args === 'object' && !Array.isArray(cmd.args)) return cmd;
  const rest = {};
  let has = false;
  for (const key of Object.keys(cmd)) {
    if (key === 'action' || key === 'args') continue;
    rest[key] = cmd[key];
    has = true;
  }
  if (has) return Object.assign({}, cmd, { args: rest });
  return Object.assign({}, cmd, { args: {} });
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
  cmd = flattenArgs(cmd);
  if (cmd.action === 'done') {
    guard = freshGuard();
    markSeen(key);
    saveState();
    toast('AgentBridge: 任务完成，计数已重置');
    return;
  }
  const pendHit = await takePend(key, hash8);
  if (pendHit) {
    await deliver(key, hash8, pendHit.payload, el, null, false);
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
  const commandSignature = await sha1(stableJson({ action: cmd.action, args: cmd.args || {} }));
  if (guard.autoConcluded && commandSignature !== guard.loopCommandSignature) guard.autoConcluded = false;
  if (guard.autoConcluded) {
    markSeen(key);
    guard.step += 1;
    const concluded = { ok: false, denied: 'task auto-concluded after repeated no-op commands; this command was not executed. Send a new instruction to start something new. ' + DONE_BLOCK_HINT };
    dbg('loop-blocked', cmd.action);
    cacheResult(key, concluded, el);
    await saveState();
    await respond(hash8, concluded, el);
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
  await deliver(key, hash8, payload, el, cmd, true, commandSignature);
}

async function deliver(key, hash8, payload, el, cmd, trackLoop, priorSignature) {
  let delivered = payload;
  let loopFlagged = false;
  if (trackLoop && cmd && !isStatusPoll(cmd, payload)) {
    const commandSignature = priorSignature || await sha1(stableJson({ action: cmd.action, args: cmd.args || {} }));
    const signature = commandSignature + ':' + await sha1(stableJson(stripVolatile(payload)));
    dbg('loop-sig', signature.slice(0, 24));
    if (guard.loopSignature === signature) guard.loopCount += 1;
    else { guard.loopSignature = signature; guard.loopCount = 1; guard.autoConcluded = false; }
    if (guard.loopCount >= 3) {
      delivered = { ok: false, denied: 'task auto-concluded after repeated no-op commands; further identical commands will not be executed. Send a new instruction to start something new. ' + DONE_BLOCK_HINT };
      loopFlagged = true;
      guard.autoConcluded = true;
      guard.loopCommandSignature = commandSignature;
      dbg('loop-auto-stop', signature.slice(0, 24));
      toast('AgentBridge: 检测到空转循环，任务已自动结束');
    } else if (guard.loopCount >= 2) {
      delivered = { ok: false, denied: 'loop detected: the same command returned the same result twice with no progress. If the task is complete, output the done block now. Otherwise change approach and explain why. ' + DONE_BLOCK_HINT };
      loopFlagged = true;
      dbg('loop-nudge', signature.slice(0, 24));
      toast('AgentBridge: 检测到重复无进展，已提醒模型输出 done 或改变方法');
    }
  }
  const effective = loopFlagged ? payload : delivered;
  guard.step += 1;
  guard.failStreak = effective && effective.ok ? 0 : guard.failStreak + 1;
  guard.lastHash8 = key;
  cacheResult(key, delivered, el);
  await saveState();
  await respond(hash8, delivered, el);
}

async function respond(hash8, payload, el) {
  const key = ADAPTER.id + ':' + hash8;
  if (recentlyDelivered(key)) {
    if (el) respondedEls.add(el);
    dbg('skip-already-sent', key);
    return;
  }
  if (deliveryFlights.has(key)) {
    dbg('skip-delivery-inflight', key);
    return;
  }
  deliveryFlights.add(key);
  let filled = false;
  try {
  const text = '```agent-result\n' + buildResultBody(hash8, payload) + '\n```';
  dbg('fill-start', hash8);
  filled = await ADAPTER.insertText(text);
  if (!filled) {
    const attempts = ((el && fillAttempts.get(el)) || 0) + 1;
    if (el) fillAttempts.set(el, attempts);
    cooldownUntil = Date.now() + 5000;
    dbg('fill-failed', hash8 + ' attempt=' + attempts);
    if (attempts >= MAX_FILL_ATTEMPTS) toast('AgentBridge: 回填连续失败（找不到输入框），请手动把结果发给 AI');
    return;
  }
  dbg('fill-done', hash8);
  const o = await store.get('ab_opts');
  const current = Object.assign({ paused: false, autoSend: true, maxSteps: 30 }, o.ab_opts || {});
  if (current.paused) { highlight(true); toast('AgentBridge: 已填入未发送（监听已暂停）'); return; }
  if (current.autoSend === false) { highlight(true); toast('AgentBridge: 已填入未发送（自动发送已关闭）'); return; }
  const sent = await ADAPTER.send();
  if (!sent) { dbg('send-failed', hash8); highlight(true); toast('AgentBridge: 已填入未发送（发送失败），请手动按回车发送'); }
  else { dbg('send-done', hash8); highlight(false); markDelivered(key); }
  cooldownUntil = Date.now() + 5000;
  } finally {
    if (el && (filled || (fillAttempts.get(el) || 0) >= MAX_FILL_ATTEMPTS)) respondedEls.add(el);
    deliveryFlights.delete(key);
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
  try {
    const r = await chrome.runtime.sendMessage({ type: 'content-hello' });
    if (r && r.tabId != null) { myTabId = String(r.tabId); dbgTabKey = myTabId; }
  } catch { }
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
  startKeepAlive(myTabId);
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
        agentBlocks: !!scanLatestAgentBlock(),
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
    const seenChange = changes[seenKey()] || changes.ab_seen;
    if (seenChange) seen = seenChange.newValue || [];
    const guardChange = changes[guardKey()] || changes.ab_guard;
    if (guardChange) {
      const echo = changes[seqKey()] && Number(changes[seqKey()].newValue) === writeSeq;
      if (!echo) guard = Object.assign(freshGuard(), guardChange.newValue || {});
    }
    if (changes.resetGuard) {
      const reset = changes.resetGuard.newValue;
      if (!reset || typeof reset !== 'object' || reset.tab == null || String(reset.tab) === String(myTabId)) {
        guard = freshGuard();
        seen = [];
        saveState();
        toast('AgentBridge: 新任务，计数已重置');
      }
    }
  });
  dbg('content-script-active', ADAPTER.id + '@' + location.host);
  (async () => {
    const t0 = Date.now();
    for (let i = 0; i < 4; i += 1) await sleep(250);
    fullSpeedTimers = Date.now() - t0 < 1500;
    dbg('timer-drift', fullSpeedTimers ? 'full-speed' : 'throttled');
  })();
  scheduleCheck(500);
}

init();
