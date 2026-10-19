// Background collection: keeps one pinned Hyatt tab open while it is enabled in Settings, tells
// collector.js whether it runs in that tab, and provides its timer. Chrome throttles timers in hidden
// tabs to about once a minute; timers here are not throttled.
import { COLLECTOR_SETTINGS as SETTINGS, COLLECTOR_DEFAULTS } from './collector-settings.mjs';
const TAB = 'collector:tab';
const REOPEN = 'collector:reopen';
const WATCHDOG = 'collector:watchdog';
const HEARTBEAT = 'collector:heartbeat';
const STALE_MS = 10 * 60000;
const START_URL = 'https://www.hyatt.com/';
const isHyatt = url => { try { return new URL(url).origin === 'https://www.hyatt.com'; } catch { return false; } };

async function settings() {
  return { ...COLLECTOR_DEFAULTS, ...((await chrome.storage.local.get(SETTINGS))[SETTINGS] || {}) };
}
async function storedTab() {
  const id = (await chrome.storage.session.get(TAB))[TAB];
  if (!id) return null;
  try { return await chrome.tabs.get(id); } catch { return null; }
}

// reason: 'start' (service worker start), 'settings', 'reopen', 'watchdog', 'browser'.
let syncing = Promise.resolve();
function sync(reason) {
  syncing = syncing.then(async () => {
    const s = await settings();
    let tab = await storedTab();
    if (!s.enabled) {
      await chrome.alarms.clear(REOPEN);
      await chrome.alarms.clear(WATCHDOG);
      if (tab) { await chrome.storage.session.remove(TAB); await chrome.tabs.remove(tab.id).catch(() => {}); }
      return;
    }
    if (!(await chrome.alarms.get(WATCHDOG))) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 5 });
    if (!tab) {
      // After a browser restart or an extension update the stored id is gone: adopt the pinned Hyatt tab.
      const [pinned] = await chrome.tabs.query({ pinned: true, url: 'https://www.hyatt.com/*' });
      if (pinned) {
        tab = pinned;
        await chrome.storage.session.set({ [TAB]: tab.id });
        await chrome.tabs.reload(tab.id).catch(() => {});
      }
    }
    if (!tab) {
      // A tab the user closed comes back on the REOPEN alarm, not whenever the service worker wakes.
      if (reason === 'start' && await chrome.alarms.get(REOPEN)) return;
      await chrome.alarms.clear(REOPEN);
      tab = await chrome.tabs.create({ url: START_URL, pinned: true, active: false });
      await chrome.storage.session.set({ [TAB]: tab.id });
      await chrome.storage.local.set({ [HEARTBEAT]: Date.now() });
    }
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    if (reason === 'watchdog') {
      // The collector writes a heartbeat at least every minute; a failed load or a tab moved to another
      // site leaves it silent, so the tab is sent back to Hyatt.
      const beat = (await chrome.storage.local.get(HEARTBEAT))[HEARTBEAT] || 0;
      if (!isHyatt(tab.url) || Date.now() - beat > STALE_MS) {
        await chrome.storage.local.set({ [HEARTBEAT]: Date.now() });
        await chrome.tabs.update(tab.id, { url: START_URL }).catch(() => {});
      }
    }
  }).catch(() => {});
  return syncing;
}

function trustedPage(sender) {
  try {
    return sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab &&
      new URL(sender.url).origin === 'https://www.hyatt.com';
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request?.type !== 'HRYV_COLLECTOR' || !trustedPage(sender)) return;
  if (request.action === 'sleep') {
    setTimeout(() => respond(true), Math.max(0, Math.min(Number(request.ms) || 0, 240000)));
    return true;
  }
  if (request.action === 'hello') {
    (async () => {
      const s = await settings(), id = (await chrome.storage.session.get(TAB))[TAB];
      respond({ active: s.enabled && id === sender.tab.id, settings: s });
    })();
    return true;
  }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && SETTINGS in changes) sync('settings'); });
chrome.tabs.onRemoved.addListener(async tabId => {
  if ((await chrome.storage.session.get(TAB))[TAB] !== tabId) return;
  await chrome.storage.session.remove(TAB);
  // A closed collector tab comes back after five minutes; turn collection off in Settings to stop it.
  if ((await settings()).enabled) chrome.alarms.create(REOPEN, { delayInMinutes: 5 });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === REOPEN) sync('reopen');
  if (alarm.name === WATCHDOG) sync('watchdog');
});
chrome.runtime.onStartup.addListener(() => sync('browser'));
chrome.runtime.onInstalled.addListener(() => sync('browser'));
sync('start');
