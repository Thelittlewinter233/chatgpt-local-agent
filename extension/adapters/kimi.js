window.__abKimiAdapter = window.__abMakeHeuristicAdapter({
  id: 'kimi',
  matches: host => host === 'www.kimi.com' || host.endsWith('.kimi.com') || host.endsWith('.moonshot.cn'),
  inputSelectors: ['#send-message-input', 'textarea', '[contenteditable="true"]'],
  sendSelectors: ['button[aria-label*="发送"]', 'button[class*="send" i]', '[class*="send-button"]', 'button[type="submit"]'],
  stopPattern: /stop|停止/i
});
