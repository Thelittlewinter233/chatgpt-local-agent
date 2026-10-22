(() => {
  try {
    const state = { mutations: 0, addedNodes: 0, rafQueued: 0, rafExecuted: 0, hidreads: 0 };
    const nativeRaf = window.requestAnimationFrame;
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    const webkitHiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitHidden');
    const webkitVisibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitVisibilityState');
    const realHidden = () => Boolean(hiddenDescriptor && typeof hiddenDescriptor.get === 'function' ? hiddenDescriptor.get.call(document) : document.hidden);
    const realVisibility = () => String(visibilityDescriptor && typeof visibilityDescriptor.get === 'function' ? visibilityDescriptor.get.call(document) : document.visibilityState);
    const defineSpoof = (descriptor, value) => {
      if (!descriptor || typeof descriptor.get !== 'function' || !descriptor.configurable) return;
      Object.defineProperty(Document.prototype, descriptor === hiddenDescriptor ? 'hidden' : descriptor === visibilityDescriptor ? 'visibilityState' : descriptor === webkitHiddenDescriptor ? 'webkitHidden' : 'webkitVisibilityState', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => value
      });
    };

    defineSpoof(hiddenDescriptor, false);
    defineSpoof(visibilityDescriptor, 'visible');
    defineSpoof(webkitHiddenDescriptor, false);
    defineSpoof(webkitVisibilityDescriptor, 'visible');

    let syntheticEvent = false;
    document.addEventListener('visibilitychange', event => {
      if (syntheticEvent) return;
      event.stopImmediatePropagation();
      event.stopPropagation();
    }, { capture: true });

    if (realHidden()) {
      const announceVisible = () => {
        try {
          syntheticEvent = true;
          document.dispatchEvent(new Event('visibilitychange'));
        } catch { } finally {
          syntheticEvent = false;
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.setTimeout(announceVisible, 0), { once: true });
      else window.setTimeout(announceVisible, 0);
    }

    if (typeof nativeRaf === 'function') {
      window.requestAnimationFrame = function(callback) {
        const hiddenAtQueue = realHidden();
        if (hiddenAtQueue) state.rafQueued += 1;
        if (typeof callback !== 'function') return nativeRaf.call(this, callback);
        return nativeRaf.call(this, function(...args) {
          if (hiddenAtQueue) state.rafExecuted += 1;
          return callback.apply(window, args);
        });
      };
    }

    try {
      if (hiddenDescriptor && typeof hiddenDescriptor.get === 'function' && hiddenDescriptor.configurable) {
        Object.defineProperty(Document.prototype, 'hidden', {
          configurable: true,
          enumerable: hiddenDescriptor.enumerable,
          get() {
            state.hidreads += 1;
            return false;
          }
        });
      }
    } catch { }

    const observeBody = () => {
      try {
        if (!document.body || typeof MutationObserver !== 'function') return false;
        const observer = new MutationObserver(records => {
          if (!realHidden()) return;
          state.mutations += 1;
          for (const record of records) state.addedNodes += record.addedNodes ? record.addedNodes.length : 0;
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return true;
      } catch { return false; }
    };

    if (!observeBody()) document.addEventListener('DOMContentLoaded', observeBody, { once: true });

    window.setInterval(() => {
      try {
        window.dispatchEvent(new CustomEvent('ab-probe', { detail: { ...state } }));
        state.mutations = 0;
        state.addedNodes = 0;
        state.rafQueued = 0;
        state.rafExecuted = 0;
        state.hidreads = 0;
      } catch { }
    }, 5000);
  } catch { }
})();
