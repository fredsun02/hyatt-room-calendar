# Hyatt Room Calendar

Version 1.5.0 · English interface

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
- An italic number with a small dot was checked more than 6 hours ago; hover to see when. **Start scan** checks it again.
- **·** means not checked; **!** means the request failed.
- The **Points** tab shows award availability separately. A points price alone does not mean an award is available.
- **◆ Standard room** means a standard room award was found for that room in a sampled date.
- **★ Standard suite** comes from Hyatt’s suite upgrade flag.
- **Unconfirmed** means there is not enough evidence to classify the room. It may still qualify for a standard room award.

Room names come from Hyatt and follow the language returned by the site. The extension’s controls, dates, messages and documentation are in English.

Results are cached for 6 hours. A new scan checks missing or expired dates.

## Find a hotel

Type part of a hotel’s name, city or code in **Find hotel** and choose a result to fill in **Hotel code**. The first search downloads Hyatt’s hotel list from its Explore Hotels page, in the language of the current Hyatt page; the list is kept for 7 days. On a non-English page, English hotel names also match. Partner hotels such as Mr & Mrs Smith are not listed. If the list cannot be loaded, enter the five-character code instead.

## Compare hotels in a city

The **City** tab checks every hotel in a city for a few dates and shows them side by side.

1. Type a city, state or region, or a hotel name, in **City or area** and choose a result. A hotel name gives the hotels near it.
2. Optionally set **Nearby hotels** to add hotels within 5–50 km of the area’s center. Untick hotels you do not want.
3. Set **Start date**, **Days** (up to 31; 7 by default), **Nights** and **Adults**, then click **Start scan**.

Each row is a hotel and each column an arrival date. **Show** switches the grid:

- **Cash: lowest rate** shows the lowest standard rate for the stay and how many of that room are left. Green marks the lowest rate that night; ★ means a standard suite is available.
- **Cash: standard suites (points + SUA)** shows standard suites left with the standard room points for that night, for booking with a Suite Upgrade Award.
- **Points: …** shows the points rate for an award type, colored by tier; striped means no award is available.

Click a column heading to sort, a hotel’s name to open its calendar for the same dates, or a date to open Hyatt’s booking page. **Export CSV** saves every room type for the selected hotels and dates.

A city scan makes one request per hotel and date, plus two per hotel for points rates; the summary shows the estimate before you start. Results are shared with each hotel’s calendar, so dates you have already scanned, or that background collection has saved, are not requested again for 6 hours. **Auto-resume** works the same as for a single hotel and returns to the City tab after the reloads.

The City tab needs hotel coordinates, so it downloads Hyatt’s hotel list once if the saved list is from an earlier version. In a translated list, a city left in English is combined with its translated name, for example 京都 / Kyoto.

## Resume a scan

With **Auto-resume** enabled, blocked requests trigger a cookie reset after progress is saved. The page reloads twice, then scanning resumes. The second reload waits at least 5 seconds after the page loads; another navigation restarts the timer.

Click **Stop** to cancel the scan and automatic recovery. If two resets produce no new results, the scanner waits before retrying. Cookie resets may not resolve every block.

## Back up or import data

Use **Settings → Export backup** to save a JSON file. Stop active scans before importing a backup. Imports merge records by date, keeping newer results; they do not start a scan.

To move data from the userscript, update the existing script to 0.13.0 or later and export a backup from its calendar. Disable the userscript, then import the file in the extension’s settings.

If you already use `hryv-store`, enable **Connect to hryv-store** in Settings. Grant local access, reload a Hyatt tab and select a hotel to load its saved records. The service is optional; the extension works without it.

The same setting also reads data from a hryv-store server collector forwarded to `127.0.0.1:8787` through an SSH tunnel. The service and the collector are not part of the extension. Points calendars written by the collector are used for up to 36 hours without a new request; select **Refresh rates** to check Hyatt directly.

## Background collection

**Settings → Background collection** keeps points calendars and cash inventory fresh for a set of hotels while Chrome is open. It needs **Connect to hryv-store**, because results are saved there.

- A pinned Hyatt tab collects one request at a time through your own Hyatt session. Chrome does not discard the tab.
- Points calendars refresh daily. Cash dates refresh daily up to 30 days out, every 3 days up to 120 days and weekly after that. Missing data comes first.
- Collection pauses while you run a scan. When Hyatt blocks requests, it waits 5 minutes, doubling up to 2 hours. It never clears cookies.
- The tab reloads a random hotel page about every 45 minutes.
- To stop, turn collection off in Settings. Closing the pinned tab only pauses collection for five minutes.

Choose the hotels by country code (for example `CN,HK,MO,TW,JP`) and add individual hotel codes if needed. At one request every 5 seconds, collection makes about 17,000 requests a day; Hyatt's limits apply to your browsing at the same time.

## Storage and permissions

Results stay in the extension’s browser storage. Clearing Hyatt site data does not remove them. Normal and incognito windows share cached results but keep separate resume tasks. The hotel list is stored the same way and is not included in backups.

The extension uses:

- **cookies** and Hyatt site access to clear cookies in the requesting window’s cookie store, including HttpOnly and partitioned cookies.
- **storage** and **unlimitedStorage** to save hotel data and scan progress.
- **webNavigation** and **alarms** to coordinate reloads.
- Optional local access for `http://127.0.0.1:8787` when local backup is enabled.

Queries go directly to Hyatt. Cookie values are not included in backups or sent to the local service. No analytics or third-party upload service is included.

Not affiliated with Hyatt.
