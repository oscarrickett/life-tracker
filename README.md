# Life Tracker

A static web app to replace the "Template of my Life YYYY.xlsx" workflow.
Hour-by-hour daily tracking, fast entry. Supabase is the source of truth;
a local IndexedDB cache paints the grid instantly (and offline) and is
reconciled with the cloud after load.

## Layout

```
life-tracker/
  index.html          shell
  styles.css
  app.js              all logic (vanilla JS, no build step)
  data/
    seed.json         imported from your 4 xlsx files
  scripts/
    import_xlsx.py    one-off importer
```

## Run locally

The app uses `fetch()` for the seed file, so you need a tiny static server
(opening `index.html` directly with `file://` won't work).

```powershell
cd C:\Users\orick\life-tracker
python -m http.server 8765
# then open http://127.0.0.1:8765
```

## Re-running the importer

If you tweak the xlsx files and want a fresh seed:

```powershell
python scripts/import_xlsx.py
```

The importer reads from `E:\Desktop\Template of my Life {2023..2026}.xlsx`.
It handles the quirk where `2026.xlsx` still has 2025 dates in column A
(the file was copied from last year's template — day-of-week is correct, so
dates are reconstructed from row index for that file).

To re-seed after a fresh import: Account dialog → "Re-pull from cloud" —
this drops the local cache and pulls categories and days fresh from
`data/seed.json` and Supabase.

## Layout

One row per day, 24 columns for the hours, all years stacked with sticky
year headings — the same shape as the original xlsx. Notes go on the right
of each row. Empty future days are shown grey so you can scroll forward.

## Daily entry — keyboard

| Key                      | Effect                              |
| ------------------------ | ----------------------------------- |
| `1`–`9`                  | Activate category 1–9               |
| `0`                      | Activate category 10                |
| `Shift`+`1`–`9`          | Activate category 11–19             |
| `Shift`+`0`              | Activate category 20                |
| `t`                      | Scroll to today                     |
| Click cell               | Apply active category to that hour  |
| Drag across cells        | Paint a range (works across rows)   |
| Right-click cell         | Clear that hour                     |
| Right-click + drag       | Clear a range                       |
| Type in a notes field    | Saves automatically                 |

Digit shortcuts use `e.code` (`Digit0`–`Digit9`), so they work the same on
US and Swedish keyboard layouts.

## Storage, sync & backups

Three layers:

1. **Supabase** — source of truth, synced live while signed in.
2. **Local IndexedDB cache** (`life-tracker-cache`) — written through on
   every edit and cloud pull; the grid renders from it instantly on load,
   including offline. A separate `life-tracker-pending` DB is a
   write-ahead queue of edits not yet confirmed by the cloud; it is only
   cleared on an *explicit* sign-out, never on session expiry.
3. **Automatic backup** — Account dialog → "Automatic backup" → pick a
   folder (e.g. Dropbox). Once per day a dated
   `life-tracker-YYYY-MM-DD.json` is written there (last 60 kept).
   Desktop Chrome/Edge only; grant "Allow on every visit" so it runs
   silently. Manual Export/Import JSON is still available next to it.

## Deploying to GitHub Pages

```powershell
cd C:\Users\orick\life-tracker
git init
git add .
git commit -m "initial life tracker"
# create a github repo, then:
git remote add origin git@github.com:<you>/life-tracker.git
git push -u origin main
# enable Pages: Settings → Pages → Branch = main, Folder = /  (root)
```

Sign in on each device to see the same data; each device keeps its own
local cache so the grid paints before the cloud responds.
