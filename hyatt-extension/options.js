import { isBackupKey, validateBackup, mergeBackup } from './backup.mjs';
const status = document.querySelector('#status');
const message = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
const origins = { origins: ['http://127.0.0.1/*'] };
document.querySelector('#version').textContent = 'v' + chrome.runtime.getManifest().version;
document.querySelector('#open').addEventListener('click', () => chrome.tabs.create({ url: 'https://www.hyatt.com/' }));
const localStore = document.querySelector('#local-store');
localStore.checked = (await chrome.storage.local.get('extension:local-store'))['extension:local-store'] === true;
localStore.addEventListener('change', async () => {
  localStore.disabled = true;
  try {
    if (localStore.checked && !(await chrome.permissions.request(origins))) {
      localStore.checked = false; message('Local access was not granted. Results will stay in this browser.'); return;
    }
    await chrome.storage.local.set({ 'extension:local-store': localStore.checked });
    message(localStore.checked ? 'Local backup enabled. Reload your Hyatt tabs.' : 'Local backup disabled. Results will stay in this browser.');
  } catch (e) { localStore.checked = !localStore.checked; message(e.message, true); }
  finally { localStore.disabled = false; }
});
document.querySelector('#export').addEventListener('click', async () => {
  try {
    const entries = Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([key]) => isBackupKey(key)));
    const data = { format: 'hryv-backup', version: 1, exportedAt: new Date().toISOString(), entries };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'hyatt-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    message(`Exported ${Object.keys(entries).length} entries.`);
  } catch (e) { message('Export failed: ' + e.message, true); }
});
document.querySelector('#import').addEventListener('change', async event => {
  const input = event.target, file = input.files[0];
  if (!file) return;
  input.disabled = true;
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('Backup exceeds 32 MB');
    const incoming = validateBackup(JSON.parse(await file.text()));
    const current = await chrome.storage.local.get(null);
    const fresh = r => r && Number.isFinite(r.ts) && Date.now() - r.ts < 24 * 3600000;
    if (fresh(current['hryv:resume']) || fresh(current['hryv:resume:private'])) throw new Error('Stop any active or paused scans before importing, including those in incognito windows.');
    await chrome.storage.local.set(mergeBackup(current, incoming));
    message(`Imported ${Object.keys(incoming).length} entries. Reload your Hyatt tabs.`);
  } catch (e) { message('Import failed: ' + e.message, true); }
  finally { input.value = ''; input.disabled = false; }
});
