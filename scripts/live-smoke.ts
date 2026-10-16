// Smoke test for the live-scorer timeline layer. Run it from a SCRATCH cwd so
// the DB it touches is that directory's officetable.db, never the real one:
//   mkdir -p /tmp/live-run && cd /tmp/live-run
//   npx --prefix /path/to/officetable tsx /path/to/officetable/scripts/live-smoke.ts
import db from '../lib/db';
import { processMatch, correctMatch } from '../lib/elo';
import { getBank } from '../lib/bank';
import { createChallenge, respondToChallenge, settleGambleMatch, correctGambleScore, syncStatuses } from '../lib/gamble';
import { recalculateAchievementsForGame, deleteAchievementsForMatch } from '../lib/achievements';
import { getPunditryForMatch } from '../lib/punditry';
import { validatePointTimeline, parsePointTimeline, computeTimelineStats } from '../lib/timeline';
import type { CreateMatchInput } from '../lib/types';

function assert(cond: boolean, label: string): void {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok: ${label}`);
}

/** datetime-local string for `offsetMs` from now, LOCAL wall-clock (same
 *  convention as scripts/gamble-smoke.ts — challenges reject past schedules). */
function localIn(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs);
  d.setMilliseconds(0);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function hasAchievement(matchId: number, name: string, playerId?: number): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM player_achievements pa
    JOIN achievements a ON pa.achievement_id = a.id
    WHERE pa.match_id = ? AND a.name = ? ${playerId ? 'AND pa.player_id = ?' : ''}
  `).get(...(playerId ? [matchId, name, playerId] : [matchId, name])) as { c: number };
  return row.c > 0;
}

// ---------------------------------------------------------------------------
// Setup: a scratch game + two players
// ---------------------------------------------------------------------------
const names = [`LiveA-${Date.now()}`, `LiveB-${Date.now()}`];
const playerIds: number[] = [];
for (const name of names) {
  const r = db.prepare('INSERT INTO players (name) VALUES (?)').run(name);
  playerIds.push(r.lastInsertRowid as number);
}
const gameResult = db.prepare(`INSERT INTO games (name, score_type, score_value) VALUES (?, 'best_of', 10)`).run(`live-smoke-${Date.now()}`);
const gameId = gameResult.lastInsertRowid as number;

const START = '2026-01-15T10:00:00.000Z';

const teams: CreateMatchInput['teams'] = [
  { team: 0, player_ids: [playerIds[0]], score: 0 },
  { team: 1, player_ids: [playerIds[1]], score: 0 },
];

// ---------------------------------------------------------------------------
// Timeline validation
// ---------------------------------------------------------------------------
{
  const bad = validatePointTimeline({ start: 'nope', events: [] }, teams, [0, 0]);
  assert(!!bad.error, 'invalid start rejected');
}
{
  const ok1 = validatePointTimeline({ start: START, events: [{ team: 0, at: 5000 }, { team: 0, at: 500 }] }, teams, [2, 0]);
  assert(!!ok1.error, 'out-of-order events rejected');
}
{
  const ok2 = validatePointTimeline({ start: START, events: [{ team: 5, at: 500 }] }, teams, [0, 0]);
  assert(!!ok2.error, 'out-of-range team rejected');
}
{
  const ok3 = validatePointTimeline({ start: START, events: [{ team: 0, at: 500 }] }, teams, [2, 0]);
  assert(!!ok3.error, 'score/count mismatch rejected');
}
{
  const ok4 = validatePointTimeline({ start: START, end: '2026-01-14T10:00:00.000Z', events: [] }, teams, [0, 0]);
  assert(!!ok4.error, 'end before start rejected');
}
{
  const good = validatePointTimeline({ start: START, events: null }, teams, [0, 0]);
  assert(!!good.error, 'non-array events rejected');
}

// ---------------------------------------------------------------------------
// Wire to wire: team 0 scores first, never trails
// ---------------------------------------------------------------------------
{
  const events = [
    { team: 0, at: 30_000 },
    { team: 0, at: 90_000 },
    { team: 1, at: 120_000 },
    { team: 0, at: 180_000 },
  ];
  const wt = [
    { team: 0, player_ids: [playerIds[0]], score: 3 },
    { team: 1, player_ids: [playerIds[1]], score: 1 },
  ];
  const checked = validatePointTimeline({ start: START, end: '2026-01-15T10:04:00.000Z', events }, wt, wt.map(t => t.score));
  assert(!checked.error && !!checked.timeline, 'wire-to-wire timeline validates');
  const timeline = checked.timeline!;
  const stats = computeTimelineStats(timeline, wt.map(t => t.score));
  assert(stats.firstScorer === 0, 'first scorer is team 0');
  assert(stats.wireToWireWinners.includes(0), 'team 0 wire-to-wire');
  assert(!stats.teams[1].everTrailed === false, 'team 1 trailed');
  assert(stats.leadChanges === 0, 'no lead changes');
  assert(stats.durationMs === 240_000, 'duration from end-start');

  const result = processMatch({ game_id: gameId, notes: undefined, teams: wt, timeline }, new Date(START));
  assert(hasAchievement(result.matchId, 'wire_to_wire', playerIds[0]), 'wire_to_wire earned by team 0 player');
  assert(!hasAchievement(result.matchId, 'comeback_kid'), 'no comeback for wire-to-wire');
  assert(!hasAchievement(result.matchId, 'marathon'), 'no marathon under 20 min');

  // Punditry sees the wire-to-wire fact
  const facts = getPunditryForMatch(result.matchId);
  assert(facts.some(f => f.description.includes('never behind — a wire-to-wire win')), 'punditry wire-to-wire fact');
}

// ---------------------------------------------------------------------------
// Comeback: team 0 leads 2-0, team 1 wins 3-2
// ---------------------------------------------------------------------------
{
  const events = [
    { team: 0, at: 60_000 },
    { team: 0, at: 120_000 },
    { team: 1, at: 180_000 },
    { team: 1, at: 240_000 },
    { team: 1, at: 300_000 },
  ];
  const cbTeams = [
    { team: 0, player_ids: [playerIds[0]], score: 2 },
    { team: 1, player_ids: [playerIds[1]], score: 3 },
  ];
  const checked = validatePointTimeline(
    { start: START, events },
    cbTeams,
    cbTeams.map(t => t.score)
  );
  assert(!checked.error && !!checked.timeline, 'comeback timeline validates');
  const timeline = checked.timeline!;
  const stats = computeTimelineStats(timeline, cbTeams.map(t => t.score));
  assert(stats.teams[1].maxDeficit === 2, 'max deficit is 2');
  assert(stats.teams[1].everTrailed, 'team 1 trailed');
  assert(!stats.wireToWireWinners.includes(1), 'comeback winner is not wire-to-wire');
  assert(stats.leadChanges === 1, 'one lead change (2-0 -> 3-2, ties ignored)');

  const result = processMatch({ game_id: gameId, notes: undefined, teams: cbTeams, timeline }, new Date(START));
  assert(hasAchievement(result.matchId, 'comeback_kid', playerIds[1]), 'comeback_kid earned by team 1 player');
  assert(!hasAchievement(result.matchId, 'comeback_kid', playerIds[0]), 'loser gets no comeback_kid');
  assert(!hasAchievement(result.matchId, 'wire_to_wire'), 'no wire_to_wire for comeback match');

  const facts = getPunditryForMatch(result.matchId);
  assert(facts.some(f => f.description.includes('came back from 2 down')), 'punditry comeback fact');
}

// ---------------------------------------------------------------------------
// Marathon: 20+ minutes, wire-to-wire winner
// ---------------------------------------------------------------------------
{
  // See-saw: t0 t1 t1 t0 t0 t1 t1 t0 t0 t0 t1 → 6-5 with the lead changing
  // hands 4 times (1-0 t0 → 1-2 t1 → 3-2 t0 → 3-4 t1 → 5-4 t0, ties ignored).
  const seq = [0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1];
  const events = seq.map((team, i) => ({ team, at: (i + 1) * 90_000 }));
  const marTeams = [
    { team: 0, player_ids: [playerIds[0]], score: 6 },
    { team: 1, player_ids: [playerIds[1]], score: 5 },
  ];
  const timeline = { start: START, end: '2026-01-15T10:22:00.000Z', events };
  const stats = computeTimelineStats(timeline, marTeams.map(t => t.score));
  assert((stats.durationMs ?? 0) >= 20 * 60_000, 'marathon duration ≥ 20 min');
  assert(stats.firstScorer === 0, 'team 0 scored first');
  assert(stats.teams[0].everTrailed && stats.teams[1].everTrailed, 'both teams trailed in the see-saw');
  assert(stats.leadChanges === 4, 'four lead changes in the see-saw');

  const result = processMatch({ game_id: gameId, notes: undefined, teams: marTeams, timeline }, new Date(START));
  assert(hasAchievement(result.matchId, 'marathon', playerIds[0]), 'marathon earned by winner');
  assert(!hasAchievement(result.matchId, 'marathon', playerIds[1]), 'loser gets no marathon');
  assert(!hasAchievement(result.matchId, 'wire_to_wire'), 'trailing in see-saw → no wire_to_wire');

  const facts = getPunditryForMatch(result.matchId);
  assert(facts.some(f => f.description.includes('a marathon')), 'punditry marathon fact');
  assert(facts.some(f => f.description.includes('lead changed hands')), 'punditry lead-change fact');
}

// ---------------------------------------------------------------------------
// Recalculation and REPLAY keep timeline achievements intact
// ---------------------------------------------------------------------------
{
  const matchId = (db.prepare('SELECT MAX(id) as id FROM matches').get() as { id: number }).id;
  const countBefore = (db.prepare(`
    SELECT COUNT(*) as c FROM player_achievements pa
    JOIN achievements a ON pa.achievement_id = a.id
    WHERE pa.match_id = ? AND a.name = 'marathon'
  `).get(matchId) as { c: number }).c;

  // Re-run the recalculation over the whole game (like the admin endpoint)
  const recalc = recalculateAchievementsForGame(gameId);
  assert(recalc.matchesProcessed >= 3, 'recalc processes the live matches');

  const countAfter = (db.prepare(`
    SELECT COUNT(*) as c FROM player_achievements pa
    JOIN achievements a ON pa.achievement_id = a.id
    WHERE pa.match_id = ? AND a.name = 'marathon'
  `).get(matchId) as { c: number }).c;
  assert(countAfter === countBefore, 'marathon survives recalculation (timeline in recalc path)');

  // Correct the score of the last match WITHOUT a new timeline: the original
  // timeline must be re-created so the achievement re-earns.
  const stored = parsePointTimeline(
    (db.prepare('SELECT points_timeline FROM matches WHERE id = ?').get(matchId) as { points_timeline: string } | undefined)?.points_timeline
  );
  assert(stored !== null, 'timeline stored on the match and parseable');

  deleteAchievementsForMatch(matchId);
  const oldToNew = correctMatch(
    matchId,
    [
      { team: 0, player_ids: [playerIds[0]], score: 6 },
      { team: 1, player_ids: [playerIds[1]], score: 5 },
    ]
  );
  const newId = oldToNew.get(matchId);
  assert(newId !== undefined, 'corrected match re-created');
  const stillEarned = (db.prepare(`
    SELECT COUNT(*) as c FROM player_achievements pa
    JOIN achievements a ON pa.achievement_id = a.id
    WHERE pa.match_id = ? AND a.name = 'marathon'
  `).get(newId) as { c: number }).c;
  assert(stillEarned === countBefore, 'marathon re-earned after correction (timeline carried through replay)');

  const carried = db.prepare('SELECT points_timeline FROM matches WHERE id = ?').get(newId) as { points_timeline: string | null } | undefined;
  assert(!!carried?.points_timeline, 'timeline carried onto the corrected match row');
}


// ---------------------------------------------------------------------------
// Gamble attachment: settling THROUGH a recorded timeline, and corrections
//
// A gamble-backed match is recorded exactly once (the settle's processMatch);
// participants record like any other match (leaderboard or the live scorer)
// and the matching open gamble attaches automatically. Timeline team indexes:
// 0 = red, 1 = blue.
// ---------------------------------------------------------------------------
{
  const bank = getBank();
  const gNames = [`GamblerR-${Date.now()}`, `GamblerB-${Date.now()}`];
  const gIds = gNames.map(n => (db.prepare('INSERT INTO players (name) VALUES (?)').run(n).lastInsertRowid as number));
  for (const id of gIds) bank.ensureAccount(id);
  bank.credit(null, 5000, { type: 'topup', memo: 'smoke: seed the house pot' });

  /** Backdate a gamble match inside the overdue window so settles pass the
   *  clock guard (same trick scripts/gamble-smoke.ts uses). */
  function fastForward(gmId: number): void {
    db.prepare(`UPDATE gamble_matches
      SET scheduled_at = datetime('now','-5 minutes'), bet_close_at = datetime('now','-7 minutes')
      WHERE id = ?`).run(gmId);
    syncStatuses();
  }

  // Comeback timeline: red 2 up, blue takes the next 8 → 2-8. Counts match
  // the gamble's fixed total of 10.
  const comebackEvents = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1].map((team, i) => ({ team, at: (i + 1) * 45_000 }));
  const timeline = { start: START, end: '2026-01-15T10:09:00.000Z', events: comebackEvents };

  // A: recording WITH a timeline settles the gamble and keeps the timeline
  const c1 = createChallenge(gameId, gIds[0], gIds[1], { scheduledAt: localIn(6 * 60_000 + 30_000), side: 'red', entryFee: 30 });
  const gmA = respondToChallenge(c1, gIds[1], 'accept').gambleMatch!;
  assert(gmA.outcome_total === 10, 'gamble total is 10');
  fastForward(gmA.id);
  const sumA = settleGambleMatch(
    gmA.id,
    [
      { team: 0, player_ids: [gIds[0]], score: 2 },
      { team: 1, player_ids: [gIds[1]], score: 8 },
    ],
    'live smoke: attached gamble',
    timeline
  );
  assert(sumA.matchId > 0, 'attached-settle records a real match');
  const recordedA = parsePointTimeline(
    (db.prepare('SELECT points_timeline FROM matches WHERE id = ?').get(sumA.matchId) as { points_timeline: string }).points_timeline
  );
  assert(recordedA !== null && recordedA.events.length === 10, 'attached settle carries the timeline');
  assert(hasAchievement(sumA.matchId, 'comeback_kid', gIds[1]), 'comeback_kid earned on the gamble-backed match');

  // B: correcting to a score that no longer matches the recorded point
  // counts DROPS the timeline (it would lie about the shape of the game)
  correctGambleScore(gmA.id, 5, 5);
  const correctedA = db.prepare('SELECT points_timeline FROM matches WHERE id = ?').get(sumA.matchId) as
    | { points_timeline: string }
    | undefined;
  // correctMatch deletes + re-creates the row: find the corrected match via the gamble pointer
  const repointA = (db.prepare('SELECT match_id FROM gamble_matches WHERE id = ?').get(gmA.id) as { match_id: number }).match_id;
  const correctedRow = db.prepare('SELECT points_timeline FROM matches WHERE id = ?').get(repointA) as { points_timeline: string | null };
  assert(correctedRow.points_timeline === null, 'timeline dropped when the corrected score mismatches point counts');
  assert(!hasAchievement(repointA, 'comeback_kid', gIds[1]) && repointA !== sumA.matchId, 'achievement replayed away with the dropped timeline (5-5 is a draw)');
  void correctedA;

  // C: an explicitly supplied timeline matching the corrected score is used
  const c2 = createChallenge(gameId, gIds[1], gIds[0], { scheduledAt: localIn(6 * 60_000 + 30_000), side: 'blue', entryFee: 30 });
  const gmB = respondToChallenge(c2, gIds[0], 'accept').gambleMatch!;
  fastForward(gmB.id);
  const flatEvents = [0, 1, 0, 1, 0, 1, 0, 1, 1, 1].map((team, i) => ({ team, at: (i + 1) * 30_000 }));
  const sumB = settleGambleMatch(
    gmB.id,
    [
      { team: 0, player_ids: [gmB.red_player_id], score: 4 },
      { team: 1, player_ids: [gmB.blue_player_id], score: 6 },
    ],
    'live smoke: flat',
    { start: START, end: '2026-01-15T10:03:00.000Z', events: flatEvents }
  );
  assert(sumB.matchId > 0, 'B settle recorded');
  // Correct 4-6 → 6-4 with a fresh timeline (red takes it back, 10 events)
  const correctedTimeline = [0, 1, 0, 1, 0, 1, 0, 1, 0, 0].map((team, i) => ({ team, at: (i + 1) * 30_000 }));
  correctGambleScore(gmB.id, 6, 4, undefined, { start: START, end: '2026-01-15T10:05:00.000Z', events: correctedTimeline });
  const repointB = (db.prepare('SELECT match_id FROM gamble_matches WHERE id = ?').get(gmB.id) as { match_id: number }).match_id;
  const rowB = parsePointTimeline(
    (db.prepare('SELECT points_timeline FROM matches WHERE id = ?').get(repointB) as { points_timeline: string }).points_timeline
  );
  assert(
    rowB !== null && rowB.events.length === 10 && rowB.events[9].team === 0,
    'correction with a supplied timeline records the corrected point order'
  );
}

console.log(process.exitCode ? 'SMOKE FAILED' : 'LIVE SMOKE OK');