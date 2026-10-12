// Smoke test for the gambling layer. Run it from a SCRATCH cwd so the DB it
// touches is that directory's officetable.db, never the real one:
//   mkdir -p /tmp/gamble-run && cd /tmp/gamble-run
//   npx --prefix /path/to/officetable tsx /path/to/officetable/scripts/gamble-smoke.ts
//
// Challenges now expire 5 minutes before the start, so everything is
// scheduled ≥ 6 min out and the clock is pushed forward by backdating the
// gamble match (never past now − 15 min, or the auto-cancel would trip).
// Runs in seconds, no real waiting.
import db from '../lib/db';
import {
  createChallenge, respondToChallenge, placeBet, settleGambleMatch,
  cancelGambleMatch, getBets, getChallenge, getGambleMatch, getBetPool, GAMBLE_RULES,
  syncStatuses,
} from '../lib/gamble';
import type { GambleError } from '../lib/gamble';
import { getBank } from '../lib/bank';
import { HOUSE_MARGIN } from '../lib/gambleOdds';

function assert(cond: boolean, label: string): void {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok: ${label}`);
}

/** Assert fn throws a GambleError with the given code (when given). */
function assertThrows(label: string, fn: () => unknown, wantCode?: string): void {
  try {
    fn();
    console.error(`FAIL: ${label} (nothing thrown)`);
    process.exitCode = 1;
  } catch (e) {
    const code = (e as GambleError).code;
    if (wantCode && code !== wantCode) {
      console.error(`FAIL: ${label} — expected code "${wantCode}", got "${code ?? String(e)}"`);
      process.exitCode = 1;
      return;
    }
    console.log(`ok: ${label}${code ? ` (${code})` : ''}`);
  }
}

const bank = getBank();
const fee = GAMBLE_RULES.defaultEntryFee;

// datetime-local string for `offsetMs` from now, built in LOCAL wall-clock
// (normaliseStartDate parses these as local)
function localIn(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs);
  d.setMilliseconds(0); // datetime-local precision
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Challenges expire at start − 5 min ⇒ accepted games must be scheduled ≥ 6
// min out to be alive; the expiry case schedules +2m15s (born expired).
const FUTURE = 6 * 60_000 + 30_000;
const EXPIRED = 2 * 60_000 + 30_000;

// Synthetic clock: push a gamble match into the past (past its close, but
// well inside the 15-minute overdue window) and sync statuses.
function fastForward(gmId: number): void {
  db.prepare(`UPDATE gamble_matches
    SET scheduled_at = datetime('now','-5 minutes'), bet_close_at = datetime('now','-7 minutes')
    WHERE id = ?`).run(gmId);
  syncStatuses();
}

async function main() {
  // --- seed players + game ---
  const gameCount = (db.prepare(`SELECT COUNT(*) n FROM games WHERE name = 'smoke-foos'`).get() as { n: number }).n;
  if (gameCount === 0) {
    db.prepare(`INSERT INTO games (name, score_type, score_value) VALUES ('smoke-foos', 'best_of', 10)`).run();
  }
  const gameId = (db.prepare(`SELECT id FROM games WHERE name = 'smoke-foos'`).get() as { id: number }).id;
  const names = ['SmokeRed', 'SmokeBlue', 'SmokeGambler1', 'SmokeGambler2'];
  const insPlayer = db.prepare(`INSERT INTO players (name, status) VALUES (?, 'active')`);
  const ids = names.map(n => {
    const row = db.prepare(`SELECT id FROM players WHERE name = ?`).get(n) as { id: number } | undefined;
    return row ? row.id : (insPlayer.run(n).lastInsertRowid as number);
  });
  const [redId, blueId, g1, g2] = ids;
  for (const id of ids) bank.ensureAccount(id);

  // The casino has two pots: the bet pool (staked money) and the house pot
  // (bank reserves). The payout cap = bet pool + house pot − 1, so the house
  // needs real reserves for big winners to be payable — seed them.
  const HOUSE_SEED = 5000;
  bank.credit(null, HOUSE_SEED, { type: 'topup', memo: 'smoke: seed the house pot' });

  // ============ challenge A: counter loop + bets + house loss ==============
  const scheduledA = localIn(FUTURE);
  const challengeId = createChallenge(gameId, redId, blueId, { entryFee: 60, scheduledAt: scheduledA, side: 'red' });
  assert(getChallenge(challengeId)?.status === 'pending', 'challenge created pending');

  respondToChallenge(challengeId, blueId, 'counter', { entryFee: 40, scheduledAt: scheduledA, side: 'red' });
  assert(getChallenge(challengeId)!.entry_fee === 40, 'counter updates terms');
  assert(bank.getBalance(redId) === 1000 && bank.getBalance(blueId) === 1000, 'no money moves on counter');

  respondToChallenge(challengeId, redId, 'counter', { entryFee: fee, scheduledAt: scheduledA, side: 'blue' });
  assert(getChallenge(challengeId)!.red_player_id === blueId, 'counter flips red side to blue');

  const accepted = respondToChallenge(challengeId, blueId, 'accept');
  const gm = accepted.gambleMatch!;
  assert(gm.status === 'open', 'accept opens gamble match');
  assert(bank.getBalance(redId) === 1000 - fee && bank.getBalance(blueId) === 1000 - fee, 'entry fees debited on accept');
  assert(gm.odds!.outcomes.length === 11, 'odds ladder has 11 outcomes');
  assert(Math.abs(gm.odds!.outcomes.reduce((s, o) => s + o.prob, 0) - 1) < 1e-9, 'outcome probs sum to 1');
  assert(bank.getHouseBalance() === HOUSE_SEED, 'banking: house pot seeded, no other house flow yet');

  let blocked = false;
  try { placeBet(gm.id, redId, 5, 5, 10); } catch { blocked = true; }
  assert(blocked, 'participant bet blocked (match-fixing guard)');
  blocked = false;
  try { placeBet(gm.id, g1, 6, 5, 10); } catch { blocked = true; }
  assert(blocked, 'scoreline not summing to total blocked');
  blocked = false;
  try { placeBet(gm.id, g1, 1, 9, 99999); } catch { blocked = true; }
  assert(blocked, 'insufficient funds blocked');

  placeBet(gm.id, g1, 7, 3, 100);
  placeBet(gm.id, g2, 7, 3, 50);
  assert(bank.getBalance(g1) === 900 && bank.getBalance(g2) === 950, 'stakes debited');

  // early settle must be refused: bets are still open until bet_close_at
  blocked = false;
  try {
    settleGambleMatch(gm.id, [
      { team: 0, player_ids: [gm.red_player_id], score: 7 },
      { team: 1, player_ids: [gm.blue_player_id], score: 3 },
    ]);
  } catch { blocked = true; }
  assert(blocked, 'settle before bet close blocked by clock guard');

  fastForward(gm.id);

  const summary = settleGambleMatch(gm.id, [
    { team: 0, player_ids: [gm.red_player_id], score: 7 },
    { team: 1, player_ids: [gm.blue_player_id], score: 3 },
  ], 'smoke test');
  // The paying book is margined: no cell may return its own break-even.
  const maxCellEv = Math.max(...gm.odds!.outcomes.map(o => o.prob * o.decimalOdds));
  assert(maxCellEv <= 1 - HOUSE_MARGIN + 1e-9, `bookie margin: max cell EV ${maxCellEv.toFixed(4)} < 1`);
  const odds73 = gm.odds!.outcomes.find(o => o.redScore === 7)!.decimalOdds;
  const expectedPayout = Math.floor(100 * odds73) + Math.floor(50 * odds73);
  assert(!summary.returnsCapped && summary.returns === expectedPayout, 'correct picks paid stake x margined odds');
  assert(summary.returns <= summary.payoutCap, 'payouts under the two-pot cap');
  assert(summary.pot.houseFee === 10, 'house takes 10% of combined entry (100 → 90)');
  assert(summary.playerEntry[0]?.returned === Math.floor((90 * 7) / 10) && summary.playerEntry[1]?.returned === Math.floor((90 * 3) / 10),
    'entries: 90 split 63/27 by score share (house fee off the top first)');
  assert(summary.leftover < 0 && summary.pot.houseLoss === -summary.leftover,
    `house covers shortfall exactly incl. fees (${summary.pot.houseLoss})`);
  assert(summary.entryEvenHit === false && summary.payoutLine === 'true_even',
    'plain challenge: no evens line, split stayed by score');

  // double settle blocked via CAS
  blocked = false;
  try {
    settleGambleMatch(gm.id, [
      { team: 0, player_ids: [gm.red_player_id], score: 7 },
      { team: 1, player_ids: [gm.blue_player_id], score: 3 },
    ]);
  } catch { blocked = true; }
  assert(blocked, 're-settle blocked by CAS guard');

  const matchCount = (db.prepare(`SELECT COUNT(*) n FROM matches`).get() as { n: number }).n;
  assert(matchCount === 1, 'processMatch recorded exactly one real match');
  assert(getBets(gm.id).every(b => b.status === 'lost' || b.status === 'won'), 'both correct picks marked won');

  // ============ challenge B: draw, single winning bet ======================
  const scheduledB = localIn(FUTURE);
  const c2 = createChallenge(gameId, blueId, redId, { entryFee: fee, scheduledAt: scheduledB, side: 'blue' });
  const acc2 = respondToChallenge(c2, redId, 'accept');
  const gmB = acc2.gambleMatch!;
  const odds55 = gmB.odds!.outcomes.find(o => o.redScore === 5 && o.blueScore === 5)!.decimalOdds;
  placeBet(gmB.id, g1, 5, 5, 25);
  fastForward(gmB.id);
  const sumB = settleGambleMatch(gmB.id, [
    { team: 0, player_ids: [gmB.red_player_id], score: 5 },
    { team: 1, player_ids: [gmB.blue_player_id], score: 5 },
  ]);
  assert(sumB.betPayments.length === 1 && sumB.betPayments[0].status === 'won'
    && sumB.betPayments[0].payout === Math.floor(25 * odds55), 'draw: 5-5 pick paid stake x odds');
  assert(sumB.pot.winnerPlayerId === null && sumB.pot.winnerShare === 0, 'draw: winner quarter not paid to a player');
  assert(sumB.playerEntry.reduce((s, e) => s + e.returned, 0) === 2 * Math.floor(90 * 0.5), 'draw: 90 entries split 50/50');

  // ============ challenge C: no bets at all, straight pot ==================
  const scheduledC = localIn(FUTURE);
  const c3 = createChallenge(gameId, redId, blueId, { entryFee: 30, scheduledAt: scheduledC, side: 'red' });
  const gmC = respondToChallenge(c3, blueId, 'accept').gambleMatch!;
  assert(getBetPool(gmC.id) === 0, 'no bets: empty pool');
  fastForward(gmC.id);
  const sumC = settleGambleMatch(gmC.id, [
    { team: 0, player_ids: [gmC.red_player_id], score: 8 },
    { team: 1, player_ids: [gmC.blue_player_id], score: 2 },
  ]);
  assert(sumC.pool === 0 && sumC.pot.positive, 'no bets: positive pot from fee hold');
  assert(sumC.pot.houseFee === 6 && sumC.playerEntry.reduce((s, e) => s + e.returned, 0) === Math.floor((54 * 8) / 10) + Math.floor((54 * 2) / 10),
    'no bets: house fee 6, players split 54 by score (43+10)');
  assert(sumC.pot.house + sumC.pot.winnerShare + sumC.pot.scoreShares.reduce((s, x) => s + x.amount, 0) === sumC.leftover,
    'no bets: pot split fully accounted');

  // ============ cancel path (fees + stake refunds, net zero) ===============
  const scheduledD = localIn(FUTURE);
  const c4 = createChallenge(gameId, blueId, redId, { entryFee: fee, scheduledAt: scheduledD, side: 'blue' });
  const gmD = respondToChallenge(c4, redId, 'accept').gambleMatch!;
  placeBet(gmD.id, g1, 5, 5, 25);
  const preRed = bank.getBalance(redId);
  const preG1 = bank.getBalance(g1);
  cancelGambleMatch(gmD.id);
  assert(bank.getBalance(redId) === preRed + fee, 'cancel refunds entry fee');
  assert(bank.getBalance(g1) === preG1 + 25, 'cancel refunds open stake');
  assert(getChallenge(c4)!.status === 'cancelled', 'cancel closes the challenge');
  assert(getBets(gmD.id).every(b => b.status === 'refunded'), 'cancelled bets marked refunded');

  // ============ challenge F: broadcast + custom payout line ================
  const c6 = createChallenge(gameId, blueId, null, {
    entryFee: fee, scheduledAt: localIn(FUTURE), side: 'blue',
    payoutLine: '7-3', specialRules: 'smoke: no jumpers, loser wipes the table',
  });
  assert(getChallenge(c6)!.status === 'pending', 'broadcast challenge created pending');
  assert(getChallenge(c6)!.opponent_id === null, 'broadcast challenge has no opponent');
  assertThrows('broadcast counter refused (counter_not_allowed)',
    () => respondToChallenge(c6, g2, 'counter', { entryFee: fee, scheduledAt: localIn(FUTURE), side: 'red' }),
    'counter_not_allowed');
  assertThrows('broadcast decline-by-outsider refused (not_a_participant)',
    () => respondToChallenge(c6, g2, 'decline'), 'not_a_participant');
  assertThrows('challenger cannot accept their own broadcast (not_your_turn)',
    () => respondToChallenge(c6, blueId, 'accept'), 'not_your_turn');

  const acc6 = respondToChallenge(c6, g1, 'accept'); // first to accept
  const gmF = acc6.gambleMatch!;
  assert(gmF.red_player_id === g1 && gmF.blue_player_id === blueId,
    "broadcast accept: challenger took blue, acceptor took red");
  assert(gmF.payout_line === '7-3' && gmF.special_rules === 'smoke: no jumpers, loser wipes the table',
    'broadcast freezes its payout line + special rules onto the match');

  // One winning correct-score bet and one losing bet keep the pot positive.
  const odds73F = gmF.odds!.outcomes.find(o => o.redScore === 7)!.decimalOdds;
  placeBet(gmF.id, g2, 7, 3, 2);
  placeBet(gmF.id, redId, 8, 2, 100);
  fastForward(gmF.id);
  const sumF = settleGambleMatch(gmF.id, [
    { team: 0, player_ids: [gmF.red_player_id], score: 7 },
    { team: 1, player_ids: [gmF.blue_player_id], score: 3 },
  ]);
  assert(sumF.payoutLine === '7-3', 'custom payout line survives to settlement');
  assert(sumF.entryEvenHit === true, 'custom line 7-3 hit → entries split 50/50 even with a real winner');
  assert(sumF.playerEntry[0]?.returned === 45 && sumF.playerEntry[1]?.returned === 45,
    'evens line: 90 entries split 45/45 despite 7-3');
  assert(sumF.returns === Math.floor(2 * odds73F), 'broadcast bet paid the frozen 7-3 price');
  assert(sumF.pot.positive && sumF.pot.winnerPlayerId === gmF.red_player_id && sumF.pot.winnerShare > 0,
    'pot winner quarter still follows the actual winner on a custom line');

  // ============ casino cap: oversized bets refused at placement ============
  // No single pick may pay more than the house bank pot (floor 100) — the
  // place-time guard refuses it, so the settle cap is a never-expected backstop.
  const scheduledE = localIn(FUTURE);
  const c5 = createChallenge(gameId, redId, blueId, { entryFee: fee, scheduledAt: scheduledE, side: 'red' });
  const gmE = respondToChallenge(c5, blueId, 'accept').gambleMatch!;
  const odds100E = gmE.odds!.outcomes.find(o => o.redScore === 10 && o.blueScore === 0)!.decimalOdds;
  const houseBeforeE = bank.getHouseBalance();
  const housePotE = Math.max(houseBeforeE, 100); // BASE_POT_MINIMUM
  const maxStakeE = Math.floor((housePotE - 1) / odds100E);
  assertThrows('bet paying above the bank pot refused (bet_exceeds_pot)',
    () => placeBet(gmE.id, g1, 10, 0, maxStakeE + 1), 'bet_exceeds_pot');
  placeBet(gmE.id, g1, 10, 0, maxStakeE); // the biggest payable stake
  fastForward(gmE.id);
  const sumE = settleGambleMatch(gmE.id, [
    { team: 0, player_ids: [gmE.red_player_id], score: 10 },
    { team: 1, player_ids: [gmE.blue_player_id], score: 0 },
  ]);
  assert(!sumE.returnsCapped && sumE.returns === Math.floor(maxStakeE * odds100E),
    `biggest payable bet pays stake × odds (${maxStakeE} @ ${odds100E})`);
  assert(sumE.returns <= sumE.payoutCap, 'settle-backstop cap still respected');
  assert(bank.getHouseBalance() >= 1, `house pot never drains below 1 (now ${bank.getHouseBalance()})`);

  // ============ challenge G: expiry 5 minutes before the start =============
  const preG_red = bank.getBalance(redId);
  const preG_blue = bank.getBalance(blueId);
  const c7 = createChallenge(gameId, redId, blueId, { entryFee: fee, scheduledAt: localIn(EXPIRED), side: 'red' });
  syncStatuses();
  assert(getChallenge(c7)!.status === 'expired', 'challenge within the 5-min window auto-expires');
  assertThrows('accepting an expired challenge refused (challenge_expired)',
    () => respondToChallenge(c7, blueId, 'accept'), 'challenge_expired');
  assert(bank.getBalance(redId) === preG_red && bank.getBalance(blueId) === preG_blue, 'expiry moves no money');

  // ============ challenge H: auto-cancel when results are 15 min late ======
  const c8 = createChallenge(gameId, blueId, redId, { entryFee: fee, scheduledAt: localIn(FUTURE), side: 'blue' });
  const gmH = respondToChallenge(c8, redId, 'accept').gambleMatch!;
  // The house pot is small by now (E paid out its winner) — stake the most
  // the pot will pay on 3-7.
  const odds37H = gmH.odds!.outcomes.find(o => o.redScore === 3 && o.blueScore === 7)!.decimalOdds;
  const stakeH = Math.max(GAMBLE_RULES.minStake,
    Math.floor((Math.max(bank.getHouseBalance(), 100) - 1) / odds37H));
  placeBet(gmH.id, g1, 3, 7, stakeH);
  const preRedH = bank.getBalance(redId);
  const preBlueH = bank.getBalance(blueId);
  const preG1H = bank.getBalance(g1);
  // Overdue: results not in by 15 min after the deadline — backdate past the
  // overdue window (this skips the settled path entirely) and sync.
  db.prepare(`UPDATE gamble_matches
    SET scheduled_at = datetime('now','-16 minutes'), bet_close_at = datetime('now','-18 minutes')
    WHERE id = ?`).run(gmH.id);
  syncStatuses();
  assert(getGambleMatch(gmH.id)!.status === 'cancelled', 'overdue gamble auto-cancels 15 min past deadline');
  assert(getChallenge(c8)!.status === 'cancelled', 'auto-cancel closes the challenge');
  assert(bank.getBalance(redId) === preRedH + fee && bank.getBalance(blueId) === preBlueH + fee,
    'auto-cancel: both entry fees refunded');
  assert(bank.getBalance(g1) === preG1H + stakeH, 'auto-cancel refunds open stakes');

  // ============ conservation across everything =============================
  const conservation = ids.reduce((s, id) => s + bank.getBalance(id), 0) + bank.getHouseBalance();
  assert(conservation === ids.length * 1000 + HOUSE_SEED, `ledger identity holds across all cases (got ${conservation})`);

  console.log('challenge A pot:', JSON.stringify(summary.pot));
  console.log('challenge B pot:', JSON.stringify(sumB.pot));
  console.log('challenge C pot:', JSON.stringify(sumC.pot));
  console.log('challenge E (pot-capped stake): returns', sumE.returns, 'cap', sumE.payoutCap, 'pot', JSON.stringify(sumE.pot));
  console.log('challenge F (broadcast 7-3 line): returns', sumF.returns, 'pot', JSON.stringify(sumF.pot));
}

main().catch(e => { console.error(e); process.exit(1); });