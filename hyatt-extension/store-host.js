const ORIGINS = { origins: ['http://127.0.0.1/*'] };
const KEY = /^hryv:[a-z0-9|:_-]{1,80}$/i;
function trustedPage(sender) {
  try {
    return sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab &&
      new URL(sender.url).origin === 'https://www.hyatt.com';
  } catch { return false; }
}
async function localStore(request, sender) {
  if (!trustedPage(sender)) return { ok: false, error: 'Unsupported page' };
  const { method, key, body } = request;
  if (!['GET', 'PUT', 'DELETE'].includes(method) ||
      (key != null ? typeof key !== 'string' || !KEY.test(key) : method !== 'GET')) {
    return { ok: false, error: 'Unsupported storage operation' };
  }
  const enabled = (await chrome.storage.local.get('extension:local-store'))['extension:local-store'];
  if (!enabled || !(await chrome.permissions.contains(ORIGINS))) return { ok: false };
  const payload = method === 'PUT' ? JSON.stringify(body) : undefined;
  if (method === 'PUT' && (!payload || new TextEncoder().encode(payload).length > 8 * 1024 * 1024)) return { ok: false, error: 'Data is empty or exceeds the size limit' };
  const response = await fetch('http://127.0.0.1:8787' + (key ? '/kv/' + encodeURIComponent(key) : '/health'), {
    method, headers: { 'X-HRYV': '1', 'Content-Type': 'application/json' }, body: payload,
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(4000),
  });
  let data = null;
  try { data = await response.json(); } catch { /* ignore */ }
  return { ok: response.ok, status: response.status, data };
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request?.type === 'HRYV_SETTINGS') {
    if (!trustedPage(sender)) { respond({ ok: false }); return; }
    chrome.runtime.openOptionsPage().then(() => respond({ ok: true }), e => respond({ ok: false, error: e.message }));
    return true;
  }
  if (request?.type !== 'HRYV_STORE') return;
  localStore(request, sender).then(respond, e => respond({ ok: false, error: e.message }));
  return true;
});
