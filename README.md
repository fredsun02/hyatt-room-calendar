# Hyatt Room Calendar

A Chrome extension that checks a Hyatt hotel's room inventory, cash rates and points calendar by arrival date, up to a full year in one scan.

一个 Chrome 插件：一次查询某家 Hyatt 酒店最多一整年内、每个入住日期所有房型的剩余数量和现金价，以及积分日历。界面为英文。

## Features

- **Cash calendar.** Shows rooms left and the lowest cash rate for every room type and arrival date. Stays can be 1–7 nights.
- **Points calendar.** Shows the points tier and award availability for standard rooms, club rooms, suites and upgrades. A date's points rate is shown even when no award is available.
- **Room classification.**
  - ◆ **Standard room** appears only when Hyatt returns a standard room award plan for that room.
  - ★ **Standard suite** comes from Hyatt's suite-upgrade flag. With a standard suite selected, each date shows the suite's inventory next to the standard room points rate, for booking with a Suite Upgrade Award.
- **Saved results.** Results stay in your browser and are reused for 6 hours. You can export a CSV or a JSON backup.
- **Auto-resume (optional).** If Hyatt starts blocking requests, the extension saves your progress, clears Hyatt cookies, reloads the page and continues the scan.

## Install

1. Download `Hyatt-Room-Calendar-v1.1.2.zip` from [Releases](https://github.com/fredsun02/hyatt-room-calendar/releases/latest). Extract it to a folder you intend to keep. Alternatively, clone this repository.
2. Open `chrome://extensions/` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `hyatt-extension` folder.
4. Open a hotel's room-selection page on hyatt.com. Click **Room calendar** in the lower-left corner.

Requires Chrome 130 or later. The Quick Start ([text](Hyatt-Room-Calendar-Quick-Start.txt); open the `.html` version locally for the formatted guide) explains every control and color.

## Before you scan

- **Lower the speed for your first scan.** The form opens with 365 days, 3 parallel requests and no delay. Start with 31 days, 1 parallel request and a 2–3 second delay.
- **Auto-resume signs you out.** It clears Hyatt cookies. Consider scanning in an incognito window without signing in; to do that, enable **Allow in Incognito** on the extension's Details page.
- **A points rate does not guarantee an award room.** Award availability is checked for one-night stays.

## Privacy

Requests go directly to hyatt.com. Results stay in the extension's browser storage. There is no analytics and nothing is uploaded to third parties.

Settings include an option to connect to a local service at `127.0.0.1:8787`. It is off by default, and the service is not part of this repository.

## License

[MIT](LICENSE). Not affiliated with Hyatt.
