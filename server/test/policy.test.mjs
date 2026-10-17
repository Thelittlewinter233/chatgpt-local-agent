import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkPath, checkCommand, classifyCommand } from '../src/policy.mjs';

const config = {
  allowedRoots: ['d:\\Desktop\\agent_project'],
  defaultCwd: 'd:\\Desktop\\agent_project',
  policy: { defaultAllow: false, whitelist: ['node', 'git', 'cd', 'dir'] }
};

test('checkPath allows paths inside roots', () => {
  assert.equal(checkPath(config, 'd:\\Desktop\\agent_project\\server'), path.resolve('d:\\Desktop\\agent_project\\server'));
  assert.equal(checkPath(config, 'd:/Desktop/agent_project'), path.resolve('d:/Desktop/agent_project'));
});

test('checkPath denies paths outside roots and traversal', () => {
  assert.throws(() => checkPath(config, 'c:\\Windows\\system32'), e => e.denied === true);
  assert.throws(() => checkPath(config, 'd:\\Desktop\\agent_project\\..\\other'), e => e.denied === true);
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
  assert.throws(() => checkCommand(config, 'curl https://example.com', undefined), /not whitelisted/);
  assert.throws(() => checkCommand(config, 'powershell -Command "x"', undefined), /not whitelisted/);
  assert.throws(() => checkCommand(config, 'if ($true) { node -v }', undefined), /not whitelisted/);
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
