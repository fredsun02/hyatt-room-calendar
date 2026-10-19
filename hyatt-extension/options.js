import { isBackupKey, validateBackup, mergeBackup } from './backup.mjs';
import { COLLECTOR_SETTINGS, COLLECTOR_STATUS, COLLECTOR_DEFAULTS } from './collector-settings.mjs';
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

const $ = id => document.querySelector('#' + id);
const collectorFields = { enabled: $('collector-enabled'), countries: $('collector-countries'), hotels: $('collector-hotels'),
  interval: $('collector-interval'), horizon: $('collector-horizon') };
const codes = value => value.split(/[\s,，、]+/).map(x => x.trim()).filter(Boolean);
async function collectorSettings() {
  return { ...COLLECTOR_DEFAULTS, ...((await chrome.storage.local.get(COLLECTOR_SETTINGS))[COLLECTOR_SETTINGS] || {}) };
}
function showCollectorStatus(st) {
  const el = $('collector-status');
  if (!st) { el.textContent = 'Not running.'; return; }
  const time = ms => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const pair = (label, v) => Array.isArray(v) ? `${label} ${v[0]}/${v[1]}` : '';
  const parts = [st.message, st.hotels != null && `${st.hotels} hotels`,
    st.requestsLast24h != null && `${st.requestsLast24h} requests in the last 24 hours`,
    pair('cash dates up to date', st.cashUpToDate), pair('points calendars', st.pointsUpToDate),
    st.updatedAt && `updated ${time(st.updatedAt)}`];
  el.textContent = parts.filter(Boolean).join(' · ');
}
async function loadCollector() {
  const s = await collectorSettings();
  collectorFields.enabled.checked = s.enabled;
  collectorFields.countries.value = s.countries.join(',');
  collectorFields.hotels.value = s.hotels.join(', ');
  collectorFields.interval.value = s.interval;
  collectorFields.horizon.value = s.horizon;
  showCollectorStatus((await chrome.storage.local.get(COLLECTOR_STATUS))[COLLECTOR_STATUS]);
}
function readCollectorFields() {
  const countries = codes(collectorFields.countries.value).map(c => c.toUpperCase());
  const hotels = codes(collectorFields.hotels.value).map(c => c.toLowerCase());
  const interval = Number(collectorFields.interval.value), horizon = Number(collectorFields.horizon.value);
  if (countries.some(c => !/^[A-Z]{2}(-[A-Z0-9]{1,4})?$/.test(c))) throw new Error('Enter countries as two-letter codes, such as CN,JP, or sub-regions such as CN-ML.');
  if (hotels.some(c => !/^[a-z0-9]{5}$/.test(c))) throw new Error('Hotel codes have five letters or numbers.');
  if (!countries.length && !hotels.length) throw new Error('Enter at least one country or hotel code.');
  if (!(interval >= 2 && interval <= 60)) throw new Error('Seconds per request must be between 2 and 60.');
  if (!(horizon >= 7 && horizon <= 400)) throw new Error('Days ahead must be between 7 and 400.');
  return { countries, hotels, interval, horizon };
}
async function saveCollector() {
  const enabled = collectorFields.enabled.checked;
  const current = await collectorSettings();
  let fields;
  try { fields = readCollectorFields(); } catch (e) {
    if (enabled) { collectorFields.enabled.checked = current.enabled; message(e.message, true); return; }
    // Turning collection off always works, even when another field is invalid.
    await chrome.storage.local.set({ [COLLECTOR_SETTINGS]: { ...current, enabled: false } });
    message(`Background collection is off. Other settings were not saved: ${e.message}`, true);
    return;
  }
  if (enabled && !localStore.checked) {
    collectorFields.enabled.checked = current.enabled;
    message('Turn on Connect to hryv-store first; collected results are saved there.', true);
    return;
  }
  await chrome.storage.local.set({ [COLLECTOR_SETTINGS]: { ...current, ...fields, enabled } });
  message(enabled ? 'Background collection is on. A pinned Hyatt tab will open.' : 'Background collection is off. Settings saved.');
}
collectorFields.enabled.addEventListener('change', saveCollector);
$('collector-save').addEventListener('click', saveCollector);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && COLLECTOR_STATUS in changes) showCollectorStatus(changes[COLLECTOR_STATUS].newValue);
});
await loadCollector();
