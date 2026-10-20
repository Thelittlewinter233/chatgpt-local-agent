var __abChatgptAdapter = (() => {
  const q = sel => document.querySelector(sel);
  const norm = s => String(s || '').replace(/\s+/g, '');
  const inputHasPending = el => norm((el.textContent || '') + (el.value || '')).includes('agent-result');

  function settled(test, ms, el) {
    return new Promise(resolve => {
      if (test()) { resolve(true); return; }
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        try { mo.disconnect(); } catch { }
        if (el) { try { el.removeEventListener('input', onEv); el.removeEventListener('change', onEv); } catch { } }
        clearTimeout(timer);
        resolve(v);
      };
      const onEv = () => { if (test()) finish(true); };
      const mo = new MutationObserver(onEv);
      try { mo.observe(el, { subtree: true, childList: true, characterData: true }); } catch { }
      if (el) { try { el.addEventListener('input', onEv); el.addEventListener('change', onEv); } catch { } }
      const timer = setTimeout(() => finish(test()), ms);
    });
  }

  return {
    id: 'chatgpt',
    matches: host => host === 'chatgpt.com' || host.endsWith('.chatgpt.com'),
    isGenerating() {
      return !!(q('[data-testid="stop-button"]') || q('button[aria-label*="stop" i]'));
    },
    findInput() {
      return q('#prompt-textarea') || q('div[contenteditable="true"].ProseMirror');
    },
    async insertText(text) {
      const el = this.findInput();
      if (!el) return false;
      if (inputHasPending(el)) {
        const cur = norm((el.textContent || '') + (el.value || ''));
        if (cur === norm(text)) return true;
        return false;
      }
      el.focus();
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch { }
      if (await settled(() => inputHasPending(el), 250, el)) return true;
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } catch { }
      if (await settled(() => inputHasPending(el), 250, el)) return true;
      if (el.tagName === 'TEXTAREA') {
        el.value = (el.value || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    },
    async send() {
      const el = this.findInput();
      if (!el) return false;
      const waitCleared = () => settled(() => !inputHasPending(el), 3000, el);
      for (let i = 0; i < 2; i++) {
        const btn = q('[data-testid="send-button"]') || q('button[aria-label*="send" i]') || q('button[aria-label*="发送" i]');
        if (btn && !btn.disabled) {
          btn.click();
        } else {
          el.focus();
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
        if (await waitCleared()) return true;
      }
      return false;
    }
  };
})();
