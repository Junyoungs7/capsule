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

## Round 2–4 (targeted re-shoots)
| # | Issue | Fix | Shot |
|---|---|---|---|
| 7 | Week chip time renders at 13–17px (inherits the date `b` rules) | Chip time styled with a more specific selector (9px) | r2 → r4/1440-light-week |
| 8 | Dock still wider than 1366/1280 screens with 10 pinned apps; mock dock box (1290px) clipped the pill | Mock dock box = viewport − 24px; `useFit` folds running apps first, then trailing pinned apps (min 3) into the same "+N" popover until the row fits | r3 → r4/*-dock-stress |

## Round 5 (full pass, 23 scenes incl. 할 일 / 라이브러리 / alert / news / invite / board)
| # | Issue | Fix | Shot |
|---|---|---|---|
| 9 | Calendar filter popover (now in the day bar) opens downward past the panel bottom | Opens upward, right-aligned, matching spring | r5/1440-dark-cal-filter → r6 |
| 10 | "+N개" on the selected (accent) week day is low-contrast | `--on-accent` on the selected day | r5/1440-dark-week → r6 |
| 11 | 1366 / 1280@150%: mock app window too wide, app notes fall back to the left side (under the demo card) | Window width leaves room for the note on its right (min 420px) | r5/1366-light-app-note → r6 |
| 12 | Pinned ("always on top", z 40) note covers the LP popover; panel (z 35) could also sit under pinned notes | Dock with an open popover → z 45; panel → z 44 (user-invoked surfaces win) | r5/1366-light-lp-pop → r6 |
| 13 | Tabs: "라이브러리" touches "달력" (5 × ~63px) | Tab label 12px, tighter tracking | r5/1440-light-* → r8 |
| 14 | Group colour bar (inset shadow) bends around rounded corners → "(" shape in day list, team cards, board notes | Straight `::before` bar (top/bottom inset 10px) | r5/1440-light-team → r8 |

## Round 8 (full pass) → Round 9
| # | Issue | Fix | Shot |
|---|---|---|---|
| 15 | Calendar day list shows only ~1 row under the month grid with many events | Grid 268 → 252px with tighter date/lunar line heights and a 6px dot row (cells ≈37px still fit date + lunar + dots, verified no overlap); list gains a row | r8/1440-light-calendar → r9 |

## Round 10 (full pass: 23 scenes × 4 viewports × 2 themes = 184 shots, 0 console errors)
Nothing left worth fixing. Checked: no overlaps/clipping at 1366×768, 1280×720@150%, 1440×900, 2560×1440; dock always fits (5 run slots + "+N"); popovers stay inside the panel/screen and above pinned notes; app notes sit beside the app window at every size; week/month cells never wrap; empty states have copy/placeholders; light and dark contrast as in the B-final report.

Committed shots: `.omc/qa-shots/final/` (subset of round 10). Earlier rounds stay local (`.omc/qa-shots/r1…r10`, not committed).

## Known limits (not visual bugs)
- Real app: dock and Island are separate windows — LP drag and the "아스키 재생 중" Island state need a Rust relay; `openAscii(from, scene)` passes the scene, Rust must forward it as `?scene=`.
- `useFit` measures `.dock-row` after layout (one extra layout pass per fold step, only when the dock content or window size changes).
