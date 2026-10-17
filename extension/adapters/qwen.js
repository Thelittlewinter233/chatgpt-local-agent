var __abQwenAdapter = __abMakeHeuristicAdapter({
  id: 'qwen',
  matches: host => host === 'tongyi.aliyun.com' || host === 'www.tongyi.com' || host.endsWith('.tongyi.com'),
  inputSelectors: ['#chat-input', '#input-box', '[contenteditable="true"]', 'textarea'],
  sendSelectors: ['button[aria-label*="发送"]', '[class*="send-button"]', 'button[class*="send" i]', 'button[type="submit"]'],
  stopPattern: /stop|停止/i
});
