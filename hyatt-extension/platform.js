(() => {
  if (window !== window.top || globalThis.__HRYV_PLATFORM) return;
  document.documentElement.setAttribute('data-hryv-extension', chrome.runtime.getManifest().version);
  const cache = Object.create(null), writes = new Map(), failures = new Map();
  const privateMode = chrome.extension.inIncognitoContext;
  const resumeKey = privateMode ? 'hryv:resume:private' : 'hryv:resume';
  const physicalKey = key => key === 'hryv:resume' ? resumeKey : key;
  const cacheKey = key => key === resumeKey ? 'hryv:resume' : key;
  const isVisible = key => key.startsWith('hryv:') && (!key.startsWith('hryv:resume') || key === resumeKey);
  const clone = value => value == null ? value : structuredClone(value);
  const send = message => chrome.runtime.sendMessage(message).catch(e => ({ ok: false, error: e.message }));

  function enqueue(key, task) {
    const next = (writes.get(key) || Promise.resolve()).then(task).then(() => {
      failures.delete(key); return true;
    }, e => { failures.set(key, e.message); return false; });
    writes.set(key, next);
    next.then(() => { if (writes.get(key) === next) writes.delete(key); });
    return next;
  }
  const storage = {
    get(key) { return clone(cache[key] ?? null); },
    set(key, value) {
      try {
        const snapshot = clone(value);
        cache[key] = snapshot;
        enqueue(key, () => chrome.storage.local.set({ [physicalKey(key)]: snapshot }));
        return true;
      } catch (e) { failures.set(key, e.message); return false; }
    },
    del(key) {
      delete cache[key];
      enqueue(key, () => chrome.storage.local.remove(physicalKey(key)));
    },
    async flush() {
      while (writes.size) await Promise.all([...writes.values()]);
      return failures.size === 0;
    },
    error() { return [...failures.values()].join('; '); },
    async snapshot() {
      if (!(await storage.flush())) throw new Error(storage.error());
      const all = await chrome.storage.local.get(null);
      return Object.fromEntries(Object.entries(all).filter(([key]) => isVisible(key)));
    },
  };
  const platform = globalThis.__HRYV_PLATFORM = {
    storage, remoteEnabled: false,
    ready: chrome.storage.local.get(null).then(all => {
      for (const [key, value] of Object.entries(all)) if (isVisible(key)) cache[cacheKey(key)] = value;
      platform.remoteEnabled = all['extension:local-store'] === true;
    }),
    helper(action, details = {}) { return send({ type: 'HRYV_HELPER', action, jobId: details.jobId }); },
    async remote(method, key, body) {
      if (!platform.remoteEnabled) return { ok: false };
      return send({ type: 'HRYV_STORE', method, key, body });
    },
    openSettings() { return send({ type: 'HRYV_SETTINGS' }); },
    onOpen(open) {
      chrome.runtime.onMessage.addListener((request, sender, respond) => {
        if (request?.type !== 'HRYV_OPEN' || sender.id !== chrome.runtime.id) return;
        open(); respond({ ok: true });
      });
    },
    showError(message) {
      const show = () => {
        const banner = document.createElement('div'); banner.textContent = 'Hyatt Room Calendar: ' + message;
        banner.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#fff1f1;color:#8b1b1b;padding:16px;border:1px solid #d55;max-width:420px';
        document.body.append(banner);
      };
      if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
    },
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('extension:local-store' in changes) platform.remoteEnabled = changes['extension:local-store'].newValue === true;
    for (const [key, change] of Object.entries(changes)) {
      if (!isVisible(key) || writes.has(cacheKey(key))) continue;
      if (change.newValue === undefined) delete cache[cacheKey(key)];
      else cache[cacheKey(key)] = clone(change.newValue);
    }
  });
})();
