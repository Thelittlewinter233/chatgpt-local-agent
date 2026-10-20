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
  refreshKa();
}

function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's前';
  if (s < 3600) return Math.round(s / 60) + '分前';
  return Math.round(s / 3600) + '小时前';
}

function ageShort(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
}

async function refreshKa() {
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].id != null) tabId = String(tabs[0].id);
  } catch { }
  const kaKey = 'ab_ka_' + (tabId || 'x');
  const tlKey = 'ab_dbg_timeline_' + (tabId || 'x');
  let o = {};
  try { o = await chrome.storage.local.get(null); } catch { }
  const ka = o[kaKey] || o.ab_ka_x;
  let tl = o[tlKey] || o.ab_dbg_timeline_x || [];
  let tlHost = '';
  if (!tl.length) {
    const candidates = Object.entries(o)
      .filter(([key, value]) => key.startsWith('ab_dbg_timeline_') && Array.isArray(value) && value.length)
      .map(([key, value]) => ({ key, value, ts: Math.max(...value.map(e => Number(e && e.ts) || 0)) }))
      .sort((a, b) => b.ts - a.ts);
    if (candidates.length) {
      tl = candidates[0].value;
      const suffix = candidates[0].key.slice('ab_dbg_timeline_'.length);
      const related = o['ab_ka_' + suffix];
      const latest = tl.reduce((a, b) => (Number(a && a.ts) || 0) >= (Number(b && b.ts) || 0) ? a : b, null);
      tlHost = (related && related.host) || (latest && latest.host) || ('tab ' + suffix);
    }
  }
  const driveRows = (Array.isArray(o.ab_drive_log) ? o.ab_drive_log : []).slice(-8).reverse();
  $('driveLog').textContent = driveRows.length
    ? 'Drive log\n' + driveRows.map(e => '-' + ageShort(Date.now() - (e.ts || 0)).padStart(4)
      + ' ' + e.name + (e.tabId != null ? ' tab' + e.tabId : '') + ' ' + String(e.out || '').slice(0, 90)).join('\n')
    : 'Drive log: no entries';
  const stateEl = $('kaState');
  if (!ka) {
    $('kaDot').className = 'dot';
    stateEl.textContent = tabId
      ? 'keepalive：无记录（标签页需重载扩展 + F5）'
      : 'keepalive：取不到当前标签';
  } else {
    const on = ka.state === 'connected';
    $('kaDot').className = 'dot ' + (on ? 'on' : 'off');
    stateEl.textContent = 'keepalive：' + (on ? '已连接' : String(ka.state))
      + (ka.code != null ? '（code ' + ka.code + '）' : '')
      + ' · ' + (ka.host || '?') + ' · ' + agoText(Date.now() - (ka.ts || 0))
      + (tabId ? ' · tab ' + tabId : '');
  }
  const rows = (Array.isArray(tl) ? tl : []).slice(-5).reverse();
  $('kaTimeline').textContent = rows.length
    ? (tlHost ? 'Timeline fallback [' + tlHost + ']\n' : '') + rows.map(e => '-' + ageShort(Date.now() - (e.ts || 0)).padStart(4)
      + ' ' + e.stage + (e.extra ? ' ' + String(e.extra).slice(0, 44) : '')).join('\n')
    : '无事件时间线';
  const sw = o.ab_sw;
  const dr = o.ab_drive;
  const bg = [];
  bg.push(sw && sw.stage
    ? 'SW   [' + agoText(Date.now() - (sw.ts || 0)) + '] ' + sw.stage
      + (sw.tabId != null ? ' tab' + sw.tabId : '')
      + (sw.extra ? ' ' + String(sw.extra).slice(0, 28) : '')
    : 'SW   无记录');
  bg.push(dr && dr.out
    ? '驱动 [' + agoText(Date.now() - (dr.ts || 0)) + '] tab' + dr.tabId + ' ' + String(dr.out).slice(0, 32)
    : '驱动 无记录');
  $('bgState').textContent = bg.join('\n');
}

function applyDiagCollapsed(collapsed) {
  $('diagBody').style.display = collapsed ? 'none' : 'block';
  $('diagArrow').textContent = collapsed ? '▸' : '▾';
}

$('diagHead').addEventListener('click', () => {
  const collapsed = $('diagBody').style.display !== 'none';
  localStorage.setItem('abDiagCollapsed', collapsed ? '1' : '0');
  applyDiagCollapsed(collapsed);
});

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
    ? '已注入协议到当前页面输入框，补充任务后发送'
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

async function refreshMini() {
  const res = await chrome.runtime.sendMessage({ type: 'mini-state' }).catch(e => ({ ok: false, error: String(e) }));
  if (!res || !res.ok) { $('miniState').textContent = ''; return; }
  $('miniState').textContent = res.isMini
    ? '当前 AI 标签已是小窗（后台全速）'
    : res.isAiSite
      ? '当前标签是 AI 站点（普通标签页，后台被节流）'
      : '';
}

$('miniPopout').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'mini-popout' }).catch(e => ({ ok: false, error: String(e) }));
  $('err').textContent = res && res.ok
    ? (res.already ? '已在小窗中，已聚焦该窗口' : '已弹出小窗：保持小窗可见（勿完全遮挡/最小化），后台全速执行')
    : '小窗失败：' + ((res && res.error) || '未知');
  refreshMini();
});

async function refreshMode() {
  const res = await chrome.runtime.sendMessage({ type: 'get-policy' }).catch(e => ({ ok: false, error: String(e) }));
  if (res && res.ok) {
    $('outOfRoots').checked = !!res.policy.allowOutOfRoots;
    $('modeState').textContent = res.policy.allowOutOfRoots
      ? '当前：完全放行（越界文件操作不再确认）'
      : '当前：确认后放行（越界文件操作弹确认条）';
  } else {
    $('modeState').textContent = '读取失败：' + ((res && res.error) || '未知');
  }
}

$('outOfRoots').addEventListener('change', async () => {
  const enable = $('outOfRoots').checked;
  if (enable && !confirm('开启完全批准模式？白名单外的文件写入/修改/移动将不再弹确认条，AI 可直接操作你电脑上的任意文本文件。')) {
    $('outOfRoots').checked = false;
    return;
  }
  $('modeState').textContent = '正在切换…';
  const res = await chrome.runtime.sendMessage({ type: 'set-policy', patch: { allowOutOfRoots: enable } }).catch(e => ({ ok: false, error: String(e) }));
  if (res && res.ok) {
    $('modeState').textContent = enable
      ? '当前：完全放行（越界文件操作不再确认）'
      : '当前：确认后放行（越界文件操作弹确认条）';
  } else {
    $('modeState').textContent = '切换失败：' + ((res && res.error) || '未知');
    refreshMode();
  }
});

refreshMode();

$('testConfirm').addEventListener('click', async () => {
  $('err').textContent = '已发送测试请求…';
  const res = await chrome.runtime.sendMessage({ type: 'test-confirm' }).catch(e => ({ ok: false, error: String(e) }));
  $('err').textContent = res && res.ok
    ? '已发送：去 chatgpt.com 标签页顶部看确认条'
    : '失败：' + ((res && res.error) || '未知');
});

async function refreshDomains() {
  const o = await chrome.storage.local.get(['ab_extra_domains', 'ab_domain_probe']);
  const extras = o.ab_extra_domains || [];
  const p = o.ab_domain_probe;
  let txt = '已追加域名：' + (extras.length ? extras.join(', ') : '无');
  if (p && p.at) {
    const age = Math.round((Date.now() - p.at) / 60000);
    txt += ' · 上次检测 ' + (age < 1 ? '刚刚' : age + ' 分钟前');
  }
  $('domainState').textContent = txt;
}

$('probeDomains').addEventListener('click', async () => {
  $('domainState').textContent = '正在逐站探测（后台短暂开标签页，最长约 2 分钟）…';
  const res = await chrome.runtime.sendMessage({ type: 'probe-site-domains' }).catch(e => ({ ok: false, error: String(e) }));
  if (res && res.ok) {
    const moved = res.report.results.filter(r => r.moved);
    $('domainState').textContent = '检测完成：' + (moved.length
      ? moved.map(r => r.id + ' 已迁移到 ' + r.final + '，已自动适配').join('；')
      : '所有站点域名未变');
  } else {
    $('domainState').textContent = '检测失败：' + ((res && res.error) || '未知');
  }
  refreshDomains();
});

$('addDomain').addEventListener('click', async () => {
  const host = $('extraDomain').value.trim();
  if (!host) return;
  try {
    if (chrome.permissions && chrome.permissions.request) {
      await chrome.permissions.request({ origins: ['https://' + host.toLowerCase() + '/*'] }).catch(() => { });
    }
  } catch { }
  const res = await chrome.runtime.sendMessage({ type: 'add-site-domain', host }).catch(e => ({ ok: false, error: String(e) }));
  $('extraDomain').value = '';
  $('err').textContent = res && res.ok ? '已添加域名并注入脚本：' + res.host : '失败：' + ((res && res.error) || '未知');
  refreshDomains();
});

refreshDomains();
refresh();
refreshMini();
applyDiagCollapsed(localStorage.getItem('abDiagCollapsed') !== '0');
setInterval(refresh, 2000);
setInterval(refreshMini, 5000);
