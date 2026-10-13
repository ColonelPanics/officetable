// Gambling state machine: challenge negotiation, gamble-match lifecycle,
// and settlement math. All money is virtual moose bucks routed through
// lib/bank.ts inside the transactions this module owns.
//
// Invariant: money only ever moves at accept (entry fees), bet placement
// (stakes), settle (payouts/shares) and cancel (refunds) — so a decline or
// counter can never strand a fee.

import db from './db';
import { processMatch, correctMatch } from './elo';
import { getBank, assertBankLinked, kickBankSync, alcesMirrorEnabled } from './bank';
import { computeOddsLadder } from './gambleOdds';
import { announceBetsClosed, announceCancelled } from './gambleNotifications';
import { normaliseStartDate, toDbDate } from './seasons';
import type {
  Bet,
  Challenge,
  ChallengeTerm,
  GambleMatch,
  GambleMatchStatus,
  OddsLadder,
  ScoreOutcome,
  CorrectScoreSummary,
  SettleSummary,
} from './types';

// Every tunable rule in one place — change here, never schema surgery.
export const GAMBLE_RULES = {
  /** Starting balance for a first-seen account. */
  seedBalance: 1000,
  /** Default + bounds for the (negotiable) per-player entry fee. */
  defaultEntryFee: 50,
  minEntryFee: 10,
  maxEntryFee: 500,
  minStake: 1,
  /** Bets close this many minutes before the scheduled start. */
  betCloseLeadMinutes: 2,
  /** Leftover pot split (spec text: 50/25/25; draw → winner share to house). */
  potSplit: { house: 0.5, winner: 0.25, scoreShare: 0.25 },
  /**
   * House fee on entries: the combined entry loses 10% to the bank before
   * the rest is split between the players by score share (100 → 90).
   */
  houseFeeRate: 0.10,
  /** Challenges expire unless accepted this many minutes before the deadline. */
  challengeExpiryLeadMinutes: 5,
  /** Games with no result this many minutes after the deadline are voided (refunds). */
  resultDeadlineMinutes: 15,
  /** Cap on the free-text special rules note. */
  maxSpecialRulesLength: 500,
} as const;

/** Mock-mode floor under the casino's payout exposure guard: the local casino
 *  stands behind every bet with at least this (it mints, so it's backed).
 *  Mirror mode deliberately does NOT use it — see placeBet. */
const BASE_POT_MINIMUM = 100;

/**
 * Payout lines (stored format): 'true_even' = a literal draw (5-5);
 * 'elo_even' = the bookie's frozen predicted line; otherwise a custom
 * 'R-B' scoreline with R+B = the game total and both halves 1-9 —
 * 10-0 / 0-10 are deliberately not choosable as an even line.
 */
export function parsePayoutLine(value: unknown, total: number): string | null {
  if (value === undefined) return 'true_even';
  if (typeof value !== 'string') return null;
  if (value === 'true_even' || value === 'elo_even') return value;
  const m = /^([0-9]+)-([0-9]+)$/.exec(value);
  if (!m) return null;
  const red = parseInt(m[1], 10);
  const blue = parseInt(m[2], 10);
  if (red < 1 || red > 9 || blue < 1 || blue > 9 || red + blue !== total) return null;
  return value;
}

export function payoutLineLabel(line: string): string {
  if (line === 'true_even') return 'true even (5-5)';
  if (line === 'elo_even') return "bookie's line";
  return `${line} (custom)`;
}

const bank = getBank();
const nowDbDate = (): string => toDbDate(new Date());

export class GambleError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Status sync (lazy — no cron; read/write paths call this first)
// ---------------------------------------------------------------------------

/** Lazy clock transitions — no cron, every gambling route runs this first:
 *  1. open → awaiting_score once the bet window has passed;
 *  2. pending/countered challenges expire once the deadline is close enough
 *     that accepted gambles would have no betting window left;
 *  3. unsettled gamble matches are voided (full refunds) once the result is
 *     more than N minutes overdue — with a Chat note. */
export function syncStatuses(): void {
  // NOTE: no bank-sync kick here — this runs on every route including
  // read-only GETs, and a non-empty backlog would turn page views into a
  // flood of transfers against the bank's API. Only the money-moving paths
  // (accept / bet / settle / cancel) kick the drain.
  // Bets window closed → the match must be played now: announce once, right
  // as the matched rows flip open → awaiting_score (this function runs on
  // every route, so only rows ACTUALLY changed here may trigger a message).
  const closing = db.prepare(`
    SELECT gm.id, gm.red_player_id, gm.blue_player_id, g.name AS game_name,
           red.name AS red_player_name,
           blue.name AS blue_player_name
    FROM gamble_matches gm
    JOIN games g ON g.id = gm.game_id
    JOIN players red ON red.id = gm.red_player_id
    JOIN players blue ON blue.id = gm.blue_player_id
    WHERE gm.status = 'open' AND gm.bet_close_at <= ?
  `).all(nowDbDate()) as { id: number; red_player_id: number; blue_player_id: number; red_player_name: string; blue_player_name: string; game_name: string }[];
  if (closing.length) {
    db.prepare(`
      UPDATE gamble_matches SET status = 'awaiting_score'
      WHERE status = 'open' AND bet_close_at <= ?
    `).run(nowDbDate());
    for (const gm of closing) {
      announceBetsClosed(gm as unknown as GambleMatch).catch(() => {});
      console.log(`gamble match ${gm.id}: bets closed — awaiting score`);
    }
  }

  db.prepare(`
    UPDATE challenges SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('pending', 'countered')
      AND scheduled_at <= datetime('now', '+${GAMBLE_RULES.challengeExpiryLeadMinutes} minutes')
  `).run();

  const overdue = db.prepare(`
    SELECT id FROM gamble_matches
    WHERE status IN ('open', 'awaiting_score')
      AND scheduled_at <= datetime('now', '-${GAMBLE_RULES.resultDeadlineMinutes} minutes')
  `).all() as { id: number }[];
  for (const { id } of overdue) {
    try {
      const gm = getGambleMatch(id)!;
      cancelGambleMatch(id);
      announceCancelled(gm, getBetPool(id) + 2 * gm.entry_fee).catch(() => {});
      console.log(`gamble match ${id} auto-cancelled — result missed the ${GAMBLE_RULES.resultDeadlineMinutes}-minute deadline`);
    } catch (e) {
      console.error(`auto-cancel failed for gamble match ${id}:`, e);
    }
  }
}

/** Derived status + seconds-to-close for the UI (bets closing is clock-derived). */
export function deriveStatus(
  gm: Pick<GambleMatch, 'status' | 'bet_close_at'>
): { status: GambleMatchStatus | 'bets_closed'; secondsToClose: number } {
  if (gm.status !== 'open') return { status: gm.status, secondsToClose: 0 };
  const closeMs = new Date(gm.bet_close_at.replace(' ', 'T') + 'Z').getTime();
  const nowMs = Date.now();
  if (nowMs >= closeMs) return { status: 'bets_closed', secondsToClose: 0 };
  return { status: 'open', secondsToClose: Math.floor((closeMs - nowMs) / 1000) };
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export interface ChallengeTermsInput {
  entryFee: number;
  scheduledAt: string;
  side: 'red' | 'blue';
  /** Negligible term — the scoreline whose result pays the entries 50/50. */
  payoutLine?: string;
  /** Free-text house rules shown to gamblers; never affects the odds. */
  specialRules?: string;
}

function validateSpecialRules(specialRules: string | undefined): string | null {
  const text = specialRules?.trim() ?? '';
  if (text.length > GAMBLE_RULES.maxSpecialRulesLength) {
    return `Special rules must be at most ${GAMBLE_RULES.maxSpecialRulesLength} characters`;
  }
  return null;
}

function validateTerms(terms: ChallengeTermsInput): string | null {
  if (!Number.isInteger(terms.entryFee) || terms.entryFee < GAMBLE_RULES.minEntryFee || terms.entryFee > GAMBLE_RULES.maxEntryFee) {
    return `Entry fee must be a whole number of moose bucks between ${GAMBLE_RULES.minEntryFee} and ${GAMBLE_RULES.maxEntryFee}`;
  }
  let scheduled: string;
  try {
    scheduled = normaliseStartDate(terms.scheduledAt);
  } catch {
    return 'Scheduled time could not be parsed';
  }
  if (new Date(scheduled.replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
    return 'Scheduled time must be in the future';
  }
  return validateSpecialRules(terms.specialRules);
}

/**
 * Create a challenge. No money moves yet — fees are debited on accept.
 * Betting is restricted to fixed-total games (the market is the exact score).
 * `opponentId === null` means a BROADCAST challenge: nobody is picked, any
 * non-challenger may accept, and countering is off — the accepted side comes
 * from the terms, the acceptor takes the other side. Broadcast challenges
 * expire by the same deadline rule (and, unaccepted, they simply time out).
 */
export function createChallenge(
  gameId: number,
  challengerId: number,
  opponentId: number | null,
  terms: ChallengeTermsInput
): number {
  const game = db.prepare(`SELECT id, name, score_type, score_value FROM games WHERE id = ?`)
    .get(gameId) as { id: number; name: string; score_type: string; score_value: number } | undefined;
  if (!game) throw new GambleError('Unknown game', 'unknown_game');
  if (game.score_type !== 'best_of') {
    throw new GambleError(`Betting is only set up for fixed-total games (${game.name} is "${game.score_type}")`, 'unsupported_game');
  }
  const broadcast = opponentId === null;
  if (!broadcast && challengerId === opponentId) {
    throw new GambleError('You cannot challenge yourself', 'same_player');
  }
  // Money moves at accept — the bank (central or mock) has to know both
  // parties by then, so gate it here for the challenger (opponent at accept).
  assertBankLinked(challengerId);

  const known = broadcast
    ? db.prepare(`SELECT COUNT(*) as n FROM players WHERE id = ?`).get(challengerId) as { n: number }
    : db.prepare(`SELECT COUNT(*) as n FROM players WHERE id IN (?, ?)`).get(challengerId, opponentId) as { n: number };
  if (known.n !== (broadcast ? 1 : 2)) throw new GambleError('Unknown player', 'unknown_player');

  const error = validateTerms(terms);
  if (error) throw new GambleError(error, 'bad_terms');
  const payoutLine = parsePayoutLine(terms.payoutLine, game.score_value);
  if (!payoutLine) {
    throw new GambleError("Payout line must be 'true_even', 'elo_even' or a scoreline from 9-1 to 1-9 that sums to the game total", 'bad_terms');
  }
  const side = terms.side === 'blue' ? 'blue' : 'red';
  // Broadcast challenges with the challenger taking blue can't know red yet —
  // red_player_id stays NULL until someone accepts.
  const redPlayerId = broadcast
    ? (side === 'red' ? challengerId : null)
    : (side === 'red' ? challengerId : opponentId);

  const scheduled = normaliseStartDate(terms.scheduledAt);
  const specialRules = terms.specialRules?.trim() ?? null;

  return db.transaction((): number => {
    const result = db.prepare(`
      INSERT INTO challenges (
        game_id, challenger_id, opponent_id, entry_fee, scheduled_at,
        red_player_id, challenger_side, status, terms_by, broadcast, payout_line, special_rules
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(gameId, challengerId, broadcast ? null : opponentId, terms.entryFee, scheduled, redPlayerId, side, challengerId, broadcast ? 1 : 0, payoutLine, specialRules);
    const challengeId = result.lastInsertRowid as number;

    db.prepare(`
      INSERT INTO challenge_terms (challenge_id, entry_fee, scheduled_at, red_player_id, proposed_by, payout_line, special_rules)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(challengeId, terms.entryFee, scheduled, redPlayerId, challengerId, payoutLine, specialRules);

    return challengeId;
  })();
}

function futureScheduledAt(input: string): string {
  const scheduled = normaliseStartDate(input);
  if (new Date(scheduled.replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
    throw new GambleError('Scheduled time must be in the future', 'bad_terms');
  }
  return scheduled;
}

/**
 * Respond to a challenge:
 *  - accept: debits both entry fees, freezes an odds ladder, opens the gamble match
 *  - counter: replaces terms, hands the pen back to the other player (never
 *    allowed on broadcasts)
 *  - decline / cancel: terminal; no fees were paid, nothing to refund
 * Direct challenges respond by the player who did NOT author the current
 * terms (terms_by); either participant may cancel. Broadcast challenges may
 * be accepted by any non-challenger (they take the opposite side) and are
 * withdrawn/cancelled by the challenger only.
 */
export function respondToChallenge(
  challengeId: number,
  playerId: number,
  action: 'accept' | 'decline' | 'cancel' | 'counter',
  counter?: ChallengeTermsInput
): { challenge: Challenge; gambleMatch?: GambleMatch; ladder?: OddsLadder; balances?: { challenger: number; opponent: number } } {
  syncStatuses();
  const challenge = getChallenge(challengeId);
  if (!challenge) throw new GambleError('Challenge not found', 'not_found');
  if (challenge.status === 'expired') {
    throw new GambleError(
      `This challenge expired — it has to be accepted by ${GAMBLE_RULES.challengeExpiryLeadMinutes} minutes before the deadline`,
      'challenge_expired'
    );
  }
  if (challenge.status !== 'pending' && challenge.status !== 'countered') {
    throw new GambleError(`Challenge is already ${challenge.status}`, 'not_negotiable');
  }

  const broadcast = challenge.broadcast === 1;
  const isChallenger = playerId === challenge.challenger_id;
  const isOpponent = !broadcast && playerId === challenge.opponent_id;

  if (broadcast) {
    if (action === 'counter') {
      throw new GambleError('Countering is not allowed on broadcast challenges — accept it or move on', 'counter_not_allowed');
    }
    if (action === 'decline' && !isChallenger) {
      throw new GambleError('Only the challenger can withdraw a broadcast challenge', 'not_a_participant');
    }
    if (action !== 'accept' && !isChallenger) {
      throw new GambleError('Only the challenger can cancel a broadcast challenge', 'not_a_participant');
    }
  } else if (!isChallenger && !isOpponent) {
    throw new GambleError('Only the two players can respond to this challenge', 'not_a_participant');
  }

  if (action === 'cancel') {
    db.prepare(`UPDATE challenges SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(challengeId);
    return { challenge: getChallenge(challengeId)! };
  }

  // Turn guard — except a third party taking a broadcast challenge, whose
  // accept is exactly the point of a broadcast.
  if (!(broadcast && !isChallenger && action === 'accept') && playerId === challenge.terms_by) {
    throw new GambleError('You proposed the current terms — it is the other player’s turn', 'not_your_turn');
  }

  if (action === 'decline') {
    db.prepare(`UPDATE challenges SET status = 'declined', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(challengeId);
    return { challenge: getChallenge(challengeId)! };
  }

  if (action === 'counter') {
    if (!counter) throw new GambleError('Counter requires new terms', 'bad_counter');
    validateTerms(counter); // throws GambleError('bad_terms') — no future-time check here, only shape
    const scheduled = futureScheduledAt(counter.scheduledAt);
    const payoutLine = parsePayoutLine(counter.payoutLine, getGameTotal(challenge.game_id));
    if (!payoutLine) {
      throw new GambleError("Payout line must be 'true_even', 'elo_even' or a scoreline from 9-1 to 1-9 that sums to the game total", 'bad_terms');
    }
    const specialRulesError = validateSpecialRules(counter.specialRules);
    if (specialRulesError) throw new GambleError(specialRulesError, 'bad_terms');
    const specialRules = counter.specialRules?.trim() ?? null;
    const redPlayerId = counter.side === 'red' ? challenge.challenger_id : challenge.opponent_id!;

    db.transaction(() => {
      db.prepare(`
        UPDATE challenges
        SET entry_fee = ?, scheduled_at = ?, red_player_id = ?, challenger_side = ?, payout_line = ?, special_rules = ?,
            status = 'countered', terms_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(counter.entryFee, scheduled, redPlayerId, counter.side, payoutLine, specialRules, playerId, challengeId);

      db.prepare(`
        INSERT INTO challenge_terms (challenge_id, entry_fee, scheduled_at, red_player_id, proposed_by, payout_line, special_rules)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(challengeId, counter.entryFee, scheduled, redPlayerId, playerId, payoutLine, specialRules);
    })();

    return { challenge: getChallenge(challengeId)! };
  }

  // ---- accept: fees + frozen odds + gamble match in one transaction ----
  const game = db.prepare(`SELECT score_value FROM games WHERE id = ?`)
    .get(challenge.game_id) as { score_value: number };
  const fee = challenge.entry_fee;
  const side = challenge.challenger_side === 'blue' ? 'blue' : 'red';
  const broadcastAccept = broadcast && !isChallenger;
  // A broadcast acceptor takes the opposite side to the challenger; normal
  // challenges keep the agreed red/blue assignment.
  const redPlayerId = broadcastAccept
    ? (side === 'red' ? challenge.challenger_id : playerId)
    : challenge.red_player_id ?? (side === 'red' ? challenge.challenger_id : challenge.opponent_id!);
  const bluePlayerId = broadcastAccept
    ? (side === 'red' ? playerId : challenge.challenger_id)
    : challenge.red_player_id === challenge.challenger_id
      ? challenge.opponent_id!
      : challenge.challenger_id;

  const ladder = computeOddsLadder({
    gameId: challenge.game_id,
    redPlayerIds: [redPlayerId],
    bluePlayerIds: [bluePlayerId],
    total: game.score_value,
  });
  const betCloseMs = new Date(challenge.scheduled_at.replace(' ', 'T') + 'Z').getTime()
    - GAMBLE_RULES.betCloseLeadMinutes * 60_000;
  const betCloseAt = toDbDate(new Date(betCloseMs));

  // Funds checked before the transaction so the error never half-moves money
  // (the debitChecked guard inside is belt and braces, not the real check).
  const playerIds = broadcastAccept ? [challenge.challenger_id, playerId] : [challenge.challenger_id, challenge.opponent_id!];
  for (const pid of playerIds) {
    assertBankLinked(pid); // both entry fees become real central-bank transfers
    bank.ensureAccount(pid);
    if (bank.getBalance(pid) < fee) {
      throw new GambleError(`Player ${pid} does not have ${fee} moose bucks to enter`, 'insufficient_funds');
    }
  }

  const gambleMatchId = db.transaction((): number => {
    // Claim first: only the first accept of a challenge may open a match —
    // repeated/concurrent accepts (two players racing for a broadcast) must
    // not double-debit entry fees or open two gamble matches.
    const claim = db.prepare(`
      UPDATE challenges SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('pending', 'countered')
    `).run(challengeId);
    if (claim.changes === 0) {
      throw new GambleError('Challenge is already accepted', 'not_negotiable');
    }
    for (const pid of playerIds) {
      bank.debitChecked(pid, fee, { type: 'challenge_fee', id: challengeId, memo: 'entry fee' });
    }

    const result = db.prepare(`
      INSERT INTO gamble_matches
        (challenge_id, game_id, red_player_id, blue_player_id, scheduled_at, bet_close_at, entry_fee, outcome_total, odds_json, status, payout_line, special_rules)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      challengeId, challenge.game_id, redPlayerId, bluePlayerId,
      challenge.scheduled_at, betCloseAt, fee, game.score_value, JSON.stringify(ladder),
      challenge.payout_line ?? 'true_even', challenge.special_rules ?? null
    );
    const gmId = result.lastInsertRowid as number;

    db.prepare(`UPDATE challenges SET gamble_match_id = ? WHERE id = ?`).run(gmId, challengeId);
    return gmId;
  })();

  // Money moved — push the entry-fee movements toward the central bank.
  kickBankSync();

  return {
    challenge: getChallenge(challengeId)!,
    gambleMatch: getGambleMatch(gambleMatchId),
    ladder,
    balances: {
      challenger: bank.getBalance(challenge.challenger_id),
      opponent: bank.getBalance(playerIds[1]),
    },
  };
}

function getGameTotal(gameId: number): number {
  const row = db.prepare(`SELECT score_value FROM games WHERE id = ?`)
    .get(gameId) as { score_value: number } | undefined;
  return row?.score_value ?? 0;
}

export function getChallenge(id: number): Challenge | undefined {
  const row = db.prepare(`
    SELECT c.id, c.game_id, c.challenger_id, c.opponent_id, c.entry_fee, c.scheduled_at,
           c.red_player_id, c.challenger_side, c.broadcast, c.payout_line, c.special_rules,
           c.status, c.terms_by, c.gamble_match_id, c.created_at, c.updated_at,
           g.name as game_name,
           cha.name as challenger_name, opp.name as opponent_name, tu.name as terms_by_name
    FROM challenges c
    JOIN players cha ON cha.id = c.challenger_id
    LEFT JOIN players opp ON opp.id = c.opponent_id
    JOIN players tu ON tu.id = c.terms_by
    LEFT JOIN games g ON g.id = c.game_id
    WHERE c.id = ?
  `).get(id);
  return row as Challenge | undefined;
}

export function getChallengeTerms(challengeId: number): ChallengeTerm[] {
  return db.prepare(`
    SELECT t.*, p.name as proposed_by_name
    FROM challenge_terms t
    JOIN players p ON p.id = t.proposed_by
    WHERE t.challenge_id = ?
    ORDER BY t.id ASC
  `).all(challengeId) as ChallengeTerm[];
}

export function getGambleMatch(id: number): GambleMatch | undefined {
  const row = db.prepare(`
    SELECT gm.*, g.name as game_name,
           red.name as red_player_name, blue.name as blue_player_name
    FROM gamble_matches gm
    JOIN games g ON g.id = gm.game_id
    JOIN players red ON red.id = gm.red_player_id
    JOIN players blue ON blue.id = gm.blue_player_id
    WHERE gm.id = ?
  `).get(id) as GambleMatch | undefined;
  if (!row) return undefined;
  return { ...row, odds: JSON.parse(row.odds_json) as OddsLadder };
}

// ---------------------------------------------------------------------------
// Bets
// ---------------------------------------------------------------------------

/**
 * Place a bet on an exact scoreline. Participants are blocked (match-fixing
 * guard, server-side). Odds are frozen at placement from the accept-time ladder.
 */
export function placeBet(gambleMatchId: number, bettorId: number, redScore: number, blueScore: number, stake: number): number {
  syncStatuses();

  const gm = getGambleMatch(gambleMatchId);
  if (!gm || !gm.odds) throw new GambleError('Gamble match not found', 'not_found');
  if (gm.status !== 'open') {
    throw new GambleError(`Bets are closed (match is ${gm.status})`, 'bets_closed');
  }
  // Clock re-check at write time — never trust the stored status alone.
  if (Date.now() >= new Date(gm.bet_close_at.replace(' ', 'T') + 'Z').getTime()) {
    throw new GambleError(`Bets are closed — the window shut at ${gm.bet_close_at} UTC`, 'bets_closed');
  }
  if (bettorId === gm.red_player_id || bettorId === gm.blue_player_id) {
    throw new GambleError('Players may not bet on their own match (match-fixing guard)', 'participants_may_not_bet');
  }
  if (!Number.isInteger(stake) || stake < GAMBLE_RULES.minStake) {
    throw new GambleError(`Stake must be a whole number of at least ${GAMBLE_RULES.minStake} moose bucks`, 'bad_stake');
  }
  if (!Number.isInteger(redScore) || !Number.isInteger(blueScore)
      || redScore < 0 || blueScore < 0 || redScore + blueScore !== gm.outcome_total) {
    throw new GambleError(`Pick a valid scoreline — the scores must sum to ${gm.outcome_total}`, 'bad_score');
  }

  const outcome: ScoreOutcome | undefined = gm.odds.outcomes
    .find(o => o.redScore === redScore && o.blueScore === blueScore);
  if (!outcome) throw new GambleError('Scoreline not on the odds board', 'bad_score');

  assertBankLinked(bettorId); // a stake is a real central-bank transfer
  bank.ensureAccount(bettorId);
  if (bank.getBalance(bettorId) < stake) {
    throw new GambleError(`Not enough moose bucks: balance ${bank.getBalance(bettorId)} < stake ${stake}`, 'insufficient_funds');
  }

  // Exposure guard — winnings are capped by the CASINO's total bank pot, not
  // the individual match's bet pot: no single player may win more than the
  // house reserve holds (less 1 so the casino never fully busts). Stakes from
  // every match form the bet pot underneath it; this guard sits on top of
  // that so nobody can stake their way past the bank's own pot.
  const samePick = db.prepare(`
    SELECT COALESCE(SUM(stake), 0) as staked
    FROM bets WHERE gamble_match_id = ? AND bettor_id = ? AND status = 'open'
      AND red_score = ? AND blue_score = ?
  `).get(gambleMatchId, bettorId, redScore, blueScore) as { staked: number };
  // Mock mode: the local casino stands behind every bet with at least this
  // (it mints, so the floor is backed by the site's own money).
  // Mirror mode: NO floor — the central bank's real house pot is the only
  // thing winnings can be paid from, and promising an unbacked payout would
  // mint money the bank mirror can never honour (payout credits would fail
  // to drain forever). Cap = real house holdings, or nothing.
  const bankPot = alcesMirrorEnabled()
    ? Math.max(bank.getHouseBalance(), 1)
    : Math.max(bank.getHouseBalance(), BASE_POT_MINIMUM);
  const potentialPayout = Math.floor((samePick.staked + stake) * outcome.decimalOdds);
  if (bankPot <= 1 || potentialPayout > bankPot - 1) {
    const maxStake = Math.max(GAMBLE_RULES.minStake,
      Math.floor((bankPot - 1) / outcome.decimalOdds) - samePick.staked);
    throw new GambleError(
      `Bet too big — that pick would pay ${potentialPayout.toLocaleString()} but the casino's bank pot is ${Math.max(0, bankPot - 1).toLocaleString()}, which is the most anyone can win. Lower the stake (max ~${maxStake}).`,
      'bet_exceeds_pot',
    );
  }

  const betId = db.transaction((): number => {
    bank.debitChecked(bettorId, stake, {
      type: 'bet_stake',
      id: gambleMatchId,
      memo: `picked ${redScore}-${blueScore} at ${outcome.fractional}`,
    });
    const result = db.prepare(`
      INSERT INTO bets (gamble_match_id, bettor_id, red_score, blue_score, stake, decimal_odds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(gambleMatchId, bettorId, redScore, blueScore, stake, outcome.decimalOdds);
    return result.lastInsertRowid as number;
  })();
  // A stake is a real central-bank movement — kick the drain after commit
  // (fire-and-forget; the drain is bounded and breaker-shielded).
  kickBankSync();
  return betId as number;
}

export function getBets(gambleMatchId: number): Bet[] {
  return db.prepare(`
    SELECT b.*, p.name as bettor_name
    FROM bets b JOIN players p ON p.id = b.bettor_id
    WHERE b.gamble_match_id = ?
    ORDER BY b.id DESC
  `).all(gambleMatchId) as Bet[];
}

export function getBetPool(gambleMatchId: number): number {
  return (db.prepare(`
    SELECT COALESCE(SUM(stake), 0) as pool
    FROM bets WHERE gamble_match_id = ? AND status = 'open'
  `).get(gambleMatchId) as { pool: number }).pool;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Record the real match (existing Elo flow) and settle every bet plus the
 * players' entry shares and the pot — all in one transaction. Idempotent via
 * a check-and-set status claim. Teams: team 0 = red, team 1 = blue.
 */
export function settleGambleMatch(
  gambleMatchId: number,
  teams: { team: number; player_ids: number[]; score: number }[],
  notes?: string
): SettleSummary {
  const gm = getGambleMatch(gambleMatchId);
  if (!gm) throw new GambleError('Gamble match not found', 'not_found');

  const redTeam = teams.find(t => t.team === 0);
  const blueTeam = teams.find(t => t.team === 1);
  if (!redTeam || !blueTeam || redTeam.player_ids.length !== 1 || blueTeam.player_ids.length !== 1) {
    throw new GambleError('Provide both teams (team 0 = red, team 1 = blue) with one player each', 'bad_teams');
  }
  const [redPlayerId, bluePlayerId] = [redTeam.player_ids[0], blueTeam.player_ids[0]];
  if (redPlayerId !== gm.red_player_id || bluePlayerId !== gm.blue_player_id) {
    throw new GambleError('Teams do not match the gamble match participants', 'teams_mismatch');
  }

  const redScore = redTeam.score;
  const blueScore = blueTeam.score;
  if (!Number.isInteger(redScore) || !Number.isInteger(blueScore)
      || redScore < 0 || blueScore < 0 || redScore + blueScore !== gm.outcome_total) {
    throw new GambleError(`Scores must be whole numbers summing to ${gm.outcome_total}`, 'bad_score');
  }

  // Score entry is only valid after the betting window shut (clock check,
  // not just status check).
  if (Date.now() < new Date(gm.bet_close_at.replace(' ', 'T') + 'Z').getTime()) {
    throw new GambleError(
      `Too early — betting stays open until ${gm.bet_close_at} UTC; the score can be recorded after the match.`,
      'bets_still_open'
    );
  }

  const settle = db.transaction((): SettleSummary => {
    // Payouts go to both players as real central-bank transfers
    assertBankLinked(redPlayerId);
    assertBankLinked(bluePlayerId);
    // Check-and-set claim: only the first settle wins, repeats error out.
    const claim = db.prepare(`
      UPDATE gamble_matches SET status = 'settled', settled_at = ?
      WHERE id = ? AND status IN ('open', 'awaiting_score')
    `).run(nowDbDate(), gambleMatchId);
    if (claim.changes === 0) {
      throw new GambleError('Match already settled', 'already_settled');
    }

    // 1. Record the real match via the existing Elo flow
    const processed = processMatch({
      game_id: gm.game_id,
      notes: notes ?? undefined,
      teams: [
        { team: 0, player_ids: [redPlayerId], score: redScore },
        { team: 1, player_ids: [bluePlayerId], score: blueScore },
      ],
    }, new Date());

    // 2. Gamblers: correct-score picks are paid stake × frozen odds — but
    //    the casino holds two pots and the payout cap spans exactly them:
    //    the BET POT (staked money this match took in) and the HOUSE POT
    //    (bank reserves). Total payouts may consume both pots but must
    //    leave the casino holding at least 1 moose buck — winners scale
    //    down proportionally when the full book busts that cap.
    const pool = getBetPool(gambleMatchId);
    const payoutCap = Math.max(0, pool + bank.getHouseBalance() - 1);
    const openBets: Bet[] = db.prepare(`
      SELECT b.*, p.name as bettor_name
      FROM bets b JOIN players p ON p.id = b.bettor_id
      WHERE b.gamble_match_id = ? AND b.status = 'open'
      ORDER BY b.id ASC
    `).all(gambleMatchId) as Bet[];

    let fullReturns = 0;
    const fullPayout = new Map<number, number>();
    for (const bet of openBets) {
      if (bet.red_score === redScore && bet.blue_score === blueScore) {
        const full = Math.floor(bet.stake * bet.decimal_odds);
        fullPayout.set(bet.id, full);
        fullReturns += full;
      }
    }
    const capped = fullReturns > payoutCap;

    let returns = 0;
    const betPayments: SettleSummary['betPayments'] = [];
    for (const bet of openBets) {
      const won = fullPayout.has(bet.id);
      let payout = 0;
      if (won) {
        const full = fullPayout.get(bet.id)!;
        payout = capped ? Math.floor((full * payoutCap) / fullReturns) : full;
        bank.credit(bet.bettor_id, payout, { type: 'gambler_payout', id: gambleMatchId, memo: capped ? `won gamble bet #${bet.id} (capped)` : `won gamble bet #${bet.id}` });
        returns += payout;
      }
      db.prepare(`UPDATE bets SET status = ?, payout = ? WHERE id = ?`).run(won ? 'won' : 'lost', payout, bet.id);
      betPayments.push({
        bettor_id: bet.bettor_id,
        bettor_name: bet.bettor_name ?? `player ${bet.bettor_id}`,
        pick: `${bet.red_score}-${bet.blue_score}`,
        stake: bet.stake,
        status: won ? 'won' : 'lost',
        payout,
      });
    }

    // 3. The house pays itself next: 10% of the combined entry is bank
    //    revenue off the top ("100 becomes 90"), then the players split the
    //    remaining 90% of their entries by their score share — unless the
    //    final score lands on the challenge's negotiated EVENS LINE ('5-5'
    //    by default, or 'elo_even' / a custom '7-3'-style line), in which
    //    case the entry splits 50/50. The match still has a winner and the
    //    pot logic stays score-based; only the entry payout goes even.
    const entriesPool = 2 * gm.entry_fee;
    const houseFee = Math.floor(entriesPool * GAMBLE_RULES.houseFeeRate);
    if (houseFee > 0) {
      bank.credit(null, houseFee, { type: 'house_fee', id: gambleMatchId, memo: '10% house fee on entries' });
    }
    const playersPool = entriesPool - houseFee;
    // The scoreline the entries pay even on: frozen bookie line for
    // 'elo_even', the stored custom 'R-B'; 'true_even' means a literal 5-5.
    const line = gm.payout_line ?? 'true_even';
    const evenScoreline = line === 'elo_even' ? (gm.odds?.predictedLine ?? '')
      : line === 'true_even' ? '' : line;
    const entryEvenHit = evenScoreline !== ''
      ? `${redScore}-${blueScore}` === evenScoreline
      : redScore === blueScore;
    const participants: { playerId: number; score: number }[] = [
      { playerId: redPlayerId, score: redScore },
      { playerId: bluePlayerId, score: blueScore },
    ];
    const playerEntry: SettleSummary['playerEntry'] = [];
    let sharesTotal = 0;
    for (const { playerId, score } of participants) {
      const returned = entryEvenHit
        ? Math.floor(playersPool / 2)
        : Math.floor((playersPool * score) / gm.outcome_total);
      sharesTotal += returned;
      if (returned > 0) {
        bank.credit(playerId, returned, {
          type: 'player_share',
          id: gambleMatchId,
          memo: entryEvenHit
            ? `evens-line payout (line ${line}) — half of ${playersPool}`
            : `entry share ${score}/${gm.outcome_total} of ${playersPool} (${Math.round(GAMBLE_RULES.houseFeeRate * 100)}% of ${gm.entry_fee} entry)`,
        });
      }
      playerEntry.push({ playerId, fee: gm.entry_fee, returned });
    }

    // 4. The pot = everything banked (stakes + both entry fees) minus what
    //    has been paid out (gambler payouts, the house fee, entry shares).
    //    Positive pot → 50% house / 25% winner / 25% by score share
    //    (draw → winner quarter to house). The casino-wide payout cap
    //    bounds the downside; a book that beats the pool but not the
    //    casino still lands the shortfall on the house below.
    const hold = pool + entriesPool;
    const leftover = hold - returns - houseFee - sharesTotal;

    // Split only what's left; every player/winner share is floored so the
    // rounding dust lands on the house and the ledger balances exactly.
    let houseCut = leftover > 0 ? Math.floor(leftover * GAMBLE_RULES.potSplit.house) : 0;
    let winnerShare = 0;
    let winnerPlayerId: number | null = null;
    let houseLoss = 0;
    const scoreShares: { playerId: number; amount: number }[] = [];
    const winnerQuarter = Math.floor(leftover * GAMBLE_RULES.potSplit.winner);
    const scoreQuarter = Math.floor(leftover * GAMBLE_RULES.potSplit.scoreShare);
    const isDraw = redScore === blueScore;

    if (leftover > 0) {
      winnerPlayerId = isDraw ? null : (redScore > blueScore ? redPlayerId : bluePlayerId);
      if (winnerPlayerId !== null && winnerQuarter > 0) {
        bank.credit(winnerPlayerId, winnerQuarter, { type: 'pot_winner_share', id: gambleMatchId, memo: 'match winner pot share' });
        winnerShare = winnerQuarter;
      }
      // On a draw the winner quarter keeps the houseCut value above.

      let scoreShareTotal = 0;
      for (let i = 0; i < participants.length; i++) {
        const amount = Math.floor((scoreQuarter * participants[i].score) / gm.outcome_total);
        if (amount > 0) {
          bank.credit(participants[i].playerId, amount, { type: 'pot_score_share', id: gambleMatchId, memo: 'pot score share' });
        }
        scoreShares.push({ playerId: participants[i].playerId, amount });
        scoreShareTotal += amount;
      }

      // House takes whatever the floored shares didn't eat — the base 50%
      // cut plus all rounding dust (and the whole quarter on a draw,
      // where winnerShare stays 0). Sum of shares == leftover exactly.
      houseCut = leftover - (winnerShare + scoreShareTotal);
      if (houseCut > 0) {
        bank.credit(null, houseCut, { type: 'pot_house_cut', id: gambleMatchId, memo: isDraw ? 'house cut (draw)' : 'house cut' });
      } else {
        houseCut = 0;
      }
    } else if (leftover < 0) {
      houseLoss = -leftover;
      bank.debit(null, houseLoss, { type: 'house_loss', id: gambleMatchId, memo: 'pot negative — house covered the shortfall' });
    }

    db.prepare(`UPDATE gamble_matches SET status = 'settled', match_id = ?, settled_at = ? WHERE id = ?`)
      .run(processed.matchId, nowDbDate(), gambleMatchId);

    return {
      gambleMatchId,
      matchId: processed.matchId,
      finalScore: { red: redScore, blue: blueScore },
      pool,
      returns,
      payoutCap,
      returnsCapped: capped,
      payoutLine: line,
      entryEvenHit,
      leftover,
      betPayments,
      pot: {
        positive: leftover > 0,
        house: houseCut,
        houseFee,
        winnerPlayerId,
        winnerShare,
        scoreShares,
        houseLoss,
      },
      playerEntry,
    };
  });

  const summary = settle();
  // Payouts/fees moved — push them toward the central bank (bounded drain).
  kickBankSync();
  return summary;
}


// ---------------------------------------------------------------------------
// Score correction (post-settlement)
// ---------------------------------------------------------------------------

/**
 * Correct the final score of a SETTLED gamble match.
 *
 * The recorded office match is re-run through the existing Elo-correction
 * flow (correctMatch replays every later match through both ledgers and
 * fixes achievements) — note it deletes and re-creates the match row under a
 * fresh id, so the gamble match's match_id pointer is updated here instead
 * of left dangling.
 *
 * Every bet's won/lost flag and payout is re-derived from the corrected
 * score (the "ladder" the site shows). NO bank rows are written: the actual
 * money that moved at the original settle stays put, and any true-up between
 * the players and the bookie is done out-of-band (bets.payout becomes the
 * corrected entitlement, bank_transactions stays the audit of what actually
 * moved).
 */
export function correctGambleScore(
  gambleMatchId: number,
  redScore: number,
  blueScore: number,
  notes?: string
): CorrectScoreSummary {
  const gm = getGambleMatch(gambleMatchId);
  if (!gm) throw new GambleError('Gamble match not found', 'not_found');
  if (gm.status !== 'settled') {
    throw new GambleError(`Only a settled gamble can be corrected (this one is ${gm.status})`, 'not_settled');
  }
  if (!gm.match_id) {
    throw new GambleError('Settlement left no recorded match to correct', 'not_settled');
  }
  if (!Number.isInteger(redScore) || !Number.isInteger(blueScore)
      || redScore < 0 || blueScore < 0 || redScore + blueScore !== gm.outcome_total) {
    throw new GambleError(`Scores must be whole numbers summing to ${gm.outcome_total}`, 'bad_score');
  }

  // What the old recorded match said (for the summary/notification)
  const oldParts = db.prepare(`
    SELECT team, score FROM match_participants WHERE match_id = ? AND team IN (0, 1) ORDER BY team
  `).all(gm.match_id) as { team: number; score: number }[];
  const recordedStillExists = oldParts.length === 2;
  const previousScore: { red: number | null; blue: number | null } = recordedStillExists
    ? { red: oldParts[0].score, blue: oldParts[1].score }
    : { red: null, blue: null };

  // Dangling match_id? The office match-history edit (correctMatch) DELETES
  // and re-creates the match row under a fresh id — its Elo/achievements are
  // already correct, so all that's left here is re-pointing the gamble at the
  // re-created match and re-marking the bets (NO Elo work, NO bank rows).
  let targetMatchId = gm.match_id;
  let recordedScores: { red: number; blue: number } | null = recordedStillExists
    ? { red: oldParts[0].score, blue: oldParts[1].score } : null;
  if (!recordedStillExists) {
    // Identify the re-created match: the settle defaults its notes to
    // 'gamble #<id>' (preserved verbatim by correctMatch), played_at is the
    // original settle moment (≈ settled_at), it's flagged is_edited, and
    // carries exactly red@team0 + blue@team1.
    const candidates = db.prepare(`
      SELECT m.id, m.played_at, m.notes,
        GROUP_CONCAT(mp.team || ':' || mp.score) as teams
      FROM matches m
      JOIN match_participants mp ON mp.match_id = m.id
      WHERE m.game_id = ?
        AND m.id > ?
        AND m.is_edited = 1
        AND ABS(strftime('%s', m.played_at) - strftime('%s', ?)) < 600
        AND (SELECT COUNT(*) FROM match_participants c WHERE c.match_id = m.id) = 2
      GROUP BY m.id
      ORDER BY m.id ASC
    `).all(gm.game_id, gm.match_id, gm.settled_at ?? '') as
      { id: number; played_at: string; notes: string | null; teams: string }[];
    const found = candidates
      .map(c => ({ ...c, scores: c.teams.split(',').map(t => t.split(':').map(Number)) }))
      .find(c => {
        const red = c.scores.find(s => s[0] === 0);
        const blue = c.scores.find(s => s[0] === 1);
        return red && blue && c.scores.length === 2;
      });
    if (!found) {
      throw new GambleError(
        `The recorded match #${gm.match_id} is gone — it was re-created by a match-history edit but no re-created row could be located automatically. Find the fresh match id manually and UPDATE gamble_matches SET match_id = <new id> WHERE id = ${gm.id}, then re-run the correction`,
        'recorded_match_missing'
      );
    }
    const foundRed = found.scores.find(s => s[0] === 0)![1];
    const foundBlue = found.scores.find(s => s[0] === 1)![1];
    if (foundRed !== redScore || foundBlue !== blueScore) {
      throw new GambleError(
        `A match-history edit has already re-recorded this settle as ${foundRed}-${foundBlue} (match #${found.id}). Re-run the correction with those scores: ${foundRed} ${foundBlue}`,
        'score_mismatch'
      );
    }
    targetMatchId = found.id;
    recordedScores = { red: foundRed, blue: foundBlue };
  }

  const betsBefore = getBets(gambleMatchId);

  // 1. Re-run the match through the Elo-correction replay (also fixes
  //    achievements) — ONLY when the recorded match row still exists. If a
  //    match-history edit already re-created it, the Elo side is done; the
  //    target (already verified above) is used as-is.
  let newMatchId: number | null = targetMatchId;
  if (recordedStillExists && recordedScores) {
    const oldToNew = correctMatch(gm.match_id, [
      { team: 0, player_ids: [gm.red_player_id], score: recordedScores.red },
      { team: 1, player_ids: [gm.blue_player_id], score: recordedScores.blue },
    ]);
    newMatchId = oldToNew.get(gm.match_id) ?? null;
  }

  // 2. In one transaction: re-mark the bets and re-point the match.
  //    Payouts here are the corrected book (stake × frozen odds, what the
  //    ladder SHOULD have paid) — deliberately no bank credits/debits, the
  //    bookie trues the money up out-of-band.
  const betAdjustments: CorrectScoreSummary['betAdjustments'] = [];
  let betsAdjusted = 0;
  db.transaction(() => {
    const updateBet = db.prepare(`UPDATE bets SET status = ?, payout = ? WHERE id = ?`);
    for (const bet of betsBefore) {
      if (bet.status === 'refunded') continue; // refunded before the close — untouched
      const won = bet.red_score === redScore && bet.blue_score === blueScore;
      const newStatus: 'won' | 'lost' = won ? 'won' : 'lost';
      const newPayout = won ? Math.floor(bet.stake * bet.decimal_odds) : 0;
      const changed = newStatus !== bet.status || (bet.payout ?? 0) !== newPayout;
      if (changed) {
        updateBet.run(newStatus, newPayout, bet.id);
        betsAdjusted++;
      }
      betAdjustments.push({
        bettor_id: bet.bettor_id,
        bettor_name: bet.bettor_name ?? `player ${bet.bettor_id}`,
        pick: `${bet.red_score}-${bet.blue_score}`,
        stake: bet.stake,
        was: { status: bet.status, payout: bet.payout ?? 0 },
        now: { status: newStatus, payout: newPayout },
        changed,
      });
    }
    db.prepare(`UPDATE gamble_matches SET match_id = ?, corrected_at = ? WHERE id = ?`)
      .run(newMatchId, nowDbDate(), gambleMatchId);
  })();

  // Stamp the correction onto the (new) match's notes when a fresh Elo replay
  // ran; a re-created match already carries the editor's trace (is_edited).
  if (notes?.trim() && recordedStillExists && newMatchId) {
    db.prepare(`UPDATE matches SET notes = COALESCE(NULLIF(notes, '') || ' | ', '') || ? WHERE id = ?`)
      .run(`score corrected to ${redScore}-${blueScore}: ${notes.trim()}`, newMatchId);
  }

  return {
    gambleMatchId,
    previousMatchId: gm.match_id,
    matchId: newMatchId,
    previousScore,
    finalScore: { red: redScore, blue: blueScore },
    betsAdjusted,
    betAdjustments,
    note: 'Match re-recorded and bets re-marked only — banking true-ups are settled with the bookie (no bank rows written).',
  };
}

/** Refund everything on a cancel: open bet stakes + both entry fees.
 *  Returns the total refunded (also used by the overdue auto-void). */
export function cancelGambleMatch(gambleMatchId: number): number {
  const gm = getGambleMatch(gambleMatchId);
  if (!gm) throw new GambleError('Gamble match not found', 'not_found');
  if (gm.status === 'settled') throw new GambleError('Match already settled', 'already_settled');
  if (gm.status === 'cancelled') throw new GambleError('Match already cancelled', 'already_cancelled');

  const refunded = db.transaction((): number => {
    let refunded = gm.entry_fee * 2;
    bank.credit(gm.red_player_id, gm.entry_fee, { type: 'refund', id: gambleMatchId, memo: 'entry fee refund' });
    bank.credit(gm.blue_player_id, gm.entry_fee, { type: 'refund', id: gambleMatchId, memo: 'entry fee refund' });

    const openBets = db.prepare(`SELECT * FROM bets WHERE gamble_match_id = ? AND status = 'open'`)
      .all(gambleMatchId) as Bet[];
    for (const bet of openBets) {
      bank.credit(bet.bettor_id, bet.stake, { type: 'refund', id: gambleMatchId, memo: 'stake refund' });
      db.prepare(`UPDATE bets SET status = 'refunded' WHERE id = ?`).run(bet.id);
      refunded += bet.stake;
    }

    db.prepare(`UPDATE gamble_matches SET status = 'cancelled' WHERE id = ?`).run(gambleMatchId);
    db.prepare(`UPDATE challenges SET status = 'cancelled', gamble_match_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(gm.challenge_id);
    return refunded;
  })();
  // Refunds moved — push them toward the central bank (bounded drain).
  kickBankSync();
  return refunded as number;
}