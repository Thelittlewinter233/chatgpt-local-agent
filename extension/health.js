const $ = id => document.getElementById(id);

$('check').addEventListener('click', async () => {
  $('state').textContent = '检测中…';
  $('out').textContent = '…';
  const res = await chrome.runtime.sendMessage({ type: 'health-check-proxy' }).catch(e => ({ ok: false, error: String(e) }));
  if (res && res.ok) {
    $('state').textContent = '活动标签 #' + res.tabId;
    $('out').textContent = JSON.stringify(res.data, null, 2);
  } else {
    $('state').textContent = '检测失败';
    $('out').textContent = (res && res.error) || '未知错误';
  }
});
