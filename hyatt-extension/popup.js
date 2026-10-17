document.querySelector('#version').textContent = 'v' + chrome.runtime.getManifest().version;
document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#open').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith('https://www.hyatt.com/')) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'HRYV_OPEN' }); window.close(); }
      catch { document.querySelector('#message').textContent = 'Reload this Hyatt tab, then open the calendar.'; }
    } else { await chrome.tabs.create({ url: 'https://www.hyatt.com/' }); window.close(); }
  } catch (e) { document.querySelector('#message').textContent = e.message; }
});
