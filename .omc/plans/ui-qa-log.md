# Hera UI QA log

Harness: `?stress=1` (12 today events with long KO/EN titles, events across 12 groups, 15 unpinned running apps, long/many notes, long clips) and `?empty=1` (no records/events/todos/clips/notes). Playwright matrix: 1440×900, 1366×768, 2560×1440, 1280×720 @150% (DPR 1.5) × light/dark × 17 scenes (idle, dock, dock-stress, calendar, cal-filter, cal-select, week, app-note, lp-pop, clip-pop, ascii, island-preview, palette, team, empty-cal, empty-dock, empty-palette). Shots: `.omc/qa-shots/<round>/<viewport>-<theme>-<scene>.png`.

## Round 1 (after features 1–4)
| # | Issue | Fix | Shot |
|---|---|---|---|
| 1 | Month header: "2026년 11월" and "오늘" wrap to 2–3 lines once the 캘린더 capsule sits in the header (all viewports) | Capsule moved to the day bar (it also filters the day list); header label/오늘 `nowrap`; day-bar lunar/holiday text ellipsizes | r1/1440-light-calendar → r2 |
| 2 | Week view chips show only "09:00 …" (46px columns) | Chip = time line + title line (ellipsis), `title` tooltip; chips on the selected (green) day get a light plate | r1/1440-light-week → r2 |
| 3 | App note mock: desktop notes render above the app window | Mock window z 8 (above desk notes 6/7, below pinned 40) — same order as real windows | r1/1440-light-app-note → r2 |
| 4 | LP popover: ASCII titles truncated ("아스키 · 크…") | Section is titled 아스키 아트; items show the short name | r1/1440-light-lp-pop → r2 |
| 5 | 15 running apps push the dock past both screen edges (all viewports) | Max 6 run slots: first 5 + "+N" slot → grid popover | r1/*-dock-stress → r2 |
| 6 | Empty state: LP crate is an invisible blank slot | Dashed "LP" placeholder disc | r1/*-empty-dock → r2 |
