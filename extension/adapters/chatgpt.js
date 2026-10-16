var __abChatgptAdapter = (() => {
  const q = sel => document.querySelector(sel);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s || '').replace(/\s+/g, '');
  const inputHasPending = el => norm((el.textContent || '') + (el.value || '')).includes('agent-result');

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
      await sleep(250);
      if (inputHasPending(el)) return true;
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } catch { }
      await sleep(250);
      if (inputHasPending(el)) return true;
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
      const waitCleared = async () => {
        for (let t = 0; t < 12; t++) {
          await sleep(250);
          if (!inputHasPending(el)) return true;
        }
        return false;
      };
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
