/**
 * Correct the final score of a SETTLED gamble match.
 *
 * Usage:
 *   npx tsx scripts/correct-gamble-score.ts <gamble_match_id> <red_score> <blue_score>
 *   npx tsx scripts/correct-gamble-score.ts 42 7 3
 *
 * What it does:
 *   - if the recorded match row is still intact: re-runs it through the Elo
 *     correction replay (both ledgers + achievements, later matches replayed)
 *   - if the score was ALREADY corrected via the match-history page (the
 *     recorded row was deleted and re-created under a fresh id): locates the
 *     re-created match automatically, re-points the gamble at it, and skips
 *     the Elo work (it's already done) — pass the same scores the edit used
 *   - re-derives every bet's won/lost + payout so the ladder reads true
 *
 * What it deliberately does NOT do: touch the bank. The money that moved at
 * the original settle stays exactly as it was — true-ups between the players
 * and the bookie are settled out-of-band (bank_transactions remains the
 * audit of what actually moved).
 *
 * There is no 24-hour window here: a settled gamble's score can be corrected
 * whenever the bookie notices the mistake.
 */

import db from '../lib/db';
import {
  getGambleMatch,
  getBets,
  correctGambleScore,
} from '../lib/gamble';
import { announceCorrected } from '../lib/gambleNotifications';

function main(): void {
  const args = process.argv.slice(2).filter(a => a !== '--yes');
  const gambleMatchId = parseInt(args[0], 10);
  const redScore = parseInt(args[1], 10);
  const blueScore = parseInt(args[2], 10);

  if (!Number.isInteger(gambleMatchId) || !Number.isInteger(redScore) || !Number.isInteger(blueScore)) {
    console.error('Usage: npx tsx scripts/correct-gamble-score.ts <gamble_match_id> <red_score> <blue_score>');
    process.exit(1);
  }

  const gm = getGambleMatch(gambleMatchId);
  if (!gm) {
    // Common slip: passing the RECORDED office match id (dangling after a
    // match-history edit) instead of the gamble match id. Catch it and
    // point at the gamble that references it.
    const byRecorded = db.prepare(
      `SELECT id FROM gamble_matches WHERE match_id = ?`
    ).get(gambleMatchId) as { id: number } | undefined;
    if (byRecorded) {
      console.error(`${gambleMatchId} is the RECORDED match id, not a gamble id — gamble #${byRecorded.id} points at it.`);
      console.error(`Run: npx tsx scripts/correct-gamble-score.ts ${byRecorded.id} <red> <blue>`);
      process.exit(1);
    }
    // A deleted match id that no gamble references any more (already
    // re-pointed): suggest the gamble that was just corrected.
    const corrected = db.prepare(
      `SELECT id FROM gamble_matches WHERE corrected_at IS NOT NULL AND match_id > ? ORDER BY id DESC LIMIT 1`
    ).all(gambleMatchId - 10) as { id: number }[];
    console.error(`Gamble match ${gambleMatchId} not found.`);
    if (corrected.length) {
      console.error(`If you meant the gamble whose settle was re-created around here, recent candidates: ${corrected.map(c => `#${c.id}`).join(', ')} (check gamble_matches.match_id).`);
    }
    process.exit(1);
  }
  if (gm.status !== 'settled' || !gm.match_id) {
    console.error(`Gamble match ${gambleMatchId} is ${gm.status} — only a settled gamble can be corrected.`);
    process.exit(1);
  }

  const recorded = getBets(gambleMatchId);
  console.log(`\nGamble #${gambleMatchId}: ${gm.red_player_name} vs ${gm.blue_player_name} (${gm.game_name})`);
  console.log(`Recorded match #${gm.match_id}; settling ${recorded.length} bet(s).`);
  console.log(`Correcting final score to ${redScore}-${blueScore} (Elo replay + bets re-marked; NO bank rows written).\n`);

  const summary = correctGambleScore(gambleMatchId, redScore, blueScore);

  console.log(`Match #${summary.previousMatchId} → #${summary.matchId} (re-recorded, Elo replayed).`);
  console.log(`Bets re-marked (${summary.betsAdjusted} changed):`);
  for (const b of summary.betAdjustments) {
    if (!b.changed) continue;
    console.log(
      `  ${b.bettor_name}: ${b.pick} for ${b.stake}` +
      `  ${b.was.status}${b.was.payout ? ` (+${b.was.payout})` : ''} → ${b.now.status}${b.now.payout ? ` (+${b.now.payout})` : ''}`
    );
  }
  console.log(`\n${summary.note}`);

  announceCorrected(gm, summary.previousScore, summary.finalScore)
    .catch(err => console.error('correction announcement failed (harmless):', err));
}

main();