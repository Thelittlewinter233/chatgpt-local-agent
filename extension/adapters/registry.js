(() => {
  const list = [window.__abChatgptAdapter, window.__abChatglmAdapter].filter(Boolean);
  window.__AB_ADAPTER = list.find(a => a.matches(location.hostname)) || null;
})();
