window.__abDeepseekAdapter = window.__abMakeHeuristicAdapter({
  id: 'deepseek',
  matches: host => host === 'chat.deepseek.com' || host.endsWith('.deepseek.com'),
  inputSelectors: ['#chat-input', 'textarea', '[contenteditable="true"]'],
  sendSelectors: ['div[role="button"][aria-label*="发送"]', 'button[aria-label*="发送"]', 'button[class*="send" i]', '[class*="send-button"]', 'button[type="submit"]'],
  stopPattern: /stop|停止/i
});
