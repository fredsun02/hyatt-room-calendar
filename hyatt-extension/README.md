# Hyatt Room Calendar

Version 1.1.2 · English interface

View room availability and points rates on Hyatt.com.

## Install

Requires Chromium 130 or later. Tested in Chrome for Testing. Edge has not been tested separately.

1. Extract the ZIP to a folder you intend to keep.
2. Open `chrome://extensions/` (or `edge://extensions/`) and enable **Developer mode**.
3. Click **Load unpacked** and select the `hyatt-extension` folder containing `manifest.json`.
4. Reload your Hyatt tabs. Click **Room calendar** in the lower-left corner of a hotel page.

Disable the old Hyatt userscript and separate Cookie Helper if you have them installed. For incognito windows, enable **Allow in incognito** in this extension’s details.

## Update

Back up your data from **Settings → Export backup**. Replace the files in the existing extension folder, click **Reload** on the browser’s extensions page, then reload your Hyatt tabs.

Keep the same installation folder. Uninstalling the extension removes its saved data.

## Read the calendar

- The number is the room count available for the selected stay. Each date is an arrival date.
- Background color shows the standard room points tier for the arrival night.
- A striped, faded cell with **0** means no cash inventory was returned for that room.
- **·** means not checked; **!** means the request failed.
- The **Points** tab shows award availability separately. A points price alone does not mean an award is available.
- **◆ Standard room** means a standard room award was found for that room in a sampled date.
- **★ Standard suite** comes from Hyatt’s suite upgrade flag.
- **Unconfirmed** means there is not enough evidence to classify the room. It may still qualify for a standard room award.

Room names come from Hyatt and follow the language returned by the site. The extension’s controls, dates, messages and documentation are in English.

Results are cached for 6 hours. A new scan checks missing or expired dates.

## Resume a scan

With **Auto-resume** enabled, blocked requests trigger a cookie reset after progress is saved. The page reloads twice, then scanning resumes. The second reload waits at least 5 seconds after the page loads; another navigation restarts the timer.

Click **Stop** to cancel the scan and automatic recovery. If two resets produce no new results, the scanner waits before retrying. Cookie resets may not resolve every block.

## Back up or import data

Use **Settings → Export backup** to save a JSON file. Stop active scans before importing a backup. Imports merge records by date, keeping newer results; they do not start a scan.

To move data from the userscript, update the existing script to 0.13.0 or later and export a backup from its calendar. Disable the userscript, then import the file in the extension’s settings.

If you already use `hryv-store`, enable **Connect to hryv-store** in Settings. Grant local access, reload a Hyatt tab and select a hotel to load its saved records. The service is optional; the extension works without it.

## Storage and permissions

Results stay in the extension’s browser storage. Clearing Hyatt site data does not remove them. Normal and incognito windows share cached results but keep separate resume tasks.

The extension uses:

- **cookies** and Hyatt site access to clear cookies in the requesting window’s cookie store, including HttpOnly and partitioned cookies.
- **storage** and **unlimitedStorage** to save hotel data and scan progress.
- **webNavigation** and **alarms** to coordinate reloads.
- Optional local access for `http://127.0.0.1:8787` when local backup is enabled.

Queries go directly to Hyatt. Cookie values are not included in backups or sent to the local service. No analytics or third-party upload service is included.

Not affiliated with Hyatt.
