var __abGenericAdapter = __abMakeHeuristicAdapter({
  id: 'generic',
  matches: () => true,
  inputSelectors: ['textarea', '[contenteditable="true"]', '[role="textbox"]'],
  sendSelectors: ['button[class*="send" i]', 'button[aria-label*="发送"]', 'button[type="submit"]'],
  stopPattern: /stop|停止/i
});
