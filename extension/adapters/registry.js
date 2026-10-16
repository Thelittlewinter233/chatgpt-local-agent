(() => {
  const list = [
    window.__abChatgptAdapter,
    window.__abChatglmAdapter,
    window.__abDeepseekAdapter,
    window.__abKimiAdapter,
    window.__abDoubaoAdapter
  ].filter(Boolean);
  window.__AB_ADAPTER = list.find(a => a.matches(location.hostname)) || null;
})();
