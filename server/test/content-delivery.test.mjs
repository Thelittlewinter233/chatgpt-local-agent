import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.resolve(here, '../../extension/content.js'), 'utf8');

const hostSetTimeout = setTimeout;
const hostClearTimeout = clearTimeout;
const openTimers = new Map();
let nextTimerId = 1;

function schedule(fn, ms) {
  const id = nextTimerId;
  nextTimerId += 1;
  openTimers.set(id, hostSetTimeout(() => { openTimers.delete(id); fn(); }, Number(ms) || 0));
  return id;
}

function cancel(id) {
  const handle = openTimers.get(id);
  if (handle) hostClearTimeout(handle);
  openTimers.delete(id);
}

test.after(() => {
  for (const handle of openTimers.values()) hostClearTimeout(handle);
  openTimers.clear();
});

const RESULT_PAYLOAD = { ok: true, data: { exitCode: 0, output: 'bridge-result' } };
const AGENT_BODY = '{"action":"computer_info","args":{}}';

function agentPre(body) {
  const pre = {
    nodeType: 1,
    tagName: 'PRE',
    className: 'agent-block',
    textContent: body,
    querySelector: () => null,
    querySelectorAll: selector => (selector === 'code' ? pre.code : []),
    compareDocumentPosition: () => 0,
    scrollIntoView: () => { }
  };
  pre.code = [{ tagName: 'CODE', classList: ['language-agent'], textContent: body, closest: () => pre, nodeType: 1 }];
  return pre;
}

function makeToastNode() {
  return { id: '', textContent: '', style: {}, append() { }, remove() { }, addEventListener() { } };
}

function createBridge(options = {}) {
  const calls = { inserts: [], sends: 0 };
  const insertResults = options.insertResults || [true];
  const delay = options.delayMs || 0;
  const wait = ms => new Promise(resolve => hostSetTimeout(resolve, ms));
  const storage = new Map();
  let block = null;

  const adapter = {
    id: 'test',
    matches: () => true,
    isGenerating: () => false,
    findInput: () => ({ style: {} }),
    async insertText(text) {
      if (delay) await wait(delay);
      const index = calls.inserts.push(text) - 1;
      return insertResults[Math.min(index, insertResults.length - 1)];
    },
    async send() {
      if (delay) await wait(delay);
      calls.sends += 1;
      return true;
    }
  };

  const documentStub = {
    visibilityState: 'visible',
    hidden: false,
    scrollingElement: null,
    body: { appendChild() { }, removeChild() { } },
    addEventListener() { },
    removeEventListener() { },
    querySelector: () => null,
    querySelectorAll: selector => (selector === 'pre' ? (block ? [block] : []) : []),
    getElementById: () => null,
    createElement: () => makeToastNode(),
    execCommand: () => true
  };

  const sandbox = {
    console: { log() { }, warn() { }, error() { } },
    setTimeout: schedule,
    clearTimeout: cancel,
    setInterval: () => 0,
    clearInterval: () => { },
    requestAnimationFrame: cb => schedule(() => cb(Date.now()), 8),
    cancelAnimationFrame: () => { },
    MessageChannel: class { constructor() { this.port1 = { }; this.port2 = { postMessage() { } }; } },
    crypto: { subtle: webcrypto.subtle },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    performance,
    TextEncoder,
    Promise, WeakSet, WeakMap, Map, Set, Error, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Symbol,
    Uint8Array, Int32Array,
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { },
    ClipboardEvent: class { },
    CustomEvent: class { },
    DataTransfer: class { },
    location: { host: 'bridge.test', hostname: 'bridge.test' },
    navigator: { },
    MutationObserver: class { observe() { } disconnect() { } },
    document: documentStub,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = { };
            for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = storage.get(key);
            return out;
          },
          async set(obj) {
            for (const [key, value] of Object.entries(obj)) storage.set(key, value);
          }
        },
        onChanged: { addListener() { } }
      },
      runtime: {
        async sendMessage(msg) {
          if (msg.type === 'agent-cmd') return RESULT_PAYLOAD;
          if (msg.type === 'content-hello') return { ok: true, tabId: 7 };
          return { ok: false };
        },
        onMessage: { addListener() { } },
        getURL: p => p
      },
      tabs: { sendMessage: async () => ({ }) },
      action: { setBadgeText() { }, setBadgeBackgroundColor() { } }
    },
    __AB_ADAPTER: adapter,
    addEventListener() { },
    removeEventListener() { },
    dispatchEvent() { },
    getSelection: () => ({ removeAllRanges() { } }),
    createRange: () => ({ })
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: 'content.js' });
  const evaluate = expression => vm.runInContext(expression, ctx, { filename: 'bridge-harness.js' });

  return {
    calls,
    async respond(hash8, payload, el) {
      ctx.__args = { hash8, payload, el };
      return evaluate('respond(__args.hash8, __args.payload, __args.el)');
    },
    async cycle() {
      return evaluate('checkCycle()');
    },
    rewindCooldown() {
      evaluate('cooldownUntil = 0');
    },
    setBlock(body) {
      block = body ? agentPre(body) : null;
    }
  };
}

test('one command result is backfilled and sent exactly once', async () => {
  const bridge = createBridge();
  await bridge.respond('aa11bb22', RESULT_PAYLOAD, { marker: 'first-el' });
  await bridge.respond('aa11bb22', RESULT_PAYLOAD, { marker: 'remounted-el' });
  assert.equal(bridge.calls.sends, 1);
  assert.equal(bridge.calls.inserts.length, 1);
});

test('overlapping respond calls for one command send one result', async () => {
  const bridge = createBridge({ delayMs: 20 });
  await Promise.all([
    bridge.respond('aa11bb22', RESULT_PAYLOAD, { marker: 'first-el' }),
    bridge.respond('aa11bb22', RESULT_PAYLOAD, { marker: 'remounted-el' })
  ]);
  assert.equal(bridge.calls.sends, 1);
  assert.equal(bridge.calls.inserts.length, 1);
});

test('checkCycle replaying a cached result after DOM remount does not resend', async () => {
  const bridge = createBridge();
  bridge.setBlock(AGENT_BODY);
  await bridge.cycle();
  assert.equal(bridge.calls.sends, 1);
  const firstText = bridge.calls.inserts[0];
  assert.ok(firstText.includes('agent-result'));
  bridge.rewindCooldown();
  bridge.setBlock(AGENT_BODY);
  await bridge.cycle();
  assert.equal(bridge.calls.sends, 1);
  assert.equal(bridge.calls.inserts.length, 1);
});

test('a failed fill keeps the result retryable', async () => {
  const bridge = createBridge({ insertResults: [false, true] });
  const el = { marker: 'same-el' };
  await bridge.respond('cc33dd44', RESULT_PAYLOAD, el);
  assert.equal(bridge.calls.sends, 0);
  assert.equal(bridge.calls.inserts.length, 1);
  await bridge.respond('cc33dd44', RESULT_PAYLOAD, el);
  assert.equal(bridge.calls.sends, 1);
  assert.equal(bridge.calls.inserts.length, 2);
});

test('results for different commands are still delivered', async () => {
  const bridge = createBridge();
  await bridge.respond('ee55ff66', RESULT_PAYLOAD, { marker: 'one' });
  await bridge.respond('1177aa88', { ok: true, data: { output: 'other' } }, { marker: 'two' });
  assert.equal(bridge.calls.sends, 2);
  assert.equal(bridge.calls.inserts.length, 2);
});
