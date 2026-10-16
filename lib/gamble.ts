// Gambling state machine: challenge negotiation, gamble-match lifecycle,
// and settlement math. All money is virtual moose bucks routed through
// lib/bank.ts inside the transactions this module owns.
//
// Invariant: money only ever moves at accept (entry fees), bet placement
// (stakes), settle (payouts/shares) and cancel (refunds) — so a decline or
// counter can never strand a fee.

import db from './db';
import { processMatch, correctMatch } from './elo';
import { getBank, assertBankLinked, kickBankSync, alcesMirrorEnabled, enqueueHoldResolution } from './bank';
import { computeOddsLadder } from './gambleOdds';
import { announceBetsClosed, announceCancelled } from './gambleNotifications';
import { normaliseStartDate, toDbDate } from './seasons';
import type {
  Bet,
  Challenge,
  ChallengeSlot,
  ChallengeTerm,
  GambleMatch,
  GambleMatchPlayer,
  GambleMatchStatus,
  OddsLadder,
  PayoutLine,
  ScoreOutcome,
  CorrectScoreSummary,
  SettleSummary,
} from './types';
import { parsePointTimeline } from './timeline';
import type { PointTimeline } from './types';

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
  resultDeadlineMinutes: 120,
  /** Cap on the free-text special rules note. */
  maxSpecialRulesLength: 500,
  /** Team gambles: seats per side (1v2, 2v2 … up to 4 a side). */
  maxTeamSize: 4,
} as const;

/** Mock-mode floor under the casino's payout exposure guard: the local casino
 *  stands behind every bet with at least this (it mints, so it's backed).
 *  Mirror mode deliberately does NOT use it — see placeBet. */
const BASE_POT_MINIMUM = 100;

/**
 * Payout lines (stored format): 'elo_even' = the bookie's frozen predicted
 * line (the default); 'true_even' = a literal draw (5-5); otherwise a custom
 * 'R-B' scoreline with R+B = the game total and both halves 1-9 —
 * 10-0 / 0-10 are deliberately not choosable as an even line.
 */
export function parsePayoutLine(value: unknown, total: number): string | null {
  if (value === undefined) return 'elo_even';
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
      const full = getGambleMatch(gm.id);
      if (full) announceBetsClosed(full).catch(() => {});
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
      const seats = getGambleParticipants(id);
      cancelGambleMatch(id);
      announceCancelled(gm, getBetPool(id) + gm.entry_fee * seats.length).catch(() => {});
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

/**
 * Create a TEAM challenge with explicit seats per side (`createSlots` shape:
 * a player id per seat, or null for a broadcast seat anyone can claim).
 * Examples — 1v2 ("me vs two of you"), 2v2, "Stuts & Mark vs broadcast +
 * broadcast"; uneven teams are fine. The maker must occupy exactly one seat;
 * every OTHER seat holder — team-mates included — must accept, and open
 * broadcast seats can be claimed by anyone not already seated. The gamble
 * match opens (fees debited, odds frozen) only when the last acceptance
 * completes the shape, so a decline/expire still never strands a fee.
 * Countering isn't offered on team challenges.
 */
export function createTeamChallenge(
  gameId: number,
  challengerId: number,
  redSlots: (number | null)[],
  blueSlots: (number | null)[],
  terms: ChallengeTermsInput
): number {
  if (redSlots.length < 1 || blueSlots.length < 1) {
    throw new GambleError('Both sides need at least one seat', 'bad_terms');
  }
  if (redSlots.length > GAMBLE_RULES.maxTeamSize || blueSlots.length > GAMBLE_RULES.maxTeamSize) {
    throw new GambleError(`Each side can have at most ${GAMBLE_RULES.maxTeamSize} seats`, 'bad_terms');
  }

  const named = [...redSlots, ...blueSlots].filter((id): id is number => id != null);
  // Maker occupies exactly one seat; nobody sits twice (an id must not
  // appear in two seats, and broadcast seats are null by definition).
  const makerSeats = named.filter(id => id === challengerId).length;
  if (makerSeats !== 1) {
    throw new GambleError('You must occupy exactly one seat of your challenge', 'same_player');
  }
  if (new Set(named).size !== named.length) {
    throw new GambleError('A player can only hold one seat', 'same_player');
  }

  const game = db.prepare(`SELECT id, name, score_type, score_value FROM games WHERE id = ?`)
    .get(gameId) as { id: number; name: string; score_type: string; score_value: number } | undefined;
  if (!game) throw new GambleError('Unknown game', 'unknown_game');
  if (game.score_type !== 'best_of') {
    throw new GambleError(`Betting is only set up for fixed-total games (${game.name} is "${game.score_type}")`, 'unsupported_game');
  }
  assertBankLinked(challengerId);
  if (named.length) {
    const placeholders = named.map(() => '?').join(',');
    const known = db.prepare(`SELECT COUNT(*) as n FROM players WHERE id IN (${placeholders})`)
      .get(...named) as { n: number };
    if (known.n !== named.length) throw new GambleError('Unknown player', 'unknown_player');
  }

  const error = validateTerms(terms);
  if (error) throw new GambleError(error, 'bad_terms');
  const payoutLine = parsePayoutLine(terms.payoutLine, game.score_value);
  if (!payoutLine) {
    throw new GambleError("Payout line must be 'true_even', 'elo_even' or a scoreline from 9-1 to 1-9 that sums to the game total", 'bad_terms');
  }
  const side = terms.side === 'blue' ? 'blue' : 'red';

  const scheduled = normaliseStartDate(terms.scheduledAt);
  const specialRules = terms.specialRules?.trim() ?? null;
  // Compat seat columns: first named player per side (NULL when a side is
  // wholly broadcast — e.g. two open seats against me).
  const redPlayerId = (redSlots.find((id): id is number => id != null)) ?? null;

  return db.transaction((): number => {
    const result = db.prepare(`
      INSERT INTO challenges (
        game_id, challenger_id, opponent_id, entry_fee, scheduled_at,
        red_player_id, challenger_side, status, terms_by, broadcast, payout_line, special_rules
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
    `).run(gameId, challengerId, terms.entryFee, scheduled, redPlayerId, side, challengerId, payoutLine, specialRules);
    const challengeId = result.lastInsertRowid as number;

    db.prepare(`
      INSERT INTO challenge_terms (challenge_id, entry_fee, scheduled_at, red_player_id, proposed_by, payout_line, special_rules)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(challengeId, terms.entryFee, scheduled, redPlayerId, challengerId, payoutLine, specialRules);

    const seat = db.prepare(`
      INSERT INTO challenge_slots (challenge_id, side, slot_index, player_id, accepted_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = nowDbDate();
    redSlots.forEach((pid, i) => seat.run(challengeId, 'red', i, pid, pid === challengerId ? now : null));
    blueSlots.forEach((pid, i) => seat.run(challengeId, 'blue', i, pid, pid === challengerId ? now : null));

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
  counter?: ChallengeTermsInput,
  claimSide?: 'red' | 'blue'
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

  // Team challenges have their own state machine (seat claims, all-or-nothing
  // completion) — route them there before any 1v1/broadcast logic applies.
  if (challengeHasSlots(challengeId)) {
    return respondToTeamChallenge(challenge, playerId, action, claimSide);
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

    // Roster rows (same table team gambles use) — 1v1s are just tiny teams.
    const seat = db.prepare(
      `INSERT OR IGNORE INTO gamble_match_participants (gamble_match_id, team, player_id) VALUES (?, ?, ?)`
    );
    seat.run(gmId, 0, redPlayerId);
    seat.run(gmId, 1, bluePlayerId);

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

/**
 * Team-challenge response handling. Everyone but the maker must accept (team-
 * mates included); broadcast seats are claimed by the first comer. Nothing is
 * owed until the LAST acceptance fills the shape — that completing accept
 * freezes the odds with the full teams, debits every seat holder one entry
 * fee and opens the gamble match. Decline/withdraw before that moves nothing.
 */
function respondToTeamChallenge(
  challenge: Challenge,
  playerId: number,
  action: 'accept' | 'decline' | 'cancel' | 'counter',
  claimSide?: 'red' | 'blue'
): { challenge: Challenge; gambleMatch?: GambleMatch; ladder?: OddsLadder } {
  const challengeId = challenge.id;
  const isMaker = playerId === challenge.challenger_id;
  let slots = getChallengeSlots(challengeId);
  const mySlot = slots.find(s => s.player_id === playerId);

  if (action === 'counter') {
    throw new GambleError('Countering is not possible on team challenges — the maker sets the terms, you accept or decline', 'counter_not_allowed');
  }

  if (action === 'cancel') {
    if (!isMaker) {
      throw new GambleError('Only the maker can withdraw a team challenge', 'not_a_participant');
    }
    db.prepare(`UPDATE challenges SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(challengeId);
    return { challenge: getChallenge(challengeId)! };
  }

  if (action === 'decline') {
    if (!isMaker && !mySlot) {
      throw new GambleError('Only the maker or a seat holder can decline this challenge', 'not_a_participant');
    }
    db.prepare(`UPDATE challenges SET status = 'declined', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(challengeId);
    return { challenge: getChallenge(challengeId)! };
  }

  // ---- accept: seat claim / named acceptance, then completion ----

  if (mySlot && mySlot.accepted_at) {
    throw new GambleError('You have already accepted this challenge — waiting on the remaining seats', 'not_negotiable');
  }

  if (mySlot) {
    // Named seat holder accepting. The maker's own seat was accepted at
    // creation, so this only fires for teammates/named opponents.
    const upd = db.prepare(`
      UPDATE challenge_slots SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL
    `).run(nowDbDate(), mySlot.id);
    if (upd.changes === 0) {
      throw new GambleError('You have already accepted this challenge', 'not_negotiable');
    }
  } else {
    // Not seated — claim an open broadcast seat. The claimant picks the side
    // (or it's inferred when exactly one side has open seats).
    if (isMaker) {
      throw new GambleError('You already hold a seat in your own challenge', 'not_a_participant');
    }
    const openSides: ("red" | "blue")[] = [
      ...slots.filter(s => s.side === 'red' && s.player_id == null).length ? ['red' as const] : [],
      ...slots.filter(s => s.side === 'blue' && s.player_id == null).length ? ['blue' as const] : [],
    ];
    if (!openSides.length) {
      throw new GambleError('There are no open seats left in this challenge', 'no_open_slot');
    }
    const side = claimSide ?? (openSides.length === 1 ? openSides[0] : undefined);
    if (!side) {
      throw new GambleError(
        `Open seats on both sides — say which you are taking (red or blue)`,
        'no_open_slot'
      );
    }
    if (!openSides.includes(side)) {
      throw new GambleError(`There are no open seats on the ${side} side`, 'no_open_slot');
    }
    db.transaction(() => {
      const target = db.prepare(`
        SELECT id FROM challenge_slots
        WHERE challenge_id = ? AND side = ? AND player_id IS NULL
        ORDER BY slot_index ASC LIMIT 1
      `).get(challengeId, side) as { id: number } | undefined;
      if (!target) throw new GambleError('That seat was just taken — no open seat left', 'no_open_slot');
      // The IS-NULL guard is belt and braces against a racing claim.
      const upd = db.prepare(`
        UPDATE challenge_slots SET player_id = ?, accepted_at = ? WHERE id = ? AND player_id IS NULL
      `).run(playerId, nowDbDate(), target.id);
      if (upd.changes === 0) {
        throw new GambleError('That seat was just taken', 'no_open_slot');
      }
    })();
  }

  slots = getChallengeSlots(challengeId);
  const openSeats = slots.filter(s => s.player_id == null);
  const unaccepted = slots.filter(s => s.player_id != null && !s.accepted_at);
  if (openSeats.length > 0 || unaccepted.length > 0) {
    // Still filling — nothing is owed until the shape completes.
    return { challenge: getChallenge(challengeId)! };
  }

  // ---- completion: full teams known — freeze odds, debit everyone, open ----
  const game = db.prepare(`SELECT score_value FROM games WHERE id = ?`)
    .get(challenge.game_id) as { score_value: number };
  const fee = challenge.entry_fee;
  const redPlayerIds = slots.filter(s => s.side === 'red').map(s => s.player_id!) as number[];
  const bluePlayerIds = slots.filter(s => s.side === 'blue').map(s => s.player_id!) as number[];
  const allPlayerIds = Array.from(new Set([...redPlayerIds, ...bluePlayerIds]));

  // Funds checked before the transaction so the error never half-moves money.
  for (const pid of allPlayerIds) {
    assertBankLinked(pid);
    bank.ensureAccount(pid);
    if (bank.getBalance(pid) < fee) {
      throw new GambleError(`Player ${pid} does not have ${fee} moose bucks to enter`, 'insufficient_funds');
    }
  }

  const ladder = computeOddsLadder({
    gameId: challenge.game_id,
    redPlayerIds,
    bluePlayerIds,
    total: game.score_value,
  });
  const betCloseMs = new Date(challenge.scheduled_at.replace(' ', 'T') + 'Z').getTime()
    - GAMBLE_RULES.betCloseLeadMinutes * 60_000;
  const betCloseAt = toDbDate(new Date(betCloseMs));

  const gambleMatchId = db.transaction((): number => {
    // Claim first: only the FIRST completion may open a match — a racing
    // second acceptor must not double-debit every seat or open two matches.
    const claim = db.prepare(`
      UPDATE challenges SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('pending', 'countered')
    `).run(challengeId);
    if (claim.changes === 0) {
      throw new GambleError('Challenge is already accepted', 'not_negotiable');
    }
    for (const pid of allPlayerIds) {
      bank.debitChecked(pid, fee, { type: 'challenge_fee', id: challengeId, memo: 'entry fee' });
    }

    const result = db.prepare(`
      INSERT INTO gamble_matches
        (challenge_id, game_id, red_player_id, blue_player_id, scheduled_at, bet_close_at, entry_fee, outcome_total, odds_json, status, payout_line, special_rules)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      challengeId, challenge.game_id, redPlayerIds[0], bluePlayerIds[0],
      challenge.scheduled_at, betCloseAt, fee, game.score_value, JSON.stringify(ladder),
      challenge.payout_line ?? 'true_even', challenge.special_rules ?? null
    );
    const gmId = result.lastInsertRowid as number;

    const seat = db.prepare(
      `INSERT OR IGNORE INTO gamble_match_participants (gamble_match_id, team, player_id) VALUES (?, ?, ?)`
    );
    redPlayerIds.forEach((pid, i) => seat.run(gmId, 0, pid));
    bluePlayerIds.forEach((pid, i) => seat.run(gmId, 1, pid));

    db.prepare(`UPDATE challenges SET gamble_match_id = ? WHERE id = ?`).run(gmId, challengeId);
    return gmId;
  })();

  // Money moved — push the entry-fee movements toward the central bank.
  kickBankSync();

  return {
    challenge: getChallenge(challengeId)!,
    gambleMatch: getGambleMatch(gambleMatchId),
    ladder,
  };
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
  return { ...row, odds: JSON.parse(row.odds_json) as OddsLadder, participants: getGambleParticipants(id) };
}

// ---------------------------------------------------------------------------
// Teams: rosters (gamble matches) and slots (challenges)
// ---------------------------------------------------------------------------

/** Full roster of a gamble match: team 0 = red, 1 = blue, in seat order.
 *  Legacy 1v1s are backfilled into this table at boot, so this is always
 *  complete — the red/blue columns remain mirrored first seats. */
export function getGambleParticipants(gambleMatchId: number): GambleMatchPlayer[] {
  return db.prepare(`
    SELECT mp.team, mp.player_id, pl.name as player_name
    FROM gamble_match_participants mp
    JOIN players pl ON pl.id = mp.player_id
    WHERE mp.gamble_match_id = ?
    ORDER BY mp.team, mp.id
  `).all(gambleMatchId) as GambleMatchPlayer[];
}

/** Seats of a team challenge in red-then-blue seat order. A NULL player_id is
 *  an open broadcast slot; a non-maker seat with accepted_at NULL still needs
 *  its player to accept. Legacy 1v1 challenges return []. */
export function getChallengeSlots(challengeId: number): ChallengeSlot[] {
  return db.prepare(`
    SELECT s.*, p.name as player_name
    FROM challenge_slots s
    LEFT JOIN players p ON p.id = s.player_id
    WHERE s.challenge_id = ?
    ORDER BY CASE s.side WHEN 'red' THEN 0 ELSE 1 END, s.slot_index
  `).all(challengeId) as ChallengeSlot[];
}

function challengeHasSlots(challengeId: number): boolean {
  return (db.prepare(`SELECT COUNT(*) as n FROM challenge_slots WHERE challenge_id = ?`)
    .get(challengeId) as { n: number }).n > 0;
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
  // Participant exclusion across the WHOLE roster (team gambles included).
  const bettorSeated = getGambleParticipants(gambleMatchId)
    .some(p => p.player_id === bettorId);
  if (bettorSeated) {
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
  notes?: string,
  /** Optional live-scorer timeline (validated by the calling API route) —
   *  recorded with the settle's match, so live-tracked gambles keep their
   *  point order + duration on the match report. */
  timeline?: PointTimeline | null
): SettleSummary {
  const gm = getGambleMatch(gambleMatchId);
  if (!gm) throw new GambleError('Gamble match not found', 'not_found');

  const roster = getGambleParticipants(gambleMatchId);
  if (!roster.length) throw new GambleError('Gamble match has no roster', 'not_found');
  const rosterRed = roster.filter(p => p.team === 0).map(p => p.player_id);
  const rosterBlue = roster.filter(p => p.team === 1).map(p => p.player_id);
  const redTeam = teams.find(t => t.team === 0);
  const blueTeam = teams.find(t => t.team === 1);
  if (!redTeam || !blueTeam) {
    throw new GambleError('Provide both teams (team 0 = red, team 1 = blue)', 'bad_teams');
  }
  const sameSeats = (a: number[], b: number[]) =>
    a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
  if (!sameSeats(redTeam.player_ids, rosterRed) || !sameSeats(blueTeam.player_ids, rosterBlue)) {
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
    // Payouts go to every rostered player as real central-bank transfers
    for (const pid of new Set(roster.map(p => p.player_id))) {
      assertBankLinked(pid);
    }
    // Check-and-set claim: only the first settle wins, repeats error out.
    const claim = db.prepare(`
      UPDATE gamble_matches SET status = 'settled', settled_at = ?
      WHERE id = ? AND status IN ('open', 'awaiting_score')
    `).run(nowDbDate(), gambleMatchId);
    if (claim.changes === 0) {
      throw new GambleError('Match already settled', 'already_settled');
    }

  // 1. Record the real match via the existing Elo flow — the FULL roster
  //    (every seat contributes to the team Elo sum), matching what the
  //    correction replay records.
    const processed = processMatch({
      game_id: gm.game_id,
      notes: notes ?? undefined,
      teams: [
        { team: 0, player_ids: rosterRed, score: redScore },
        { team: 1, player_ids: rosterBlue, score: blueScore },
      ],
      timeline,
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
      // The bank manager's dance for the held stake: release it ('return'),
      // then book the real outcome — the profit for a winner, the stake for
      // a loser. (The gambler_payout row above is deliberately NOT mirrored
      // — the bank sees this money through these legs.)
      enqueueHoldResolution(
        { refType: 'bet_stake', refId: gambleMatchId, playerId: bet.bettor_id, held: bet.stake },
        won ? { type: 'win', amount: Math.max(0, payout - bet.stake) }
            : { type: 'loss', amount: bet.stake },
      );
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
    const entriesPool = gm.entry_fee * roster.length;
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
    const participants: { playerId: number; score: number }[] = roster.map(p => ({
      playerId: p.player_id,
      score: p.team === 0 ? redScore : blueScore,
    }));
    const playerEntry: SettleSummary['playerEntry'] = [];
    let sharesTotal = 0;
    // Team-aware entries: each side's pool slice is playersPool × that side's
    // score / total, split EVENLY among the side's members — for 1v1s (one
    // member per side) this is exactly the historical per-player share. The
    // per-member floors keep every side's slice intact; dust stays with the
    // house via the leftover identity below.
    if (entryEvenHit) {
      const per = Math.floor(playersPool / roster.length);
      for (const { playerId } of participants) {
        sharesTotal += per;
        if (per > 0) {
          bank.credit(playerId, per, {
            type: 'player_share',
            id: gambleMatchId,
            memo: `evens-line payout (line ${line}) — ${roster.length} way split of ${playersPool}`,
          });
        }
        playerEntry.push({ playerId, fee: gm.entry_fee, returned: per });
      }
    } else {
      for (const team of [0, 1] as const) {
        const teamScore = team === 0 ? redScore : blueScore;
        const members = participants.filter((_, i) => roster[i].team === team);
        const slice = Math.floor((playersPool * teamScore) / gm.outcome_total);
        const per = members.length ? Math.floor(slice / members.length) : 0;
        for (const m of members) {
          sharesTotal += per;
          if (per > 0) {
            bank.credit(m.playerId, per, {
              type: 'player_share',
              id: gambleMatchId,
              memo: `entry share ${teamScore}/${gm.outcome_total} of ${playersPool} — ${members.length}-way team split (${Math.round(GAMBLE_RULES.houseFeeRate * 100)}% of ${gm.entry_fee} entry)`,
            });
          }
          playerEntry.push({ playerId: m.playerId, fee: gm.entry_fee, returned: per });
        }
      }
    }

    // Entry fees resolve the same way as bet stakes: release the held fee
    // ('return'), then book what actually became of it — a win when the
    // settle's share beat the fee, a loss of the shortfall when it didn't.
    for (const entry of playerEntry) {
      const delta = entry.returned - entry.fee;
      enqueueHoldResolution(
        { refType: 'challenge_fee', refId: gm.challenge_id ?? 0, playerId: entry.playerId, held: entry.fee },
        delta === 0 ? null : { type: delta > 0 ? 'win' : 'loss', amount: Math.abs(delta) },
      );
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
    const winnersCredited: number[] = [];
    let houseLoss = 0;
    const scoreShares: { playerId: number; amount: number }[] = [];
    const winnerQuarter = Math.floor(leftover * GAMBLE_RULES.potSplit.winner);
    const scoreQuarter = Math.floor(leftover * GAMBLE_RULES.potSplit.scoreShare);
    const isDraw = redScore === blueScore;

    if (leftover > 0) {
      // Winner quarter goes to the WINNING TEAM, split EVENLY between its
      // members (single winner for 1v1s — same numbers as before); the
      // floored per-player amounts' dust lands on the house via houseCut.
      const winnerIds = isDraw
        ? []
        : (redScore > blueScore ? rosterRed : rosterBlue);
      const perWinner = winnerIds.length ? Math.floor(winnerQuarter / winnerIds.length) : 0;
      for (const pid of winnerIds) {
        if (perWinner > 0) {
          bank.credit(pid, perWinner, { type: 'pot_winner_share', id: gambleMatchId, memo: 'match winner pot share (even team split)' });
          winnersCredited.push(pid);
        }
      }
      winnerShare = perWinner * winnersCredited.length;
      winnerPlayerId = winnerIds[0] ?? null;
      // On a draw the winner quarter keeps the houseCut value above.

      let scoreShareTotal = 0;
      // Same team carve as the entry shares: a side's quarter slice is
      // scoreQuarter × its score / total, split evenly within the side.
      for (const team of [0, 1] as const) {
        const teamScore = team === 0 ? redScore : blueScore;
        const members = participants.filter((_, i) => roster[i].team === team);
        const slice = Math.floor((scoreQuarter * teamScore) / gm.outcome_total);
        const per = members.length ? Math.floor(slice / members.length) : 0;
        for (const m of members) {
          if (per > 0) {
            bank.credit(m.playerId, per, { type: 'pot_score_share', id: gambleMatchId, memo: 'pot score share (even team split)' });
          }
          scoreShares.push({ playerId: m.playerId, amount: per });
          scoreShareTotal += per;
        }
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
        winnerPlayerIds: winnersCredited,
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


/**
 * Reconstruct a settled gamble's SettleSummary from the bets + bank ledger.
 * Used to show the settlement on a match page when it wasn't just performed
 * in-browser (the ledger already holds the exact entry shares + pot split —
 * the same rows the live settle wrote).
 */
export function getSettleSummary(gambleMatchId: number): SettleSummary | null {
  const gm = getGambleMatch(gambleMatchId);
  if (!gm || gm.status !== 'settled') return null;

  const bets = getBets(gambleMatchId);
  const wonBets = bets.filter(b => b.status === 'won' || b.status === 'lost') as (Bet & { status: 'won' | 'lost' })[];
  // Note: after a score correction the bets table holds the corrected book
  // while the ledger still shows the original settle's monetary movements —
  // money true-ups happen with the bookie directly (see CorrectScoreSummary).
  const pool = wonBets.reduce((s, b) => s + b.stake, 0);
  const returns = wonBets.reduce((s, b) => s + (b.payout ?? 0), 0);
  const capped = wonBets.some(b => b.status === 'won' && b.payout != null
    && b.payout < Math.floor(b.stake * b.decimal_odds));

  // Ledger rows the settle wrote (house rows have a NULL player_id). ref_id is
  // the gamble match id and the types are gamble-settle specific, so this
  // cannot pick up unrelated transactions.
  const ledger = db.prepare(`
    SELECT ref_type, player_id, amount FROM bank_transactions
    WHERE ref_id = ? AND ref_id IS NOT NULL
      AND ref_type IN ('house_fee','player_share','pot_winner_share','pot_score_share','pot_house_cut','house_loss')
    ORDER BY id
  `).all(gambleMatchId) as { ref_type: string; player_id: number | null; amount: number }[];

  const houseFee = ledger.find(l => l.ref_type === 'house_fee')?.amount ?? 0;

  // Final score from the recorded office match (team 0 = red, 1 = blue).
  let redScore = 0;
  let blueScore = 0;
  if (gm.match_id) {
    const parts = db.prepare(`
      SELECT team, score FROM match_participants
      WHERE match_id = ? AND team IN (0, 1) ORDER BY team`)
      .all(gm.match_id) as { team: number; score: number }[];
    // A recorded team gamble carries one row per player — both rows of a
    // team share the team's score, so take the first of each side.
    if (parts.some(p => p.team === 0) && parts.some(p => p.team === 1)) {
      redScore = parts.find(p => p.team === 0)!.score;
      blueScore = parts.find(p => p.team === 1)!.score;
    }
  }

  // Evens-line detection, same rule as the settle itself.
  const line = gm.payout_line ?? 'true_even';
  const evenScoreline = line === 'elo_even' ? (gm.odds?.predictedLine ?? '')
    : line === 'true_even' ? '' : line;
  const entryEvenHit = evenScoreline !== ''
    ? `${redScore}-${blueScore}` === evenScoreline
    : redScore === blueScore;

  const roster = getGambleParticipants(gambleMatchId);
  const participants: { playerId: number | null; score: number; side: 'red' | 'blue' }[] =
    roster.length ? roster.map(p => ({
      playerId: p.player_id,
      score: p.team === 0 ? redScore : blueScore,
      side: p.team === 0 ? 'red' : 'blue',
    })) : [
      { playerId: gm.red_player_id, score: redScore, side: 'red' as const },
      { playerId: gm.blue_player_id, score: blueScore, side: 'blue' as const },
    ];
  const playerEntry = participants.map(p => ({
    playerId: p.playerId ?? -1,
    fee: gm.entry_fee,
    returned: ledger.find(l => l.ref_type === 'player_share' && l.player_id === p.playerId)?.amount ?? 0,
  }));

  // Winner share: one ledger row per winning player (team gambles split the
  // quarter evenly, so several rows with the same amount).
  const winnerRows = ledger.filter(l => l.ref_type === 'pot_winner_share' && l.amount !== 0);
  const winnerShare = winnerRows.reduce((s, r) => s + r.amount, 0);
  const winnerPlayerIds = winnerRows.map(r => r.player_id ?? -1);
  const scoreShares = participants.map(p => ({
    playerId: p.playerId ?? -1,
    amount: ledger.find(l => l.ref_type === 'pot_score_share' && l.player_id === p.playerId)?.amount ?? 0,
  }));
  const houseCut = ledger.find(l => l.ref_type === 'pot_house_cut')?.amount ?? 0;
  const houseLoss = Math.abs(ledger.find(l => l.ref_type === 'house_loss')?.amount ?? 0);
  const leftover = houseLoss > 0
    ? -houseLoss
    : houseCut > 0 || winnerShare > 0 || scoreShares.some(s => s.amount > 0)
      ? winnerShare + scoreShares.reduce((s, x) => s + x.amount, 0) + houseCut
      : 0;

  return {
    gambleMatchId,
    matchId: gm.match_id ?? 0,
    finalScore: { red: redScore, blue: blueScore },
    pool,
    returns,
    payoutCap: capped ? returns : 0,
    returnsCapped: capped,
    payoutLine: line as PayoutLine,
    entryEvenHit,
    leftover,
    betPayments: wonBets.map(b => ({
      bettor_id: b.bettor_id,
      bettor_name: b.bettor_name ?? `player ${b.bettor_id}`,
      pick: `${b.red_score}-${b.blue_score}`,
      stake: b.stake,
      status: b.status as 'won' | 'lost',
      payout: b.payout ?? 0,
    })),
    pot: {
      positive: leftover > 0,
      house: houseCut,
      houseFee,
      winnerPlayerId: winnerPlayerIds[0] ?? null,
      winnerPlayerIds,
      winnerShare,
      scoreShares,
      houseLoss,
    },
    playerEntry,
  };
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
  notes?: string,
  /** Optional corrected timeline (validated by the calling API route) —
   *  replace/re-drop the recorded points' order with the corrected score. */
  timeline?: PointTimeline | null
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

  // What the old recorded match said (for the summary/notification) — one row
  // per player for team gambles, both rows of a team share its score.
  const oldParts = db.prepare(`
    SELECT team, player_id, score FROM match_participants WHERE match_id = ? AND team IN (0, 1) ORDER BY team, id
  `).all(gm.match_id) as { team: number; player_id: number; score: number }[];
  const recordedStillExists = oldParts.some(p => p.team === 0) && oldParts.some(p => p.team === 1);
  const previousScore: { red: number | null; blue: number | null } = recordedStillExists
    ? { red: oldParts.find(p => p.team === 0)!.score, blue: oldParts.find(p => p.team === 1)!.score }
    : { red: null, blue: null };

  // Dangling match_id? The office match-history edit (correctMatch) DELETES
  // and re-creates the match row under a fresh id — its Elo/achievements are
  // already correct, so all that's left here is re-pointing the gamble at the
  // re-created match and re-marking the bets (NO Elo work, NO bank rows).
  const roster = getGambleParticipants(gambleMatchId);
  let targetMatchId = gm.match_id;
  let recordedScores: { red: number; blue: number } | null = recordedStillExists
    ? { red: oldParts.find(p => p.team === 0)!.score, blue: oldParts.find(p => p.team === 1)!.score } : null;
  if (!recordedStillExists) {
    // Identify the re-created match: the settle defaults its notes to
    // 'gamble #<id>' (preserved verbatim by correctMatch), played_at is the
    // original settle moment (≈ settled_at), it's flagged is_edited, and it
    // carries the gamble's exact roster (any team shapes).
    const candidates = db.prepare(`
      SELECT m.id, m.played_at, m.notes,
        GROUP_CONCAT(mp.team || ':' || mp.player_id || ':' || mp.score) as teams
      FROM matches m
      JOIN match_participants mp ON mp.match_id = m.id
      WHERE m.game_id = ?
        AND m.id > ?
        AND m.is_edited = 1
        AND ABS(strftime('%s', m.played_at) - strftime('%s', ?)) < 600
      GROUP BY m.id
      ORDER BY m.id ASC
    `).all(gm.game_id, gm.match_id, gm.settled_at ?? '') as
      { id: number; played_at: string; notes: string | null; teams: string }[];
    const rosterSet = roster.map(p => p.player_id).sort((a, b) => a - b).join(',');
    const found = candidates
      .map(c => ({ ...c, scores: c.teams.split(',').map(t => t.split(':').map(Number)) }))
      .find(c => {
        const red = c.scores.find(s => s[0] === 0);
        const blue = c.scores.find(s => s[0] === 1);
        if (!red || !blue) return false;
        const playerSet = c.scores.map(s => s[1]).sort((a, b) => a - b).join(',');
        return playerSet === rosterSet;
      });
    if (!found) {
      throw new GambleError(
        `The recorded match #${gm.match_id} is gone — it was re-created by a match-history edit but no re-created row could be located automatically. Find the fresh match id manually and UPDATE gamble_matches SET match_id = <new id> WHERE id = ${gm.id}, then re-run the correction`,
        'recorded_match_missing'
      );
    }
    const foundRed = found.scores.find(s => s[0] === 0)![2];
    const foundBlue = found.scores.find(s => s[0] === 1)![2];
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
    const redPlayerIds = roster.filter(p => p.team === 0).map(p => p.player_id);
    const bluePlayerIds = roster.filter(p => p.team === 1).map(p => p.player_id);

    // Timeline consistency guard: the preserved original timeline is only
    // kept when the corrected score still matches the recorded point counts.
    // Otherwise it would lie about the game's shape on the report (achievement
    // re-checks read it too). Explicitly-supplied timelines are validated by
    // the calling route; explicitly-null clears the timeline.
    let correctedTimeline = timeline;
    if (correctedTimeline === undefined) {
      const existing = db.prepare('SELECT points_timeline FROM matches WHERE id = ?')
        .get(gm.match_id) as { points_timeline: string | null } | undefined;
      const parsed = parsePointTimeline(existing?.points_timeline);
      if (parsed) {
        const counts = [0, 0];
        for (const ev of parsed.events) if (counts[ev.team] !== undefined) counts[ev.team]++;
        if (counts[0] !== redScore || counts[1] !== blueScore) correctedTimeline = null;
      } else if (existing?.points_timeline) {
        correctedTimeline = null; // stored value isn't a valid timeline any more
      }
    } else if (correctedTimeline) {
      // Re-index safety: timeline team indexes follow the recorded teams ARRAY
      // (index 0 = red here) — same as the settle flow, so passthrough is safe.
    }

    // Replay with the gamble's roster (team gambles: multiple ids per team).
    const oldToNew = correctMatch(gm.match_id, [
      { team: 0, player_ids: redPlayerIds, score: recordedScores.red },
      { team: 1, player_ids: bluePlayerIds, score: recordedScores.blue },
    ], correctedTimeline);
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

/** Refund everything on a cancel: open bet stakes + one entry fee per roster
 *  seat. Returns the total refunded (also used by the overdue auto-void). */
export function cancelGambleMatch(gambleMatchId: number): number {
  const gm = getGambleMatch(gambleMatchId);
  if (!gm) throw new GambleError('Gamble match not found', 'not_found');
  if (gm.status === 'settled') throw new GambleError('Match already settled', 'already_settled');
  if (gm.status === 'cancelled') throw new GambleError('Match already cancelled', 'already_cancelled');

  const seats = Array.from(new Set(getGambleParticipants(gambleMatchId).map(p => p.player_id)));
  if (!seats.length) seats.push(gm.red_player_id, gm.blue_player_id); // pre-backfill safety net

  const refunded = db.transaction((): number => {
    let refunded = gm.entry_fee * seats.length;
    for (const pid of seats) {
      bank.credit(pid, gm.entry_fee, { type: 'refund', id: gambleMatchId, memo: 'entry fee refund' });
    }

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