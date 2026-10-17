var __abQwenAdapter = __abMakeHeuristicAdapter({
  id: 'qwen',
  matches: host => host === 'tongyi.aliyun.com' || host.endsWith('.tongyi.com') || host === 'qianwen.com' || host.endsWith('.qianwen.com'),
  inputSelectors: ['[contenteditable="true"][class*="min-h-[24px]"]', '#chat-input', '#input-box', '[contenteditable="true"]', 'textarea'],
  sendSelectors: ['button[aria-label="发送消息"]', 'button[aria-label*="发送"]', '[class*="send-button"]', 'button[class*="send" i]', 'button[type="submit"]'],
  stopPattern: /stop|停止/i
});
