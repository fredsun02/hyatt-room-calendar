# Hyatt Room Calendar

A Chrome extension that checks a Hyatt hotel's room inventory, cash rates and points calendar by arrival date, up to a full year in one scan, or compares every hotel in a city for a few dates.

一个 Chrome 插件：一次查询某家 Hyatt 酒店最多一整年内、每个入住日期所有房型的剩余数量和现金价，以及积分日历；也可以一次横向比较一个城市所有酒店几天内的价格。界面为英文。

## Features

- **Find hotel.** Type part of a hotel's name, city or code and pick a result to fill in the hotel code. On a Chinese Hyatt page, both Chinese and English names match. The hotel list is downloaded on your first search and kept for 7 days.
- **Cash calendar.** Shows rooms left and the lowest cash rate for every room type and arrival date. Stays can be 1–7 nights.
- **Points calendar.** Shows the points tier and award availability for standard rooms, club rooms, suites and upgrades. A date's points rate is shown even when no award is available.
- **City comparison.** The City tab scans every hotel in a city, state or region, or near a hotel, for up to 31 arrival dates and shows them side by side: the lowest cash rate (with the lowest each night highlighted), standard suites with the standard room points for a Suite Upgrade Award, or any award type. Optionally add hotels within 5–50 km.
- **Room classification.**
  - ◆ **Standard room** appears only when Hyatt returns a standard room award plan for that room.
  - ★ **Standard suite** comes from Hyatt's suite-upgrade flag. With a standard suite selected, each date shows the suite's inventory next to the standard room points rate, for booking with a Suite Upgrade Award.
- **Saved results.** Results stay in your browser and are reused for 6 hours; results older than that stay visible, marked as older. The single-hotel and city views share them. You can export a CSV or a JSON backup.
- **Auto-resume (optional).** If Hyatt starts blocking requests, the extension saves your progress, clears Hyatt cookies, reloads the page and continues the scan.

## Install

1. Download the ZIP from the [latest release](https://github.com/fredsun02/hyatt-room-calendar/releases/latest). Extract it to a folder you intend to keep. Alternatively, clone this repository.
2. Open `chrome://extensions/` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `hyatt-extension` folder.
4. Open any page on hyatt.com, ideally a hotel's room-selection page. Click **Room calendar** in the lower-left corner, then use **Find hotel** or the hotel code filled in from the page.

Requires Chrome 130 or later. The Quick Start ([text](Hyatt-Room-Calendar-Quick-Start.txt); open the `.html` version locally for the formatted guide) explains every control and color.

## Before you scan

- **Lower the speed for your first scan.** The form opens with 365 days, 3 parallel requests and no delay. Start with 31 days, 1 parallel request and a 2–3 second delay.
- **Auto-resume signs you out.** It clears Hyatt cookies. Consider scanning in an incognito window without signing in; to do that, enable **Allow in Incognito** on the extension's Details page.
- **A points rate does not guarantee an award room.** Award availability is checked for one-night stays.
- **City scans add up.** A city scan makes one request per hotel and date, plus two per hotel for points rates; the summary shows the estimate before you start.

## Privacy

Requests go directly to hyatt.com. Results stay in the extension's browser storage. There is no analytics and nothing is uploaded to third parties.

Settings include an option to connect to a local service at `127.0.0.1:8787`, and a background collection mode that saves results to that service. Both are off by default, and the service is not part of this repository.

## License

[MIT](LICENSE). Not affiliated with Hyatt.
