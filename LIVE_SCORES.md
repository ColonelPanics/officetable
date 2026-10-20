# Live Match Tracking

A companion feature to recording matches: games can be tracked **live** —
points registered the moment they're scored — which unlocks data that a
final-score-only record can't provide.

## What you get

- **Point scoring order** — every point with its offset from the match start.
- **Match duration (estimated)** — wall-clock from "start scoring" to the
  final point / match end.
- **Game-state achievements** (only earnable when live-tracked):
  | Achievement | Icon | Rule |
  |---|---|---|
  | Wire to Wire | 🛡️ | Scored the first point and never trailed (ties are allowed — level isn't behind) |
  | Comeback Kid | 🔄 | Trailed by **2+ points** at some point and still won |
  | Marathon | ⏱️ | Won a live-tracked match lasting **15 minutes or more** (`MARATHON_MINUTES` in lib/timeline.ts — punditry shares it) |
  | Dying Breath | 🫀 | The loser's ONLY point was the very last point of the game — a flawless win denied at the death |
  | Opener | 🎺 | Scored the first point in **3 live-tracked games in a row** (un-tracked games count against the run) |
  | Sprint | 🏃 | Won a live-tracked match in **under 3 minutes** (`SPRINT_MAX_MINUTES` — the anti-marathon) |
  | Bookend | 🔖 | The same side scored **both the first and the last point** |
  | Get On With It | 🐌 | The opening point landed **more than 2 minutes in** (`SLOW_OPEN_MINUTES`) |
  | To Me, To You | 🏓 | Scorers alternated for **4+ consecutive points** (`ALTERNATION_MIN_POINTS`) — both sides earn |
  | Irresistible Force vs Immovable Object | 🗿 | More than **4 minutes between two consecutive points** (`RALLY_MINUTES`) — both bracketing sides earn |
  | Game of Two Halves | 🌗 | Best-of games only: trailed by **half the best-of score** and salvaged a **draw** live |
- **Live punditry** on the match report: comeback / wire-to-wire stories,
  lead-change counts (ties ignored), marathon and blitz-pace notes.
- **Match summary/report rendering** like any sports report: the match detail
  page shows a duration badge, a cumulative score-over-time chart, stat chips
  (first point, lead changes, worst deficit, wire-to-wire) and the ordered
  scoring list with clock times. The match history list shows an ⏱ duration
  chip on live-tracked games.

## How it works

### 1. The live scorer — `/matches/live` (mobile-first)

1. **Setup**: pick the game (the nav's game selector, or `?game=` param) and
   tap players onto Team 1 (R) / Team 2 (B) — team 1 is the bookie's red
   side (teams[0] = red), so it's displayed red throughout.
2. **Scoring**: a red pulsing clock, the running score, and two giant tap
   zones — tap whichever team won the point. Corrections are one tap:
   **↩️ Undo last**, or remove any single point from the point log.
3. **Review**: final score, duration, live highlights (first point, lead
   changes, comebacks, wire-to-wire), optional notes → **Record match** and
   the report opens straight away.

The live state (teams, start time, points) is persisted to
`localStorage` (`liveMatchDraft.v1`) after every change, so a phone screen
lock, refresh or browser crash doesn't lose the record. Resume is automatic;
"Abandon match" clears the draft after confirmation.

Timing model: `start` is stamped when scoring begins; each point stores its
**ms offset from start**; `end` is stamped when the match ends. Duration =
`end − start` (or the last point's offset if `end` is missing). This is an
*estimate* — it includes whatever was happening between points.

### 2. Storage — `matches.points_timeline`

The validated timeline is stored as JSON **on the match row**:

```json
{
  "start": "2026-01-15T10:00:00.000Z",
  "end":   "2026-01-15T10:04:00.000Z",
  "events": [ { "team": 0, "at": 30000 }, { "team": 0, "at": 90000 } ]
}
```

- `events[].team` indexes the **teams array the match was recorded with**
  (0 = team 1). The recorder always sends team labels 0 and 1.
- `events[].at` is the millisecond offset from `start`.
- NULL = not live-tracked (every pre-existing match).

Replays (match correction, deletion, achievement recalculation) **carry the
timeline column through**, so live-tracked matches keep their point order,
duration and timeline achievements across corrections — provided the corrected
scores stay consistent with the recorded points. The PUT
`/api/matches/[id]` correction endpoint additionally accepts a `timeline`
body field to re-score the points too.

### 3. Validation — `lib/timeline.ts`

`validatePointTimeline(raw, teams, teamScores)` is the single gate, shared
shape with the client via `parsePointTimeline` / `computeTimelineStats`:
- `start` required (ISO), `end` optional (ISO, ≥ start, within 24h);
- events ascending by `at`, `at ≥ 0`, within 24h of start, max 1000 events;
- `team` must index the recorded teams array;
- **per-team event count must equal the team's final score** — scores and
  point order can never disagree.

The derived stats (`computeTimelineStats`) expose duration, first scorer,
`everTrailed` / `maxDeficit` per team, lead changes and wire-to-wire winners —
the raw material for achievements and punditry.

### 4. End-to-end flow

`POST /api/matches` gains an optional `timeline` body field, validated above
and passed into `processMatch`, which stores it with the season-resolved match
and hands it to `checkAchievements` (live + replay + recalculation paths all
pass the timeline so the three game-state achievements are consistent
everywhere). The response now returns `match_id` so the live scorer can route
to the fresh report.

### 5. Gambling: the attach model

Gambles don't have their own recording flow — players record the match like
any other (live scorer or leaderboard), and a two-team result whose sides sit
over an open gamble's roster seat sets **attaches automatically**, either side
order (A & B vs B & A on Team 1 are the same lineup). Team gambles (1v2, 2v2…)
attach like 1v1s: the bet ladder, entries and pot all settle through the
gamble's own `settleGambleMatch`, which accepts the timeline — live-tracked
gambles keep their point order, duration, timeline achievements and punditry
on the match report.

- The gamble match page points participants at **🔴 Track live** and
  **📝 Record score** (leaderboard) first; the manual score form remains as a
  fallback and settles exactly the same way (it also accepts a `timeline`,
  team index 0 = red).
- The recorded settle match carries the FULL roster (every seat in
  `match_participants`), consistent with the correction replay's roster
  recording — team gambles produce real team-Elo results.
- The live scorer shows a banner during setup when the picked players match
  an open gamble's roster, so nobody is surprised that recording settles bets.
- Gamble-side rejections surface properly on the record APIs (e.g. recording
  before the betting window closes is a 409 with the bookie's message, not a
  generic recording error).
- Score corrections in either system keep timelines consistent:
  `correctGambleScore` (and the office-match correction route) preserve the
  original timeline unless the corrected score no longer matches the recorded
  point counts — in which case the timeline is dropped rather than stored
  inconsistently. A corrected timeline can also be supplied explicitly
  (`POST /api/gambling/matches/[id]/correct` accepts `timeline`).

## Smoke test

```
mkdir -p /tmp/live-run && cd /tmp/live-run
npx --prefix /path/to/officetable tsx /path/to/officetable/scripts/live-smoke.ts
```

Covers: timeline validation rejections (bad start, out-of-order, out-of-range
team, score/count mismatch, end-before-start), wire-to-wire / comeback /
marathon stats + achievements + punditry facts, achievements surviving
recalculation and being re-earned after a score correction with the original
timeline preserved, and the gamble-attach path (1v1 and 2v2 settles with a
timeline — either seat order —, correction dropping an inconsistent one,
correction with a replaced one).