# Hijri month starts — Khamenei (Lebanon) · Sistani · Fadlallah

`month-starts.json` lists the first Gregorian day of each Hijri month as announced by three marjaa
offices. The Mawaqit (prayer-times-lb) app downloads it every time it opens:

```
https://raw.githubusercontent.com/MJFneish/hijri-month-starts/main/month-starts.json
```

```json
{
  "version": 1,
  "updatedAt": "2026-10-20T12:00:00Z",
  "monthStarts": { "khamenei": { "1448-05": "2026-10-13" }, "sistani": { … }, "fadlallah": { … } },
  "sources":     { "khamenei": { "1448-05": "t.me/leader_lb_channel/2322" }, … }
}
```

`"1448-05"` is Jumada al-Ula 1448. The app ignores `sources`; it's there for whoever checks a date.
For months not listed here, the app predicts from the Moon's position, so the file only needs
announced dates.

## Where each date comes from

`update.mjs` (run by `.github/workflows/update.yml`) reads:

| Marjaa | Primary | Cross-check |
|---|---|---|
| Khamenei: the Lebanon office of his legal representative | Its «استهلال» post on t.me/leader_lb_channel, on the evening of the 29th. The decision is in the image, which is OCR'd: «لم تثبت» / «المتمم» = 30 days, otherwise the month starts the next day | Next morning, the Hijri date in almanar.com.lb's header |
| Sistani (Najaf) | The office's statement as posted by the Imam Hussain shrine (t.me/imamhussain_ar) | The Najaf date in sistani.org's header |
| Fadlallah | The office's calendar service on bayynat.org.lb, which publishes the coming year in advance | — |

The Lebanon office follows its own decision, which can differ from Iran's official calendar
(Jumada al-Ula 1448: Lebanon Tue 13 Oct, Iran Mon 12 Oct), so leader.ir is deliberately not used.

## When the run fails

The script never replaces a different date already in the file. If a source contradicts it, or a
date would make a month anything other than 29 or 30 days, the run fails and GitHub emails you.
Open `month-starts.json` on GitHub, fix the date, and commit. A source being unreachable is not a
failure; the next run retries.

You can also add an announcement by hand the moment you see it. The app picks it up within minutes
(raw.githubusercontent.com caches for about 5 minutes).

## Setup

1. Create a **public** repository named `hijri-month-starts` under `MJFneish`. Public repos get
   unlimited Actions minutes, and the app can download the file without a token.
2. Copy this folder's contents (including `.github/`) to its root and push.
3. Under Actions, enable workflows if GitHub asks, then click **Run workflow** once to check it.

GitHub pauses scheduled workflows in a repository with no commits for 60 days. The monthly date
commits normally prevent that; if it ever happens, re-enable the workflow under Actions.
