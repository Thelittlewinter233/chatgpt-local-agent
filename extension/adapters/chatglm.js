var __abChatglmAdapter = __abMakeHeuristicAdapter({
  id: 'chatglm',
  matches: host => host === 'chatglm.cn' || host.endsWith('.chatglm.cn'),
  inputSelectors: ['textarea', '[contenteditable="true"]'],
  sendSelectors: ['button[class*="send" i]', 'button[aria-label*="发送"]', 'button[title*="发送"]', 'button[type="submit"]'],
  stopPattern: /停止|stop/i
});
