import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPath, checkCommand, classifyCommand } from '../src/policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = {
  allowedRoots: [root],
  defaultCwd: root,
  policy: { defaultAllow: false, whitelist: ['node', 'git', 'cd', 'dir'] }
};

test('checkPath allows paths inside roots', () => {
  assert.equal(checkPath(config, path.join(root, 'server')), path.join(root, 'server'));
  assert.equal(checkPath(config, root), root);
});

test('checkPath denies paths outside roots and traversal', () => {
  assert.throws(() => checkPath(config, 'c:\\Windows\\system32'), e => e.denied === true);
  assert.throws(() => checkPath(config, path.join(root, '..', 'other')), e => e.denied === true);
  assert.throws(() => checkPath(config, ''), e => e.denied === true);
});

test('checkCommand accepts whitelisted heads and compound commands', () => {
  assert.deepEqual(checkCommand(config, 'node -v', undefined), { ok: true });
  assert.deepEqual(checkCommand(config, 'cd server && git status', undefined), { ok: true });
  assert.deepEqual(checkCommand(config, 'dir\r\ngit log', undefined), { ok: true });
});

test('checkCommand denies blacklisted commands', () => {
  assert.throws(() => checkCommand(config, 'node -e "x" ; del file.txt', undefined), e => e.denied === true);
  assert.throws(() => checkCommand(config, 'format q:', undefined), e => e.denied === true);
  assert.throws(() => checkCommand(config, 'git status; Remove-Item -Recurse .', undefined), e => e.denied === true);
  assert.throws(() => checkCommand(config, 'rm -rf build', undefined), e => e.denied === true);
});

test('checkCommand denies non-whitelisted heads when whitelist mode is on', () => {
  assert.deepEqual(checkCommand(config, 'curl https://example.com', undefined), { ok: true, needConfirm: true, head: 'curl' });
  assert.deepEqual(checkCommand(config, 'powershell -Command "x"', undefined), { ok: true, needConfirm: true, head: 'powershell' });
  assert.deepEqual(checkCommand(config, 'if ($true) { node -v }', undefined), { ok: true, needConfirm: true, head: 'if' });
});

test('checkCommand enforces length limit', () => {
  assert.throws(() => checkCommand(config, 'node ' + 'x'.repeat(17000), undefined), /16000/);
  assert.doesNotThrow(() => checkCommand(config, 'node ' + 'x'.repeat(15000), undefined));
});

test('checkCommand skips whitelist when defaultAllow is on but keeps blacklist', () => {
  const cfg = { ...config, policy: { defaultAllow: true, whitelist: [] } };
  assert.deepEqual(checkCommand(cfg, 'curl https://example.com', undefined), { ok: true });
  assert.throws(() => checkCommand(cfg, 'format q:', undefined), e => e.denied === true);
});

test('allowOutOfRoots enables full command approval while blacklist still wins', () => {
  const cfg = { ...config, policy: { ...config.policy, confirmUnknown: false, allowOutOfRoots: true } };
  assert.deepEqual(checkCommand(cfg, 'curl https://example.com', undefined), { ok: true });
  assert.throws(() => checkCommand(cfg, 'format q:', undefined), e => e.denied === true);
});

test('classifyCommand routes unknown heads to confirm when confirmUnknown is on', () => {
  const cfg = { ...config, policy: { defaultAllow: false, confirmUnknown: true, whitelist: ['node'] } };
  const verdict = classifyCommand(cfg, 'Get-Date -Format o', undefined);
  assert.equal(verdict.kind, 'confirm');
  assert.equal(verdict.head, 'get-date');
  assert.equal(classifyCommand(cfg, 'node -v', undefined).kind, 'ok');
  assert.equal(classifyCommand(cfg, 'format q:', undefined).kind, 'deny');
});

test('classifyCommand still hard-denies unknown heads when confirmUnknown is off', () => {
  const cfg = { ...config, policy: { defaultAllow: false, confirmUnknown: false, whitelist: ['node'] } };
  const verdict = classifyCommand(cfg, 'Get-Date', undefined);
  assert.equal(verdict.kind, 'deny');
});


test('quoted separators do not split commands', () => {
  const cfg = { ...config, policy: { ...config.policy, whitelist: ['echo'] } };
  assert.equal(classifyCommand(cfg, 'echo "left; right | still one"', undefined).kind, 'ok');
  assert.equal(classifyCommand(cfg, 'echo left; git status', undefined).kind, 'confirm');
});

test('command substitutions are checked and bounded', () => {
  const cfg = { ...config, policy: { ...config.policy, whitelist: ['echo'] } };
  assert.equal(classifyCommand(cfg, 'echo $(echo $(echo safe))', undefined).kind, 'ok');
  assert.equal(classifyCommand(cfg, 'echo ${value:-$(curl bad)}', undefined).kind, 'confirm');
  const eightLevels = 'echo ' + '$(echo '.repeat(7) + 'safe' + ')'.repeat(7);
  assert.equal(classifyCommand(cfg, eightLevels, undefined).kind, 'ok');
  assert.equal(classifyCommand(cfg, 'echo $(curl bad)', undefined).kind, 'confirm');
  assert.equal(classifyCommand(cfg, 'echo $(echo', undefined).kind, 'deny');
  assert.equal(classifyCommand(cfg, 'echo $( $( $( $( $( $( $( $( $(echo x)))))))))', undefined).kind, 'deny');
});

test('full approval mode bypasses unknown and inline interpreter confirmation', () => {
  const cfg = { ...config, policy: { ...config.policy, allowOutOfRoots: true, confirmUnknown: false, whitelist: ['node', 'python', 'powershell', 'cmd'] } };
  assert.equal(classifyCommand(cfg, 'curl https://example.com', undefined).kind, 'ok');
  assert.equal(classifyCommand(cfg, 'node -e "1"', undefined).kind, 'ok');
  assert.equal(classifyCommand({ ...cfg, policy: { ...cfg.policy, interpreterPolicy: 'deny' } }, 'node -e "1"', undefined).kind, 'deny');
});

test('confirmation mode controls unknown and inline interpreter commands', () => {
  const cfg = { ...config, policy: { ...config.policy, allowOutOfRoots: false, confirmUnknown: true, whitelist: ['node', 'python', 'powershell', 'cmd'] } };
  assert.equal(classifyCommand(cfg, 'curl https://example.com', undefined).kind, 'confirm');
  assert.equal(classifyCommand(cfg, 'node -e "1"', undefined).kind, 'confirm');
  assert.equal(classifyCommand({ ...cfg, policy: { ...cfg.policy, interpreterPolicy: 'deny' } }, 'node -e "1"', undefined).kind, 'deny');
});

test('interpreter allow mode bypasses confirmation in confirmation mode', () => {
  const cfg = { ...config, policy: { ...config.policy, allowOutOfRoots: false, interpreterPolicy: 'allow', whitelist: ['node'] } };
  assert.equal(classifyCommand(cfg, 'node --eval 1', undefined).kind, 'ok');
});
