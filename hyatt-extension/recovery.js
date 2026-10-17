const activeStores = new Set();
const MIN_RESET_MS = 30000;
const RELOAD_TTL_MS = 120000;
const RELOAD_DELAY_MS = 5000;
const DOM_FALLBACK_MS = 15000;
const RELOAD_PREFIX = 'second-reload:';
const tabRequests = new Map();

function isHyattDomain(domain) {
  const host = domain.replace(/^\./, '').toLowerCase();
  return host === 'hyatt.com' || host.endsWith('.hyatt.com');
}

function isHyattPage(url) {
  try { return new URL(url).origin === 'https://www.hyatt.com'; } catch { return false; }
}

function enqueue(tabId, task) {
  const next = (tabRequests.get(tabId) || Promise.resolve()).then(task);
  const settled = next.catch(() => {});
  tabRequests.set(tabId, settled);
  settled.then(() => { if (tabRequests.get(tabId) === settled) tabRequests.delete(tabId); });
  return next;
}
const jobKey = tabId => RELOAD_PREFIX + tabId;
async function readJob(tabId) { return (await chrome.storage.session.get(jobKey(tabId)))[jobKey(tabId)]; }
async function cancelJob(tabId) {
  await chrome.storage.session.remove(jobKey(tabId));
  await chrome.alarms.clear(jobKey(tabId));
}
function dueAt(job) {
  if (job.phase !== 'waiting' || job.navigating) return job.ts + RELOAD_TTL_MS;
  return job.loadedAt ? job.loadedAt + RELOAD_DELAY_MS : job.domAt ? job.domAt + DOM_FALLBACK_MS : job.ts + RELOAD_TTL_MS;
}
async function saveJob(tabId, job) {
  await chrome.storage.session.set({ [jobKey(tabId)]: job });
  if (job.phase === 'failed') await chrome.alarms.clear(jobKey(tabId));
  else await chrome.alarms.create(jobKey(tabId), { when: Math.max(Date.now() + 1, Math.min(dueAt(job), job.ts + RELOAD_TTL_MS)) });
}
function jobStatus(job) {
  if (!job) return { ok: true, pending: false };
  if (job.phase === 'failed') return { ok: false, pending: true, error: job.error };
  return { ok: true, pending: true, jobId: job.id, phase: job.phase,
    remainingMs: job.loadedAt || job.domAt ? Math.max(0, dueAt(job) - Date.now()) : null };
}
async function failJob(tabId, job, error) {
  job.phase = 'failed'; job.error = error;
  await saveJob(tabId, job);
  return jobStatus(job);
}

async function finishReload(tabId) {
  const job = await readJob(tabId);
  if (!job || job.phase === 'failed') return jobStatus(job);
  if (Date.now() - job.ts >= RELOAD_TTL_MS) return failJob(tabId, job, 'Reload timed out. Progress is saved; reload the page to resume.');
  if (job.phase === 'issued') return jobStatus(job);
  let tab, frame;
  try {
    [tab, frame] = await Promise.all([chrome.tabs.get(tabId), chrome.webNavigation.getFrame({ tabId, frameId: 0 })]);
  } catch { await cancelJob(tabId); return { ok: true, pending: false }; }
  if (!isHyattPage(tab.url) || tab.incognito !== job.incognito || !frame || !isHyattPage(frame.url)) {
    await cancelJob(tabId); return { ok: true, pending: false };
  }
  if (frame.documentId !== job.documentId && frame.documentId !== job.fromDocumentId) {
    job.documentId = frame.documentId; job.domAt = 0; job.loadedAt = tab.status === 'complete' ? Date.now() : 0;
    job.navigating = false;
    await saveJob(tabId, job); return jobStatus(job);
  }
  if (!job.documentId || job.navigating || Date.now() < dueAt(job)) {
    await saveJob(tabId, job); return jobStatus(job);
  }
  if (tab.pendingUrl || (job.loadedAt && tab.status !== 'complete')) {
    job.navigating = true; job.loadedAt = 0; job.domAt = 0;
    await saveJob(tabId, job); return jobStatus(job);
  }
  job.phase = 'issued'; job.issuedFromDocumentId = frame.documentId;
  await saveJob(tabId, job);
  try {
    await chrome.tabs.reload(tabId);
    return { ok: true, reloaded: true, pending: true };
  } catch (e) { return failJob(tabId, job, 'Reload failed: ' + e.message); }
}

async function navigation(kind, event) {
  const tabId = event.tabId, job = await readJob(tabId);
  if (!job) return;
  if (!isHyattPage(event.url)) { await cancelJob(tabId); return; }
  if (kind === 'committed' && event.documentId !== (job.issuedFromDocumentId || job.documentId) &&
      (job.phase === 'issued' || job.phase === 'failed')) {
    await cancelJob(tabId); return;
  }
  if (job.phase !== 'waiting') return;
  if (kind === 'before') {
    job.navigating = true; job.loadedAt = 0; job.domAt = 0;
  } else {
    if (event.documentId === job.fromDocumentId) return;
    if (kind === 'committed') {
      if (event.documentId !== job.documentId) { job.documentId = event.documentId; job.loadedAt = 0; job.domAt = 0; }
      job.navigating = false;
    } else {
      if (event.documentId !== job.documentId || job.navigating) return;
      if (kind === 'dom' && !job.domAt) job.domAt = Date.now();
      if (kind === 'complete' && !job.loadedAt) job.loadedAt = Date.now();
    }
  }
  await saveJob(tabId, job);
}

for (const [event, kind] of [['onBeforeNavigate', 'before'], ['onCommitted', 'committed'],
  ['onDOMContentLoaded', 'dom'], ['onCompleted', 'complete']]) {
  chrome.webNavigation[event].addListener(details => {
    if (details.frameId !== 0 || (details.documentLifecycle && details.documentLifecycle !== 'active')) return;
    return enqueue(details.tabId, () => navigation(kind, details)).catch(() => {});
  });
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith(RELOAD_PREFIX)) return;
  const tabId = Number(alarm.name.slice(RELOAD_PREFIX.length));
  return enqueue(tabId, () => finishReload(tabId)).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => enqueue(tabId, () => cancelJob(tabId)).catch(() => {}));
chrome.storage.session.get(null).then(all => Promise.all(Object.keys(all).filter(k => k.startsWith(RELOAD_PREFIX)).map(key => {
  const tabId = Number(key.slice(RELOAD_PREFIX.length));
  return enqueue(tabId, async () => { const job = await readJob(tabId); if (job) await saveJob(tabId, job); });
}))).catch(() => {});

async function handle(request, sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab ||
      new URL(sender.url).origin !== 'https://www.hyatt.com') throw new Error('Unsupported page');
  if (request.action === 'ping') return { ok: true, version: chrome.runtime.getManifest().version, doubleReload: true,
    afterLoadDelayMs: RELOAD_DELAY_MS, backgroundReload: true };
  if (!['reset', 'reload-status', 'reload-finish', 'reload-cancel'].includes(request.action)) throw new Error('Unsupported action');

  const tab = await chrome.tabs.get(sender.tab.id);
  if (new URL(tab.url).origin !== 'https://www.hyatt.com' || tab.incognito !== sender.tab.incognito) {
    throw new Error('The tab has navigated away. Cookie reset cancelled.');
  }
  if (request.action === 'reload-cancel') {
    await cancelJob(tab.id);
    return { ok: true };
  }
  if (request.action.startsWith('reload-')) {
    const job = await readJob(tab.id);
    if (!job) return { ok: true, pending: false };
    if (sender.documentId === job.fromDocumentId && !job.documentId) return { ok: true, pending: false };
    if (request.action === 'reload-status') return jobStatus(job);
    if (request.jobId !== job.id || sender.documentId !== job.documentId) throw new Error('Reload task is no longer active');
    return finishReload(tab.id);
  }
  if (!sender.documentId) throw new Error('Could not identify this page. Update your browser.');
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(s => s.tabIds.includes(tab.id));
  if (!store) throw new Error('Could not find the cookie store for this window');
  if (activeStores.has(store.id)) throw new Error('A cookie reset is already in progress');
  activeStores.add(store.id);
  try {
    const key = 'last-reset:' + store.id;
    const last = (await chrome.storage.session.get(key))[key] || 0;
    if (Date.now() - last < MIN_RESET_MS) throw new Error('Wait at least 30 seconds between cookie resets.');
    await chrome.storage.session.set({ [key]: Date.now() });
    const cookies = await chrome.cookies.getAll({ domain: 'hyatt.com', storeId: store.id, partitionKey: {} });
    let removed = 0;
    for (const cookie of cookies.sort((a, b) => b.path.length - a.path.length)) {
      if (!isHyattDomain(cookie.domain) || cookie.storeId !== store.id) continue;
      const details = {
        url: 'https://' + cookie.domain.replace(/^\./, '') + cookie.path,
        name: cookie.name, storeId: store.id,
      };
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      if (await chrome.cookies.remove(details)) removed++;
    }
    await saveJob(tab.id, { id: crypto.randomUUID(), ts: Date.now(), fromDocumentId: sender.documentId,
      phase: 'waiting', incognito: tab.incognito, navigating: false, domAt: 0, loadedAt: 0 });
    return { ok: true, removed };
  } finally { activeStores.delete(store.id); }
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!request || request.type !== 'HRYV_HELPER') return;
  enqueue(sender.tab?.id, () => handle(request, sender)).then(respond, e => respond({ ok: false, error: e.message }));
  return true;
});
