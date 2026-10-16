const list = [
  __abChatgptAdapter,
  __abChatglmAdapter,
  __abDeepseekAdapter,
  __abKimiAdapter,
  __abDoubaoAdapter,
  __abGenericAdapter
].filter(Boolean);
var __AB_ADAPTER = list.find(a => a.matches(location.hostname)) || null;
