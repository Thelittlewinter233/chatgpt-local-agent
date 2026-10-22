(() => {
  try {
    const state = { mutations: 0, addedNodes: 0, rafQueued: 0, rafExecuted: 0, hidreads: 0 };
    const nativeRaf = window.requestAnimationFrame;
    const visibility = () => document.visibilityState;

    if (typeof nativeRaf === 'function') {
      window.requestAnimationFrame = function(callback) {
        const hiddenAtQueue = visibility() === 'hidden';
        if (hiddenAtQueue) state.rafQueued += 1;
        if (typeof callback !== 'function') return nativeRaf.call(this, callback);
        return nativeRaf.call(this, function(...args) {
          if (hiddenAtQueue) state.rafExecuted += 1;
          return callback.apply(window, args);
        });
      };
    }

    try {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      if (descriptor && typeof descriptor.get === 'function' && descriptor.configurable) {
        Object.defineProperty(Document.prototype, 'hidden', {
          ...descriptor,
          get() {
            state.hidreads += 1;
            return descriptor.get.call(this);
          }
        });
      }
    } catch { }

    const observeBody = () => {
      try {
        if (!document.body || typeof MutationObserver !== 'function') return false;
        const observer = new MutationObserver(records => {
          if (visibility() !== 'hidden') return;
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
