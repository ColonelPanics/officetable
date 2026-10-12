// Odds for fixed-total office games (scores always sum to the game total,
// e.g. foosball = 10). Extracted from scripts/odds.ts, which is now a thin
// CLI wrapper over this module.
//
// Interpretation: because the Elo "actual" result is the score share,
// expectedScore returns an EXPECTED POINT SHARE, not a win probability.
// The exact-score ladder models red's points as Binomial(total, share),
// which keeps the mean exactly on the Elo-calibrated expectation.

import db from './db';
import { resolveSeason, ALLTIME_SEASON_ID } from './seasons';
import type { ScoreOutcome, OddsLadder } from './types';

// Same constant as the app's expectedScore (lib/elo.ts:100) — keep in sync.
export const DIVISOR = 180;
// Fallback average winning share when there is no match history yet
// (typical margins; 0.7 = most games end ~7-3).
export const DEFAULT_WINNER_SHARE = 0.7;

// Head-to-head blending: history is trusted more as it accumulates,
// capped at 0.6 so Elo season form always keeps some voice.
export const H2H_WEIGHT_CAP = 0.6;
const H2H_WEIGHT_DECAY = 8;

// UK bookmakers quote on a standard fraction ladder — snap fair odds to the
// nearest SHORTER rung so prices read like a real board (4/6, 10/11, 11/8...)
// and never promise a payout longer than the one actually paid.
export const UK_LADDER: [number, number][] = [
  [1, 100], [1, 33], [1, 25], [1, 20], [1, 16], [1, 10], [1, 5],
  [1, 4], [1, 3], [2, 5], [1, 2], [4, 7], [8, 15], [4, 6], [8, 13], [4, 5],
  [5, 6], [10, 11], [1, 1], [11, 10], [6, 5], [5, 4], [11, 8], [6, 4],
  [13, 8], [7, 4], [15, 8], [2, 1], [9, 4], [5, 2], [11, 4], [3, 1],
  [10, 3], [7, 2], [4, 1], [9, 2], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1],
  [10, 1], [12, 1], [14, 1], [16, 1], [20, 1], [25, 1], [33, 1], [50, 1], [100, 1],
];

// Bookmaker margin: every price is cut to 97% of fair before the ladder
// snap, so each exact-score cell returns less than it costs on average.
// With fair odds the book breaks exactly even on turnover; the margin is
// what keeps the house profitably in business over the long run.
export const HOUSE_MARGIN = 0.03;

/**
 * Margined decimal price target (fair odds minus the bookmaker's margin).
 * Fair odds would be exactly break-even over turnover; this haircut is
 * the house edge on the betting book itself.
 */
export function decimalOddsOf(p: number): number {
  return (1 - HOUSE_MARGIN) / p;
}

/**
 * An actual price on the UK ladder: the SHORTest rung at or under the
 * margined target — i.e. the displayed fractional and the decimal used for
 * payout are the same number, and the bettor never gets a price better than
 * the book is willing to pay. Falls back to the shortest rung on the board
 * for extreme favourites whose margined price is below even-money rungs.
 */
export function priceOnLadder(prob: number): { decimalOdds: number; fractional: string } {
  const target = decimalOddsOf(prob);
  let chosen = UK_LADDER[0];
  let chosenDec = -Infinity; // best rung found so far that fits under target
  let shortestDec = Infinity;
  let shortest = UK_LADDER[0];
  for (const rung of UK_LADDER) {
    const dec = 1 + rung[0] / rung[1];
    if (dec < shortestDec) { shortestDec = dec; shortest = rung; }
    if (dec <= target && dec > chosenDec) { chosenDec = dec; chosen = rung; }
  }
  if (chosenDec === Infinity) {
    chosen = shortest;
    chosenDec = shortestDec;
  }
  return { decimalOdds: chosenDec, fractional: `${chosen[0]}/${chosen[1]}` };
}

/** UK fractional price for the margined payout of p. */
export function fractionalOdds(p: number): string {
  return priceOnLadder(p).fractional;
}

/** Expected point share for side A vs side B (the app's expectedScore formula). */
export function expectedShare(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / DIVISOR));
}

/**
 * Convert an expected point share into a win probability, calibrated on the
 * historical average winning share w. For fixed-total games:
 *   share = q*w + (1-q)*(1-w)  =>  q = (share - (1-w)) / (2w - 1)
 */
export function shareToWinProb(share: number, w: number): number {
  if (w <= 0.5 + 1e-9) return share; // degenerate history; treat share as win prob
  return Math.min(1, Math.max(0, (share - (1 - w)) / (2 * w - 1)));
}

/** Predicted scoreline for the named side given its expected share (fixed total). */
export function predictedLine(share: number, total = 10): string {
  const clamped = Math.min(1, Math.max(0, share));
  const a = Math.min(total, Math.max(0, Math.round(clamped * total)));
  return `${a}-${total - a}`;
}

/** Elo side rating = SUM of member ratings (mirrors lib/elo.ts averageTeamElo). */
export function getSideElo(playerIds: number[], gameId: number, seasonId: number): number {
  if (playerIds.length === 0) return 0;
  const placeholders = playerIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(pr.elo, 0)), 0) as elo
    FROM players p
    LEFT JOIN player_ratings pr
      ON pr.player_id = p.id AND pr.game_id = ? AND pr.season_id = ?
    WHERE p.id IN (${placeholders})
  `).get(gameId, seasonId, ...playerIds) as { elo: number } | undefined;
  return rows?.elo ?? 0;
}

/**
 * Historic head-to-head: red's empirical score share across prior 1v1 matches
 * between these two players (this game, all history). Only applies when each
 * side is a single player. Draw-only history is still valid info (share 0.5).
 * Share is from RED's perspective.
 */
export function headToHeadShare(
  gameId: number,
  redPlayerIds: number[],
  bluePlayerIds: number[],
  _seasonId: number = ALLTIME_SEASON_ID // lifetime h2h regardless of ledger
): { share: number | null; n: number } {
  if (redPlayerIds.length !== 1 || bluePlayerIds.length !== 1) {
    return { share: null, n: 0 };
  }
  const redId = redPlayerIds[0];
  const blueId = bluePlayerIds[0];

  // Matches containing exactly these two players (1v1), where both played.
  const rows = db.prepare(`
    SELECT m.id,
      SUM(CASE WHEN mp.player_id = ? THEN mp.score ELSE 0 END) as red_pts,
      SUM(CASE WHEN mp.player_id = ? THEN mp.score ELSE 0 END) as blue_pts,
      SUM(mp.score) as total
    FROM matches m
    JOIN match_participants mp ON mp.match_id = m.id
    WHERE m.game_id = ?
      AND (SELECT COUNT(DISTINCT mp2.player_id) FROM match_participants mp2 WHERE mp2.match_id = m.id) = 2
      AND EXISTS (SELECT 1 FROM match_participants rp WHERE rp.match_id = m.id AND rp.player_id = ?)
      AND EXISTS (SELECT 1 FROM match_participants bp WHERE bp.match_id = m.id AND bp.player_id = ?)
    GROUP BY m.id
  `).all(redId, blueId, gameId, redId, blueId) as { red_pts: number; blue_pts: number; total: number }[];

  if (rows.length === 0) return { share: null, n: 0 };
  const redTotal = rows.reduce((s, m) => s + m.red_pts, 0);
  const allPts = rows.reduce((s, m) => s + m.total, 0);
  if (allPts === 0) return { share: 0.5, n: rows.length };
  return { share: redTotal / allPts, n: rows.length };
}

/** Binomial coefficient without overflow for small totals. */
function binom(n: number, k: number): number {
  let result = 1;
  const kx = Math.min(k, n - k);
  for (let i = 1; i <= kx; i++) {
    result = (result * (n - kx + i)) / i;
  }
  return result;
}

export interface OddsLadderInput {
  gameId: number;
  redPlayerIds: number[];
  bluePlayerIds: number[];
  /** Total points in the fixed-total game (e.g. 10 → outcomes 10-0 … 5-5 … 0-10). */
  total: number;
  /** Ratings ledger; default = the live current season. */
  seasonId?: number;
  /** Explicit red-side Elo override (used for previews before teams exist). */
  redElo?: number;
  blueElo?: number;
}

/**
 * Full exact-score odds ladder. Blends Elo share with head-to-head empirical
 * share (weighted by number of meetings), then spreads across the total+1
 * outcome scores with a binomial.
 */
export function computeOddsLadder(input: OddsLadderInput): OddsLadder {
  const total = Math.max(2, Math.floor(input.total));
  const seasonId = input.seasonId ?? resolveSeason(new Date());

  const eloRed = input.redElo ?? getSideElo(input.redPlayerIds, input.gameId, seasonId);
  const eloBlue = input.blueElo ?? getSideElo(input.bluePlayerIds, input.gameId, seasonId);
  const expected = expectedShare(eloRed, eloBlue);

  const h2h = headToHeadShare(input.gameId, input.redPlayerIds, input.bluePlayerIds, ALLTIME_SEASON_ID);
  const weight = h2h.share !== null ? Math.min(H2H_WEIGHT_CAP, h2h.n / (h2h.n + H2H_WEIGHT_DECAY)) : 0;
  const blended = weight > 0 && h2h.share !== null
    ? (1 - weight) * expected + weight * h2h.share
    : expected;
  // Keep every outcome bettable: never let a runaway Elo gap make the other
  // ten cells infinitely long.
  const clamped = Math.min(0.97, Math.max(0.03, blended));

  // Binomial over the fixed total; probability of red scoring exactly k.
  const probs: number[] = [];
  let sum = 0;
  for (let k = 0; k <= total; k++) {
    const p = binom(total, k) * Math.pow(clamped, k) * Math.pow(1 - clamped, total - k);
    probs.push(p);
    sum += p;
  }

  // Margin + UK ladder snapping BEFORE rounding: the fractional price and
  // the paid decimal are the same rung, so a displayed price is exactly
  // what gets paid (no "board says 7/2, ledger pays 3.48" mismatches).
  const outcomes: ScoreOutcome[] = [];
  for (let k = total; k >= 0; k--) {
    const prob = probs[k] / sum;
    const price = priceOnLadder(prob);
    outcomes.push({
      redScore: k,
      blueScore: total - k,
      prob,
      decimalOdds: Math.round(price.decimalOdds * 10000) / 10000,
      fractional: price.fractional,
    });
  }

  return {
    total,
    eloRed,
    eloBlue,
    expectedShare: expected,
    blendedShare: clamped,
    calibrationW: weight,
    calibrationN: h2h.n,
    predictedLine: predictedLine(clamped, total),
    outcomes,
  };
}