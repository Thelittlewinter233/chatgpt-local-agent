const $ = id => document.getElementById(id);

async function refresh() {
  const o = await chrome.storage.local.get(['wsStatus', 'wsError', 'ab_opts', 'token', 'ab_dbg', 'ab_guard']);
  const status = o.wsStatus || 'unknown';
  const labels = {
    connected: '已连接本地服务',
    connecting: '连接中…',
    disconnected: '未连接（本地服务未启动？）',
    unpaired: '未配对：请先保存 Token'
  };
  $('status').textContent = labels[status] || status;
  $('dot').className = 'dot ' + (status === 'connected' ? 'on' : 'off');
  $('err').textContent = o.wsError || '';
  $('token').value = o.token || '';
  const opts = o.ab_opts || {};
  $('autoSend').checked = opts.autoSend !== false;
  $('paused').checked = !!opts.paused;
  $('maxSteps').value = opts.maxSteps || 30;
  const d = o.ab_dbg;
  if (d && d.stage) {
    const age = Math.round((Date.now() - d.ts) / 1000);
    $('dbg').textContent = '页面脚本 [' + age + 's前] ' + d.stage + (d.extra ? ' · ' + d.extra : '');
  } else {
    $('dbg').textContent = '页面脚本：无心跳（chatgpt.com 标签页可能未刷新）';
  }
  const g = o.ab_guard || {};
  const step = g.step || 0;
  const limit = Math.min(Math.max(Number((o.ab_opts || {}).maxSteps) || 30, 10), 100);
  const fail = g.failStreak || 0;
  const fuse = fail >= 3 ? ' · 已熔断，点新任务解除' : '';
  $('guard').textContent = '任务进度：' + step + '/' + limit + ' 步 · 连续失败 ' + fail + fuse;
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() });
  $('err').textContent = '已保存，正在测试…';
  const res = await chrome.runtime.sendMessage({ type: 'ping' }).catch(e => ({ ok: false, error: String(e) }));
  if (res && res.ok) $('err').textContent = '连接成功：' + (res.data && res.data.platform || 'agent') + ' ' + (res.data && res.data.node || '');
  else $('err').textContent = '连接失败：' + ((res && res.error) || '未知错误');
  refresh();
});

$('autoSend').addEventListener('change', async e => {
  const o = await chrome.storage.local.get('ab_opts');
  await chrome.storage.local.set({ ab_opts: { ...(o.ab_opts || {}), autoSend: e.target.checked } });
});

$('paused').addEventListener('change', async e => {
  const o = await chrome.storage.local.get('ab_opts');
  await chrome.storage.local.set({ ab_opts: { ...(o.ab_opts || {}), paused: e.target.checked } });
});

$('maxSteps').addEventListener('change', async e => {
  const limit = Math.min(Math.max(Number(e.target.value) || 30, 10), 100);
  e.target.value = limit;
  const o = await chrome.storage.local.get('ab_opts');
  await chrome.storage.local.set({ ab_opts: { ...(o.ab_opts || {}), maxSteps: limit } });
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ resetGuard: Date.now(), pend: {}, ab_seen: [] });
  $('err').textContent = '已重置计数、熔断与去重记忆';
});

$('injectPrompt').addEventListener('click', async () => {
  $('err').textContent = '正在注入协议…';
  const res = await chrome.runtime.sendMessage({ type: 'inject-prompt' }).catch(e => ({ ok: false, error: String(e) }));
  $('err').textContent = res && res.ok
    ? '已注入：去任务标签页输入框查看，补充任务后发送'
    : '失败：' + ((res && res.error) || '未知');
});

$('rotateToken').addEventListener('click', async () => {
  if (!confirm('确定轮换 Token？服务端旧 token 将立即失效，需要重新配对其他设备。')) return;
  $('err').textContent = '正在轮换…';
  const res = await chrome.runtime.sendMessage({ type: 'rotate-token' }).catch(e => ({ ok: false, error: String(e) }));
  if (res && res.ok) {
    await chrome.storage.local.set({ token: res.token });
    $('err').textContent = '已轮换，新 token 已写入 config.local.json 并更新到本扩展';
    refresh();
  } else {
    $('err').textContent = '轮换失败：' + ((res && res.error) || '未知');
  }
});

$('openHealth').addEventListener('click', () => {
  window.open(chrome.runtime.getURL('health.html'));
});

$('testConfirm').addEventListener('click', async () => {
  $('err').textContent = '已发送测试请求…';
  const res = await chrome.runtime.sendMessage({ type: 'test-confirm' }).catch(e => ({ ok: false, error: String(e) }));
  $('err').textContent = res && res.ok
    ? '已发送：去 chatgpt.com 标签页顶部看确认条'
    : '失败：' + ((res && res.error) || '未知');
});

refresh();
setInterval(refresh, 2000);
