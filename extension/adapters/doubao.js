var __abDoubaoAdapter = __abMakeHeuristicAdapter({
  id: 'doubao',
  matches: host => host === 'www.doubao.com' || host.endsWith('.doubao.com'),
  inputSelectors: ['textarea[data-testid="chat_text_input"]', '#flow-editor', 'textarea', '[contenteditable="true"]'],
  sendSelectors: ['button[data-testid*="send"]', 'button[aria-label*="发送"]', 'button[class*="send" i]', 'button[type="submit"]'],
  stopPattern: /停止生成|stop|停止/i
});
