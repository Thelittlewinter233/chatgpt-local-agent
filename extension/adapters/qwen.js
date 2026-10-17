var __abQwenAdapter = __abMakeHeuristicAdapter({
  id: 'qwen',
  matches: host => host === 'chat.qwen.ai' || host.endsWith('.qwen.ai') || host === 'tongyi.aliyun.com' || host.endsWith('.tongyi.com') || host === 'qianwen.com' || host.endsWith('.qianwen.com'),
  inputSelectors: ['.message-input-textarea', '#chat-input', '#input-box', '[contenteditable="true"]', 'textarea'],
  sendSelectors: ['button[aria-label*="发送"]', '[class*="send-button"]', 'button[class*="send" i]', 'button[type="submit"]'],
  stopPattern: /stop|停止/i
});
