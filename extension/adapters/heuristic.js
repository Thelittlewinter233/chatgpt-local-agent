var __abMakeHeuristicAdapter = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s || '').replace(/\s+/g, '');
  const inputHasPending = el => norm((el.textContent || '') + (el.value || '')).includes('agent-result');

  function visible(el) {
    const rect = el.getBoundingClientRect();
    return !!(rect.width || rect.height) && getComputedStyle(el).visibility !== 'hidden';
  }

  return function (opts) {
    function findInput() {
      for (const sel of opts.inputSelectors || []) {
        const list = [...document.querySelectorAll(sel)].filter(visible);
        if (list.length) return list[list.length - 1];
      }
      return null;
    }

    function findSendButton() {
      const sels = opts.sendSelectors || ['button[class*="send" i]', 'button[aria-label*="发送"]', 'button[type="submit"]'];
      const list = [...document.querySelectorAll(sels.join(', '))].filter(visible);
      return list.length ? list[list.length - 1] : null;
    }

    return {
      id: opts.id,
      matches: opts.matches,
      isGenerating() {
        return !![...document.querySelectorAll('button')].find(b => {
          const mark = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
          return opts.stopPattern.test(mark) && visible(b);
        });
      },
      findInput,
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
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, (el.value || '') + text);
          else el.value = (el.value || '') + text;
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
          const btn = findSendButton();
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
  };
})();
