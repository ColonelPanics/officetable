import db from './db';
import { computeTimelineStats, parsePointTimeline, MARATHON_MINUTES } from './timeline';
import { getSeason } from './seasons';

export interface PunditryFact {
  type: string;
  player_id: number;
  player_name: string;
  description: string;
  /** What the claim is about: 'all-time', a season name (e.g. 'Season 0'), or 'match'. */
  scope?: string;
  /** True when the fact sets/extends/breaks an all-time or seasonal record (A1). */
  notable?: boolean;
  metadata?: Record<string, unknown>;
}

type Ledger = 'season' | 'alltime';

interface MatchParticipant {
  player_id: number;
  team: number;
  score: number;
  elo_before: number;
  elo_after: number;
  alltime_elo_before: number;
  alltime_elo_after: number;
}

interface MatchInfo {
  id: number;
  game_id: number;
  played_at: string;
  participants: MatchParticipant[];
}

/**
 * Get player's highest Elo before this match ('season' = the match's season
 * ledger, 'alltime' = the continuous ledger via the alltime_elo columns).
 */
function getHighestEloBefore(playerId: number, gameId: number, seasonId: number, beforeMatchId: number, ledger: Ledger = 'season'): number | null {
  const result = db.prepare(`
    SELECT MAX(mp.${ledger === 'alltime' ? 'alltime_elo_after' : 'elo_after'}) as highest
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ?${ledger === 'alltime' ? '' : ' AND m.season_id = ?'} AND m.id < ?
  `).get(...(ledger === 'alltime' ? [playerId, gameId, beforeMatchId] : [playerId, gameId, seasonId, beforeMatchId])) as { highest: number | null } | null;
  return result?.highest ?? null;
}

/**
 * Get player's lowest Elo before this match (ledger-scoped)
 */
function getLowestEloBefore(playerId: number, gameId: number, seasonId: number, beforeMatchId: number, ledger: Ledger = 'season'): number | null {
  const result = db.prepare(`
    SELECT MIN(mp.${ledger === 'alltime' ? 'alltime_elo_after' : 'elo_after'}) as lowest
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ?${ledger === 'alltime' ? '' : ' AND m.season_id = ?'} AND m.id < ?
  `).get(...(ledger === 'alltime' ? [playerId, gameId, beforeMatchId] : [playerId, gameId, seasonId, beforeMatchId])) as { lowest: number | null } | null;
  return result?.lowest ?? null;
}

/**
 * Get player's biggest absolute Elo change before this match (ledger-scoped)
 */
function getBiggestEloChangeBefore(playerId: number, gameId: number, seasonId: number, beforeMatchId: number, ledger: Ledger = 'season'): number {
  const after = ledger === 'alltime' ? 'mp.alltime_elo_after' : 'mp.elo_after';
  const before = ledger === 'alltime' ? 'mp.alltime_elo_before' : 'mp.elo_before';
  const result = db.prepare(`
    SELECT MAX(ABS(${after} - ${before})) as biggest
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ?${ledger === 'alltime' ? '' : ' AND m.season_id = ?'} AND m.id < ?
  `).get(...(ledger === 'alltime' ? [playerId, gameId, beforeMatchId] : [playerId, gameId, seasonId, beforeMatchId])) as { biggest: number } | null;
  return result?.biggest ?? 0;
}

/**
 * Get total points scored by player before this match
 */
function getTotalPointsScoredBefore(playerId: number, gameId: number, beforeMatchId: number): number {
  const result = db.prepare(`
    SELECT SUM(mp.score) as total
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ? AND m.id < ?
  `).get(playerId, gameId, beforeMatchId) as { total: number | null } | null;
  return result?.total ?? 0;
}

/**
 * Get total points conceded by player before this match
 */
function getTotalPointsConcededBefore(playerId: number, gameId: number, beforeMatchId: number): number {
  // Sum of opponent scores across all matches
  const result = db.prepare(`
    SELECT SUM(opponent_score) as total
    FROM (
      SELECT mp.match_id, mp.score,
        (SELECT MAX(mp2.score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team) as opponent_score
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ? AND m.id < ?
    )
  `).get(playerId, gameId, beforeMatchId) as { total: number | null } | null;
  return result?.total ?? 0;
}

/**
 * Get total wins by player before this match
 */
function getTotalWinsBefore(playerId: number, gameId: number, beforeMatchId: number): number {
  const result = db.prepare(`
    SELECT COUNT(*) as wins
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ? AND m.id < ?
      AND mp.score > (
        SELECT MAX(mp2.score) FROM match_participants mp2
        WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team
      )
  `).get(playerId, gameId, beforeMatchId) as { wins: number } | null;
  return result?.wins ?? 0;
}

/**
 * Get match results for a player in chronological order (before this match);
 * optionally restricted to one season's slice of history.
 */
function getMatchResultsBefore(playerId: number, gameId: number, beforeMatchId: number, seasonId?: number): { match_id: number; result: 'win' | 'loss' | 'draw' }[] {
  const results = db.prepare(`
    SELECT
      mp.match_id,
      mp.score,
      (SELECT MAX(mp2.score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team) as opponent_score
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ?${seasonId !== undefined ? ' AND m.season_id = ?' : ''} AND m.id < ?
    ORDER BY m.played_at ASC
  `).all(...(seasonId !== undefined ? [playerId, gameId, seasonId, beforeMatchId] : [playerId, gameId, beforeMatchId])) as { match_id: number; score: number; opponent_score: number }[];

  return results.map(r => ({
    match_id: r.match_id,
    result: r.score > r.opponent_score ? 'win' as const : r.score < r.opponent_score ? 'loss' as const : 'draw' as const
  }));
}

/**
 * Count matches between two players on opposing teams before this match
 */
function getMatchesBetweenPlayersBefore(playerId1: number, playerId2: number, gameId: number, beforeMatchId: number): number {
  const result = db.prepare(`
    SELECT COUNT(DISTINCT m.id) as count
    FROM matches m
    JOIN match_participants mp1 ON m.id = mp1.match_id
    JOIN match_participants mp2 ON m.id = mp2.match_id
    WHERE m.game_id = ? AND m.id < ?
      AND mp1.player_id = ? AND mp2.player_id = ?
      AND mp1.team != mp2.team
  `).get(gameId, beforeMatchId, playerId1, playerId2) as { count: number };
  return result.count;
}

/**
 * Shared streak calculator: takes an ordered result list and returns current
 * plus longest streaks per kind (win / lose / unbeaten).
 */
function computeStreaks(results: ('win' | 'loss' | 'draw')[]) {
  let longestWinStreak = 0;
  let longestLoseStreak = 0;
  let longestUnbeatenStreak = 0;
  let currentWinStreak = 0;
  let currentLoseStreak = 0;
  let currentUnbeatenStreak = 0;
  for (const r of results) {
    if (r === 'win') {
      currentWinStreak++;
      currentLoseStreak = 0;
      currentUnbeatenStreak++;
      if (currentWinStreak > longestWinStreak) longestWinStreak = currentWinStreak;
    } else if (r === 'loss') {
      currentWinStreak = 0;
      currentLoseStreak++;
      currentUnbeatenStreak = 0;
      if (currentLoseStreak > longestLoseStreak) longestLoseStreak = currentLoseStreak;
    } else { // draw
      currentWinStreak = 0;
      currentLoseStreak = 0;
      currentUnbeatenStreak++;
    }
    if (currentUnbeatenStreak > longestUnbeatenStreak) longestUnbeatenStreak = currentUnbeatenStreak;
  }
  return { longestWinStreak, longestLoseStreak, longestUnbeatenStreak, currentWinStreak, currentLoseStreak, currentUnbeatenStreak };
}

/**
 * Emit a run-record fact only when this match beats the all-time or season
 * record; one line names the scope it set (the other ledger is never
 * mentioned — the chip/prose carries the record's own scope).
 * All-time always wins when both are broken.
 */
function pushStreakRecord(
  facts: PunditryFact[], type: string, playerId: number, playerName: string,
  newLen: number, alltimeRecord: number, seasonRecord: number, minLen: number,
  seasonName: string, describe: (len: number) => string
) {
  if (newLen < minLen) return;
  let scope: string; let record: number;
  if (newLen > alltimeRecord) {
    scope = 'all-time'; record = alltimeRecord;
  } else if (newLen > seasonRecord) {
    scope = seasonName; record = seasonRecord;
  } else return;
  facts.push({
    type,
    player_id: playerId,
    player_name: playerName,
    scope,
    notable: true,
    description: `${describe(newLen)} (${scope === 'all-time' ? 'an all-time record' : `a ${scope} record`})`,
    metadata: { streak_length: newLen, record_beaten: record }
  });
}

/**
 * Get biggest absolute Elo change in a match between two players before this match (ledger-scoped)
 */
function getBiggestEloChangeBetweenPlayersBefore(playerId1: number, playerId2: number, gameId: number, seasonId: number, beforeMatchId: number, ledger: Ledger = 'season'): number {
  const after = ledger === 'alltime' ? 'mp1.alltime_elo_after' : 'mp1.elo_after';
  const before = ledger === 'alltime' ? 'mp1.alltime_elo_before' : 'mp1.elo_before';
  const result = db.prepare(`
    SELECT MAX(ABS(${after} - ${before})) as biggest
    FROM matches m
    JOIN match_participants mp1 ON m.id = mp1.match_id
    JOIN match_participants mp2 ON m.id = mp2.match_id
    WHERE m.game_id = ?${ledger === 'alltime' ? '' : ' AND m.season_id = ?'} AND m.id < ?
      AND mp1.player_id = ? AND mp2.player_id = ?
      AND mp1.team != mp2.team
  `).get(...(ledger === 'alltime' ? [gameId, beforeMatchId, playerId1, playerId2] : [gameId, seasonId, beforeMatchId, playerId1, playerId2])) as { biggest: number } | null;
  return result?.biggest ?? 0;
}

/**
 * Get total points scored by player1 against player2 before this match
 */
function getPointsScoredAgainstBefore(playerId1: number, playerId2: number, gameId: number, beforeMatchId: number): number {
  const result = db.prepare(`
    SELECT SUM(mp1.score) as total
    FROM matches m
    JOIN match_participants mp1 ON m.id = mp1.match_id
    JOIN match_participants mp2 ON m.id = mp2.match_id
    WHERE m.game_id = ? AND m.id < ?
      AND mp1.player_id = ? AND mp2.player_id = ?
      AND mp1.team != mp2.team
  `).get(gameId, beforeMatchId, playerId1, playerId2) as { total: number | null } | null;
  return result?.total ?? 0;
}

/**
 * Get head-to-head match results between two players before this match;
 * optionally restricted to one season's slice.
 */
function getHeadToHeadResultsBefore(playerId1: number, playerId2: number, gameId: number, beforeMatchId: number, seasonId?: number): { match_id: number; player1_score: number; player2_score: number }[] {
  return db.prepare(`
    SELECT
      m.id as match_id,
      mp1.score as player1_score,
      mp2.score as player2_score
    FROM matches m
    JOIN match_participants mp1 ON m.id = mp1.match_id
    JOIN match_participants mp2 ON m.id = mp2.match_id
    WHERE m.game_id = ?${seasonId !== undefined ? ' AND m.season_id = ?' : ''} AND m.id < ?
      AND mp1.player_id = ? AND mp2.player_id = ?
      AND mp1.team != mp2.team
    ORDER BY m.played_at ASC
  `).all(...(seasonId !== undefined ? [gameId, seasonId, beforeMatchId, playerId1, playerId2] : [gameId, beforeMatchId, playerId1, playerId2])) as { match_id: number; player1_score: number; player2_score: number }[];
}

/**
 * Calculate punditry facts for a match
 */
export function getPunditryForMatch(matchId: number): PunditryFact[] {
  const facts: PunditryFact[] = [];

  // Get match info
  const match = db.prepare(`
    SELECT m.id, m.game_id, m.played_at, m.season_id, m.points_timeline
    FROM matches m
    WHERE m.id = ?
  `).get(matchId) as { id: number; game_id: number; played_at: string; season_id: number; points_timeline: string | null } | null;

  if (!match) return facts;

  // Season name for scope labels on season-ledger records (falls back when no row exists).
  const seasonName = getSeason(match.season_id)?.name ?? `Season ${match.season_id}`;

  // Get participants — both ledgers (season `elo_*`, continuous `alltime_*`)
  const participants = db.prepare(`
    SELECT mp.player_id, mp.team, mp.score, mp.elo_before, mp.elo_after,
      mp.alltime_elo_before, mp.alltime_elo_after, p.name as player_name
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    WHERE mp.match_id = ?
  `).all(matchId) as { player_id: number; team: number; score: number; elo_before: number; elo_after: number; alltime_elo_before: number; alltime_elo_after: number; player_name: string }[];

  // Elo readings for a ledger: all-time claims must be recorded against the
  // all-time ledger, not the match's season ledger
  const ledgerElo = (p: MatchParticipant, ledger: Ledger) => ({
    before: ledger === 'alltime' ? p.alltime_elo_before : p.elo_before,
    after: ledger === 'alltime' ? p.alltime_elo_after : p.elo_after,
  });

  // Get teams info
  const teamMap = new Map<number, { score: number; player_ids: number[] }>();
  for (const p of participants) {
    if (!teamMap.has(p.team)) {
      teamMap.set(p.team, { score: p.score, player_ids: [] });
    }
    teamMap.get(p.team)!.player_ids.push(p.player_id);
  }
  const teams = Array.from(teamMap.values());

  // Determine winners/losers
  const maxScore = Math.max(...teams.map(t => t.score));
  const winningTeams = teams.filter(t => t.score === maxScore);
  const isDraw = winningTeams.length > 1;
  const winnerIds = new Set<number>();
  const loserIds = new Set<number>();

  for (const team of teams) {
    if (team.score === maxScore && !isDraw) {
      team.player_ids.forEach(id => winnerIds.add(id));
    } else if (team.score < maxScore) {
      team.player_ids.forEach(id => loserIds.add(id));
    }
  }

  // Get player name map
  const playerNameMap = new Map(participants.map(p => [p.player_id, p.player_name]));

  for (const p of participants) {
    // 1. Highest ever skill — one line named by the scope it set (all-time wins over season)
    const highestBeforeAlltime = getHighestEloBefore(p.player_id, match.game_id, match.season_id, matchId, 'alltime');
    const highestBeforeSeason = getHighestEloBefore(p.player_id, match.game_id, match.season_id, matchId, 'season');
    const atElo1 = ledgerElo(p, 'alltime').after;
    const sElo1 = ledgerElo(p, 'season').after;
    if (highestBeforeAlltime === null || atElo1 > highestBeforeAlltime) {
      facts.push({
        type: 'highest_skill',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: 'all-time',
        notable: true,
        description: `That match puts ${playerNameMap.get(p.player_id)} on their all-time highest skill (${atElo1.toFixed(1)}) (an all-time record)`,
        metadata: { elo: atElo1, ledger: 'alltime' }
      });
    } else if (highestBeforeSeason === null || sElo1 > highestBeforeSeason) {
      facts.push({
        type: 'highest_skill',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: seasonName,
        notable: true,
        description: `That match puts ${playerNameMap.get(p.player_id)} on their highest skill (${sElo1.toFixed(1)}) (a ${seasonName} record)`,
        metadata: { elo: sElo1, ledger: 'season' }
      });
    }

    // 2. Lowest ever skill — same dual-scope rule
    const lowestBeforeAlltime = getLowestEloBefore(p.player_id, match.game_id, match.season_id, matchId, 'alltime');
    const lowestBeforeSeason = getLowestEloBefore(p.player_id, match.game_id, match.season_id, matchId, 'season');
    const atElo2 = ledgerElo(p, 'alltime').after;
    const sElo2 = ledgerElo(p, 'season').after;
    if (lowestBeforeAlltime === null || atElo2 < lowestBeforeAlltime) {
      facts.push({
        type: 'lowest_skill',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: 'all-time',
        notable: true,
        description: `That match puts ${playerNameMap.get(p.player_id)} on their all-time lowest skill (${atElo2.toFixed(1)}) (an all-time record)`,
        metadata: { elo: atElo2, ledger: 'alltime' }
      });
    } else if (lowestBeforeSeason === null || sElo2 < lowestBeforeSeason) {
      facts.push({
        type: 'lowest_skill',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: seasonName,
        notable: true,
        description: `That match puts ${playerNameMap.get(p.player_id)} on their lowest skill (${sElo2.toFixed(1)}) (a ${seasonName} record)`,
        metadata: { elo: sElo2, ledger: 'season' }
      });
    }

    // 3. Most significant match (biggest skill gain/loss) — each ledger reads its own deltas
    const eloChangeAlltime = Math.abs(p.alltime_elo_after - p.alltime_elo_before);
    const eloChangeSeason = Math.abs(p.elo_after - p.elo_before);
    const biggestBeforeAlltime = getBiggestEloChangeBefore(p.player_id, match.game_id, match.season_id, matchId, 'alltime');
    const biggestBeforeSeason = getBiggestEloChangeBefore(p.player_id, match.game_id, match.season_id, matchId, 'season');
    if (eloChangeAlltime > biggestBeforeAlltime && biggestBeforeAlltime > 0) {
      const change = p.alltime_elo_after - p.alltime_elo_before;
      const direction = change > 0 ? 'gain' : 'loss';
      facts.push({
        type: 'biggest_match',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: 'all-time',
        notable: true,
        description: `That was ${playerNameMap.get(p.player_id)}'s most significant match of all time (${eloChangeAlltime.toFixed(1)} skill ${direction}) (an all-time record)`,
        metadata: { change: eloChangeAlltime, ledger: 'alltime' }
      });
    } else if (eloChangeSeason > biggestBeforeSeason && biggestBeforeSeason > 0) {
      const change = p.elo_after - p.elo_before;
      const direction = change > 0 ? 'gain' : 'loss';
      facts.push({
        type: 'biggest_match',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: seasonName,
        notable: true,
        description: `That was ${playerNameMap.get(p.player_id)}'s most significant match this season (${eloChangeSeason.toFixed(1)} skill ${direction}) (a ${seasonName} record)`,
        metadata: { change: eloChangeSeason, ledger: 'season' }
      });
    }

    // 4. Points scored milestone (multiple of 100)
    const pointsBefore = getTotalPointsScoredBefore(p.player_id, match.game_id, matchId);
    const totalPoints = pointsBefore + p.score;
    if (totalPoints > 0 && totalPoints % 100 === 0) {
      facts.push({
        type: 'points_milestone',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        description: `That match hit a points scored milestone for ${playerNameMap.get(p.player_id)} (${totalPoints} total points)`,
        metadata: { total_points: totalPoints }
      });
    }

    // 6. Points conceded milestone (multiple of 100)
    const opponentScore = Math.max(...participants.filter(op => op.team !== p.team).map(op => op.score));
    const pointsConcededBefore = getTotalPointsConcededBefore(p.player_id, match.game_id, matchId);
    const totalConceded = pointsConcededBefore + opponentScore;
    if (totalConceded > 0 && totalConceded % 100 === 0) {
      facts.push({
        type: 'points_conceded_milestone',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        description: `That match hit a points conceded milestone for ${playerNameMap.get(p.player_id)} (${totalConceded} total points conceded)`,
        metadata: { total_conceded: totalConceded }
      });
    }

    // 7. Win milestone (multiple of 100)
    if (!isDraw && winnerIds.has(p.player_id)) {
      const winsBefore = getTotalWinsBefore(p.player_id, match.game_id, matchId);
      const totalWins = winsBefore + 1;
      if (totalWins > 0 && totalWins % 100 === 0) {
        facts.push({
          type: 'win_milestone',
          player_id: p.player_id,
          player_name: playerNameMap.get(p.player_id) ?? '',
          description: `That match hit a win milestone for ${playerNameMap.get(p.player_id)} (${totalWins} total wins)`,
          metadata: { total_wins: totalWins }
        });
      }
    }

    // 8 & 9. Streak calculations — computed on BOTH ledgers; a record line
    // names the scope it set (all-time wins over season when both are broken)
    const alltimeStreaks = computeStreaks(getMatchResultsBefore(p.player_id, match.game_id, matchId).map(r => r.result));
    const seasonStreaks = computeStreaks(getMatchResultsBefore(p.player_id, match.game_id, matchId, match.season_id).map(r => r.result));

    // Current result
    const currentResult = p.score > opponentScore ? 'win' as const : p.score < opponentScore ? 'loss' as const : 'draw' as const;

    // New streak lengths after this match
    const newStreak = {
      win: currentResult === 'win' ? alltimeStreaks.currentWinStreak + 1 : 0,
      lose: currentResult === 'loss' ? alltimeStreaks.currentLoseStreak + 1 : 0,
      unbeaten: currentResult !== 'loss' ? alltimeStreaks.currentUnbeatenStreak + 1 : 0
    };

    // 8. Longest streak milestone (≥3 wins/losses, ≥5 unbeaten)
    pushStreakRecord(
      facts, 'longest_win_streak', p.player_id, playerNameMap.get(p.player_id) ?? '',
      newStreak.win, alltimeStreaks.longestWinStreak, seasonStreaks.longestWinStreak, 3, seasonName,
      (len) => `That match hit a longest win streak milestone for ${playerNameMap.get(p.player_id)} (${len} wins)`
    );
    pushStreakRecord(
      facts, 'longest_lose_streak', p.player_id, playerNameMap.get(p.player_id) ?? '',
      newStreak.lose, alltimeStreaks.longestLoseStreak, seasonStreaks.longestLoseStreak, 3, seasonName,
      (len) => `That match hit a longest losing streak milestone for ${playerNameMap.get(p.player_id)} (${len} losses)`
    );
    pushStreakRecord(
      facts, 'longest_unbeaten_streak', p.player_id, playerNameMap.get(p.player_id) ?? '',
      newStreak.unbeaten, alltimeStreaks.longestUnbeatenStreak, seasonStreaks.longestUnbeatenStreak, 5, seasonName,
      (len) => `That match hit a longest unbeaten streak milestone for ${playerNameMap.get(p.player_id)} (${len} unbeaten)`
    );

    // 9. Streak broken — the streak that ended is a fact of the all-time ledger
    if (alltimeStreaks.currentWinStreak >= 3 && currentResult !== 'win') {
      facts.push({
        type: 'win_streak_broken',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: 'all-time',
        notable: true,
        description: `That match broke ${playerNameMap.get(p.player_id)}'s ${alltimeStreaks.currentWinStreak}-game winning streak`,
        metadata: { streak_length: alltimeStreaks.currentWinStreak }
      });
    }
    if (alltimeStreaks.currentLoseStreak >= 3 && currentResult !== 'loss') {
      facts.push({
        type: 'lose_streak_broken',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: 'all-time',
        notable: true,
        description: `That match ended ${playerNameMap.get(p.player_id)}'s ${alltimeStreaks.currentLoseStreak}-game losing streak`,
        metadata: { streak_length: alltimeStreaks.currentLoseStreak }
      });
    }
    if (alltimeStreaks.currentUnbeatenStreak >= 5 && currentResult === 'loss') {
      facts.push({
        type: 'unbeaten_streak_broken',
        player_id: p.player_id,
        player_name: playerNameMap.get(p.player_id) ?? '',
        scope: 'all-time',
        notable: true,
        description: `That match ended ${playerNameMap.get(p.player_id)}'s ${alltimeStreaks.currentUnbeatenStreak}-game unbeaten run`,
        metadata: { streak_length: alltimeStreaks.currentUnbeatenStreak }
      });
    }
  }

  // 5. Matches against milestone (between opponents on different teams)
  for (const [teamNum, teamData] of teamMap.entries()) {
    for (const [otherTeamNum, otherTeamData] of teamMap.entries()) {
      if (teamNum === otherTeamNum) continue;

      for (const playerId of teamData.player_ids) {
        for (const opponentId of otherTeamData.player_ids) {
          const matchesBefore = getMatchesBetweenPlayersBefore(playerId, opponentId, match.game_id, matchId);
          const totalMatches = matchesBefore + 1; // +1 for current match
          if (totalMatches > 0 && totalMatches % 100 === 0) {
            // Avoid duplicate facts for same pair
            if (playerId < opponentId) {
              facts.push({
                type: 'matches_against_milestone',
                player_id: playerId,
                player_name: playerNameMap.get(playerId) ?? '',
                description: `That match hit a matches played milestone between ${playerNameMap.get(playerId)} and ${playerNameMap.get(opponentId)} (${totalMatches} games)`,
                metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), total_matches: totalMatches }
              });
            }
          }
        }
      }
    }
  }

  // Head-to-head punditry (between opponents on different teams)
  for (const [teamNum, teamData] of teamMap.entries()) {
    for (const [otherTeamNum, otherTeamData] of teamMap.entries()) {
      if (teamNum === otherTeamNum) continue;

      for (const playerId of teamData.player_ids) {
        for (const opponentId of otherTeamData.player_ids) {
          // Get this player's score and elo change in this match
          const playerParticipant = participants.find(p => p.player_id === playerId);
          const opponentParticipant = participants.find(p => p.player_id === opponentId);

          if (!playerParticipant || !opponentParticipant) continue;

          // Head-to-head: Most significant game between players — each ledger reads its own deltas
          const eloChangeAlltime = Math.abs(playerParticipant.alltime_elo_after - playerParticipant.alltime_elo_before);
          const eloChangeSeason = Math.abs(playerParticipant.elo_after - playerParticipant.elo_before);
          const biggestBeforeAlltime = getBiggestEloChangeBetweenPlayersBefore(playerId, opponentId, match.game_id, match.season_id, matchId, 'alltime');
          const biggestBeforeSeason = getBiggestEloChangeBetweenPlayersBefore(playerId, opponentId, match.game_id, match.season_id, matchId, 'season');
          if (eloChangeAlltime > biggestBeforeAlltime && biggestBeforeAlltime > 0 && playerId < opponentId) {
            const change = playerParticipant.alltime_elo_after - playerParticipant.alltime_elo_before;
            const direction = change > 0 ? 'gain' : 'loss';
            facts.push({
              type: 'h2h_biggest_match',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              scope: 'all-time',
              notable: true,
              description: `That was the most significant match ever between ${playerNameMap.get(playerId)} and ${playerNameMap.get(opponentId)} (${eloChangeAlltime.toFixed(1)} skill ${direction} for ${playerNameMap.get(playerId)}) (an all-time record)`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), change: eloChangeAlltime, ledger: 'alltime' }
            });
          } else if (eloChangeSeason > biggestBeforeSeason && biggestBeforeSeason > 0 && playerId < opponentId) {
            const change = playerParticipant.elo_after - playerParticipant.elo_before;
            const direction = change > 0 ? 'gain' : 'loss';
            facts.push({
              type: 'h2h_biggest_match',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              scope: seasonName,
              notable: true,
              description: `That was the most significant match between ${playerNameMap.get(playerId)} and ${playerNameMap.get(opponentId)} this season (${eloChangeSeason.toFixed(1)} skill ${direction} for ${playerNameMap.get(playerId)}) (a ${seasonName} record)`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), change: eloChangeSeason, ledger: 'season' }
            });
          }

          // Head-to-head: Points scored milestone against opponent
          const pointsBefore = getPointsScoredAgainstBefore(playerId, opponentId, match.game_id, matchId);
          const totalPointsAgainst = pointsBefore + playerParticipant.score;
          if (totalPointsAgainst > 0 && totalPointsAgainst % 100 === 0) {
            facts.push({
              type: 'h2h_points_scored_milestone',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              description: `That match hit a points scored milestone for ${playerNameMap.get(playerId)} against ${playerNameMap.get(opponentId)} (${totalPointsAgainst} points)`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), total_points: totalPointsAgainst }
            });
          }

          // Head-to-head: Points conceded milestone against opponent
          const pointsConcededBefore = getPointsScoredAgainstBefore(opponentId, playerId, match.game_id, matchId);
          const totalConcededAgainst = pointsConcededBefore + opponentParticipant.score;
          if (totalConcededAgainst > 0 && totalConcededAgainst % 100 === 0) {
            facts.push({
              type: 'h2h_points_conceded_milestone',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              description: `That match hit a points conceded milestone for ${playerNameMap.get(playerId)} against ${playerNameMap.get(opponentId)} (${totalConcededAgainst} points conceded)`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), total_conceded: totalConcededAgainst }
            });
          }

          // Head-to-head: Streak calculations — both ledgers; a record line names its scope
          const alltimeH2HStreaks = computeStreaks(getHeadToHeadResultsBefore(playerId, opponentId, match.game_id, matchId).map(r =>
            r.player1_score > r.player2_score ? 'win' as const : r.player1_score < r.player2_score ? 'loss' as const : 'draw' as const));
          const seasonH2HStreaks = computeStreaks(getHeadToHeadResultsBefore(playerId, opponentId, match.game_id, matchId, match.season_id).map(r =>
            r.player1_score > r.player2_score ? 'win' as const : r.player1_score < r.player2_score ? 'loss' as const : 'draw' as const));

          // Current result from player's perspective
          const playerScore = playerParticipant.score;
          const opponentScore = opponentParticipant.score;
          const h2hCurrentResult = playerScore > opponentScore ? 'win' as const : playerScore < opponentScore ? 'loss' as const : 'draw' as const;

          // New streak lengths
          const newH2HWinStreak = h2hCurrentResult === 'win' ? alltimeH2HStreaks.currentWinStreak + 1 : 0;
          const newH2HLoseStreak = h2hCurrentResult === 'loss' ? alltimeH2HStreaks.currentLoseStreak + 1 : 0;
          const newH2HUnbeatenStreak = h2hCurrentResult !== 'loss' ? alltimeH2HStreaks.currentUnbeatenStreak + 1 : 0;

          // Head-to-head: Longest streak milestone (minimum 3 for win/loss, 5 for unbeaten)
          const h2hPusher = (type: string, newLen: number, alltimeRecord: number, seasonRecord: number, minLen: number, describe: (len: number) => string) => {
            if (newLen >= minLen) {
              let scope, record;
              if (newLen > alltimeRecord) { scope = 'all-time'; record = alltimeRecord; }
              else if (newLen > seasonRecord) { scope = seasonName; record = seasonRecord; }
              else return;
              facts.push({
                type,
                player_id: playerId,
                player_name: playerNameMap.get(playerId) ?? '',
                scope,
                notable: true,
                description: `${describe(newLen)} (${scope === 'all-time' ? 'an all-time record' : `a ${scope} record`})`,
                metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), streak_length: newLen, record_beaten: record }
              });
            }
          };
          h2hPusher('h2h_longest_win_streak', newH2HWinStreak, alltimeH2HStreaks.longestWinStreak, seasonH2HStreaks.longestWinStreak, 3,
            (len) => `That match set a new longest winning streak for ${playerNameMap.get(playerId)} against ${playerNameMap.get(opponentId)} (${len} wins)`);
          h2hPusher('h2h_longest_lose_streak', newH2HLoseStreak, alltimeH2HStreaks.longestLoseStreak, seasonH2HStreaks.longestLoseStreak, 3,
            (len) => `That match set a new longest losing streak for ${playerNameMap.get(playerId)} against ${playerNameMap.get(opponentId)} (${len} losses)`);
          h2hPusher('h2h_longest_unbeaten_streak', newH2HUnbeatenStreak, alltimeH2HStreaks.longestUnbeatenStreak, seasonH2HStreaks.longestUnbeatenStreak, 5,
            (len) => `That match set a new longest unbeaten run for ${playerNameMap.get(playerId)} against ${playerNameMap.get(opponentId)} (${len} unbeaten)`);

          // Head-to-head: Streak broken — the streak that ended is a fact of the all-time ledger
          if (alltimeH2HStreaks.currentWinStreak >= 3 && h2hCurrentResult !== 'win') {
            facts.push({
              type: 'h2h_win_streak_broken',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              scope: 'all-time',
              notable: true,
              description: `That match ended ${playerNameMap.get(playerId)}'s ${alltimeH2HStreaks.currentWinStreak}-game winning streak against ${playerNameMap.get(opponentId)}`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), streak_length: alltimeH2HStreaks.currentWinStreak }
            });
          }
          if (alltimeH2HStreaks.currentLoseStreak >= 3 && h2hCurrentResult !== 'loss') {
            facts.push({
              type: 'h2h_lose_streak_broken',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              scope: 'all-time',
              notable: true,
              description: `That match ended ${playerNameMap.get(playerId)}'s ${alltimeH2HStreaks.currentLoseStreak}-game losing streak against ${playerNameMap.get(opponentId)}`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), streak_length: alltimeH2HStreaks.currentLoseStreak }
            });
          }
          if (alltimeH2HStreaks.currentUnbeatenStreak >= 5 && h2hCurrentResult === 'loss') {
            facts.push({
              type: 'h2h_unbeaten_streak_broken',
              player_id: playerId,
              player_name: playerNameMap.get(playerId) ?? '',
              scope: 'all-time',
              notable: true,
              description: `That match ended ${playerNameMap.get(playerId)}'s ${alltimeH2HStreaks.currentUnbeatenStreak}-game unbeaten run against ${playerNameMap.get(opponentId)}`,
              metadata: { opponent_id: opponentId, opponent_name: playerNameMap.get(opponentId), streak_length: alltimeH2HStreaks.currentUnbeatenStreak }
            });
          }
        }
      }
    }
  }

  // ===== LIVE TIMELINE FACTS =====
  //
  // Game-state punditry off the live scorer's point timeline: comebacks,
  // wire-to-wire runs, lead changes, duration + pace. Timeline team indexes
  // follow the team labels (0, 1, ...) the match was recorded with.
  const timeline = parsePointTimeline(match.points_timeline);
  if (timeline && timeline.events.length > 0) {
    const orderedTeams = [...teamMap.entries()].sort((a, b) => a[0] - b[0]).map(([team, data]) => ({ team, ...data }));
    const stats = computeTimelineStats(timeline, orderedTeams.map(t => t.score));
    const topScore = Math.max(...orderedTeams.map(t => t.score));
    const isDraw = orderedTeams.filter(t => t.score === topScore).length > 1;

    const teamName = (teamIndex: number): string => {
      const ids = orderedTeams[teamIndex]?.player_ids ?? [];
      return ids.map(id => playerNameMap.get(id)).filter(Boolean).join(' & ');
    };

    // Comeback win
    if (!isDraw) {
      const loserScore = orderedTeams.find(t => t.score < topScore)?.score ?? 0;
      for (let i = 0; i < orderedTeams.length; i++) {
        const t = orderedTeams[i];
        const tStats = stats.teams[i];
        if (t.score !== topScore || !tStats || tStats.maxDeficit < 2) continue;
        const hero = playerNameMap.get(t.player_ids[0]) ?? 'Someone';
        facts.push({
          type: 'comeback',
          player_id: t.player_ids[0] ?? 0,
          player_name: hero,
          description: `${teamName(i)} came back from ${tStats.maxDeficit} down to win ${t.score}-${loserScore} — what a turnaround!`,
          metadata: { max_deficit: tStats.maxDeficit, score: `${t.score}-${loserScore}` }
        });
        break; // one comeback story is enough
      }

      // Wire-to-wire: first point + never trailed
      const wire = orderedTeams.find((t, i) => stats.wireToWireWinners.includes(i));
      if (wire && stats.wireToWireWinners.length > 0) {
        const wireIndex = orderedTeams.indexOf(wire);
        facts.push({
          type: 'first',
          player_id: wire.player_ids[0] ?? 0,
          player_name: playerNameMap.get(wire.player_ids[0]) ?? '',
          description: `${teamName(wireIndex)} scored first and were never behind — a wire-to-wire win`,
          metadata: { points: stats.pointCount }
        });
      }
    }

    // Lead changes
    if (stats.leadChanges >= 3) {
      facts.push({
        type: 'trend',
        player_id: 0,
        player_name: '',
        description: `The lead changed hands ${stats.leadChanges} times in that match — nobody let the other breathe`,
        metadata: { lead_changes: stats.leadChanges }
      });
    }

    // Duration + pace
    if (stats.durationMs !== null) {
      const minutes = stats.durationMs / 60000;
      if (minutes >= MARATHON_MINUTES) {
        facts.push({
          type: 'record',
          player_id: 0,
          player_name: '',
          description: `That match ran for ${Math.round(minutes)} minutes and ${stats.pointCount} points — a marathon`,
          metadata: { duration_ms: stats.durationMs, points: stats.pointCount }
        });
      } else if (minutes < 5 && stats.pointCount >= 10) {
        facts.push({
          type: 'offensive',
          player_id: 0,
          player_name: '',
          description: `Blitz match: ${stats.pointCount} points in ${Math.round(minutes * 10) / 10} minutes — barely time to breathe`,
          metadata: { duration_ms: stats.durationMs, points: stats.pointCount }
        });
      }
    }
  }

  // ===== ROLLUP (DD-0001 / A1 revision, generalized after live review) =====
  //
  // Run facts — record extensions AND broken-streak facts, solo AND h2h —
  // are faces of the same coin: one run story per player per match. Keep the
  // headline (all-time over season record, then record-set over
  // streak-ended, then solo over h2h, then win over lose over unbeaten) and
  // drop the rest.
  const RUN_FACT_TYPES = new Set([
    'longest_win_streak', 'longest_lose_streak', 'longest_unbeaten_streak',
    'h2h_longest_win_streak', 'h2h_longest_lose_streak', 'h2h_longest_unbeaten_streak',
    'win_streak_broken', 'lose_streak_broken', 'unbeaten_streak_broken',
    'h2h_win_streak_broken', 'h2h_lose_streak_broken', 'h2h_unbeaten_streak_broken',
  ]);
  const runGroups = new Map<string, { index: number; score: number }[]>();
  facts.forEach((f, index) => {
    if (!RUN_FACT_TYPES.has(f.type)) return;
    const isRecord = f.type.includes('longest');
    const isH2H = f.type.startsWith('h2h_');
    // h2h run facts are mirrors (a loss for A against B is a win for B against
    // A), so the coin group is the unordered PAIR, not one player's side.
    const key = isH2H
      ? `h2h:${[f.player_id, (f.metadata?.opponent_id ?? 0) as number].sort((a, b) => a - b).join(':')}`
      : `solo:${f.player_id}`;
    const score = (f.scope === 'all-time' ? 100 : 0)
      + (isRecord ? 10 : 0)
      + (isH2H ? 0 : 1)
      + (f.type.includes('win') ? 3 : f.type.includes('lose') ? 2 : 1);
    const group = runGroups.get(key) ?? [];
    group.push({ index, score });
    runGroups.set(key, group);
  });
  const droppedIndexes = new Set<number>();
  for (const group of runGroups.values()) {
    if (group.length < 2) continue;
    const keep = group.reduce((best, g) => (g.score > best.score ? g : best), group[0]);
    for (const g of group) {
      if (g.index !== keep.index) droppedIndexes.add(g.index);
    }
  }

  return facts.filter((f, index) => !droppedIndexes.has(index)).map(f => ({
    ...f,
    // Defaults for facts whose scope/notable is structural (milestones, timeline events)
    scope: f.scope ?? (f.type.includes('milestone') ? 'all-time' : 'match'),
    notable: f.notable ?? false,
  }));
}