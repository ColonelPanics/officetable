// Regression test: a live-scorer lineup recorded in the OPPOSITE orientation
// to the gamble's red/blue seating used to hit "Teams do not match the gamble
// match participants". findAttachedGamble must normalise the labels (and
// flipped timelines get remapped by the caller). Run from a SCRATCH cwd so the
// DB it touches is that directory's officetable.db, never the real one:
//   mkdir -p /tmp/gamble-run-flip && cd /tmp/gamble-run-flip
//   npx --prefix /path/to/officetable tsx /path/to/officetable/scripts/flip-attach.ts
import db from '../lib/db';
import { createChallenge, respondToChallenge, placeBet, settleGambleMatch, findAttachedGamble, getGambleMatch } from '../lib/gamble';
import { getBank } from '../lib/bank';

const bank = getBank();

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}
function assertThrows(fn: () => unknown, msg: string): void {
  try { fn(); console.error('FAIL (expected throw):', msg); process.exit(1); } catch { /* ok */ }
}

db.exec(`INSERT OR IGNORE INTO games (id, name, score_type, score_value) VALUES (1, 'Foosball', 'best_of', 10)`);
const names = ['FlipRed', 'FlipBlue', 'FlipBet1'];
const ids: number[] = names.map(n => {
  const ex = db.prepare(`SELECT id FROM players WHERE name = ?`).get(n) as { id: number } | undefined;
  return (ex?.id ?? db.prepare(`INSERT INTO players (name) VALUES (?)`).run(n).lastInsertRowid) as number;
});
for (const id of ids) bank.ensureAccount(id);
db.prepare(`UPDATE bank_house SET balance = 100000 WHERE id = 1`).run();
const [red, blue, bettor] = ids;

const scheduledAt = new Date(Date.now() + 30 * 60_000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const challengeId = createChallenge(1, red, blue, { entryFee: 50, scheduledAt, side: 'red', payoutLine: 'true_even' });
respondToChallenge(challengeId, blue, 'accept');
const gmId = (db.prepare(`SELECT gamble_match_id FROM challenges WHERE id = ?`).get(challengeId) as { gamble_match_id: number }).gamble_match_id;
placeBet(gmId, bettor, 8, 2, 40);
// let the betting window lapse so settle is allowed
db.prepare(`UPDATE gamble_matches SET scheduled_at = datetime('now', '-10 minutes'), bet_close_at = datetime('now', '-8 minutes') WHERE id = ?`).run(gmId);
db.prepare(`UPDATE gamble_matches SET status = 'awaiting_score' WHERE id = ?`).run(gmId);

// lineups (sets must be order-free): blue=ids[1] wins 7-3 (total 10)
// WRONG payload shape (what the old route passed through): ids kept, but the
// `team` labels still say which object is which side.
const recordedFlip = [
  { team: 0, player_ids: [blue], score: 7 },   // blue side recorded as "Team 1"
  { team: 1, player_ids: [red], score: 3 },
];
const attached = findAttachedGamble(1, recordedFlip);
assert(attached !== null, 'flipped lineup must attach to the open gamble');
assert(attached!.gambleId === gmId, `attach should find gamble ${gmId}`);
assert(attached!.flipped === true, 'attachment must report flipped');
assert(JSON.stringify(attached!.teams) === JSON.stringify([
  { team: 0, player_ids: [red], score: 3 },
  { team: 1, player_ids: [blue], score: 7 },
]), 'attach must normalise teams to the gamble red/blue seating');

// The OLD bug, for the record: passing the flipped teams verbatim threw
// teams_mismatch (settleGambleMatch picks sides by the `team` field)
assertThrows(() => settleGambleMatch(gmId, recordedFlip, 'flip bug'), 'old code path must throw teams_mismatch');

// New path: normalised teams settle cleanly, red lost 3-7 to blue
const summary = settleGambleMatch(gmId, attached!.teams, 'flip regression', {
  start: new Date(Date.now() - 300000).toISOString(),
  end: new Date().toISOString(),
  events: [{ team: 0, at: 1000 }, { team: 0, at: 2000 }, { team: 1, at: 3000 }], // team 0 = the RECORDED side 0 ("Team 1")
});
assert(getGambleMatch(gmId)!.status === 'settled', 'gamble should be settled');
const settledGm = getGambleMatch(gmId)!;
assert(summary.matchId > 0, 'match must be recorded');
const parts = db.prepare(`SELECT team, player_id, score FROM match_participants WHERE match_id = ?`).all(summary.matchId) as { team: number; player_id: number; score: number }[];
const redP = parts.find(p => p.player_id === red)!;
const blueP = parts.find(p => p.player_id === blue)!;
assert(redP.score === 3 && blueP.score === 7, `scores must land on the right players (red ${redP.score}, blue ${blueP.score})`);

// negative: a lineup that matches NO open gamble returns null
assert(findAttachedGamble(1, [{ team: 0, player_ids: [red, 999], score: 5 }, { team: 1, player_ids: [bettor], score: 5 }]) === null, 'non-matching lineup must not attach');

console.log('flip-attach: all assertions passed —', settledGm.status, 'match', summary.matchId);