# Life Tracker

A static web app to replace the "Template of my Life YYYY.xlsx" workflow.
Hour-by-hour daily tracking, fast entry, browser-only storage.

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

To re-seed after a fresh import: reload the page — nothing is cached
locally, so categories and days are pulled fresh from `data/seed.json`
and Supabase on every load.

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

## Sync (placeholder)

Top bar → **Sync** → Export / Import JSON. This is a manual file-based
backup/restore. Future option: GitHub-as-DB or Supabase for live
cross-device sync.

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

Note: there is no local data cache — every load pulls from Supabase. Sign
in on each device to see the same data; Export/Import is still available
for manual JSON backups.
