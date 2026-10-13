// Ladder time machine: reconstruct what the ladder looked like at any point
// in history for a sport.
//
// The same machinery the achievement checks use (see getLadderState +
// the participants timeline in checkAchievements) rebuilds a moment's board:
//   - visibility comes from the ladder rules evaluated AT the moment
//     (first match = on the ladder, inactive-threshold drop-off, retired
//     players visible only up to their final appearance);
//   - values come from the season ledger's match_participants timeline
//     (latest post-elo at or before the moment) — never from today's
//     player_ratings rows, which only describe the present.
// The snapshot is taken AFTER anything whose played_at is at-or-before the
// chosen moment, so selecting a match's timestamp shows the board as it
// stood right after that match.

import db from './db';
import { getLadderState } from './achievements';
import { resolveSeason, getSeason, normaliseDbDate, toDbDate } from './seasons';

export interface LadderSnapshotEntry {
  player_id: number;
  player_name: string;
  avatar_url: string | null;
  /** Season-ledger rating as of the moment. */
  elo: number;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  /** Last 10 season-ledger rating deltas at or before the moment (oldest → newest). */
  trend: number[];
  last_match_at: string | null;
}

export interface LadderSnapshot {
  game_id: number;
  /** The moment the snapshot was taken (canonical DB datetime string). */
  at: string;
  /** Season the moment belonged to (null when no seasons exist yet). */
  season: { id: number; name: string } | null;
  /** Matches played in this sport (any season) at or before the moment. */
  total_matches: number;
  /** Matches played in the snapshot's season at or before the moment. */
  season_matches: number;
  entries: LadderSnapshotEntry[];
}

export interface LadderTimelinePoint {
  id: number;
  played_at: string;
  season_id: number;
}

/** Every match of a sport in chronological order — the timeline spine the
 *  front-end slider steps through. */
export function getLadderTimeline(gameId: number): LadderTimelinePoint[] {
  return db.prepare(`
    SELECT id, played_at, season_id FROM matches
    WHERE game_id = ?
    ORDER BY played_at ASC, id ASC
  `).all(gameId) as LadderTimelinePoint[];
}

/** Accept a date-only string (= end of that day, "how things stood that
 *  evening"), any datetime-ish string, or a Date. Returns the canonical
 *  DB datetime string. */
function normaliseMoment(input: string | Date): string {
  if (input instanceof Date) return toDbDate(input);
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed} 23:59:59`;
  }
  return normaliseDbDate(trimmed);
}

/**
 * Rebuild the ladder for `gameId` as it stood at the given moment (after all
 * matches whose played_at is at-or-before it). Only players who were actually
 * on the ladder at the moment are ranked — retired and inactive players are
 * left out exactly as the live leaderboard would have hidden them then.
 */
export function getLadderSnapshot(gameId: number, atInput: string | Date): LadderSnapshot {
  const at = normaliseMoment(atInput);
  const seasonId = resolveSeason(at);
  const seasonRow = getSeason(seasonId);

  // Who was on the ladder at the moment (visibility rules evaluated at `at`)
  const ladderState = getLadderState(gameId, at);

  // Board values: each player owns the post-elo of their latest match in the
  // moment's season ledger at or before `at` (0-era ledgers included).
  const boardRows = db.prepare(`
    SELECT t.player_id, t.elo_after, p.name as player_name, p.avatar_url
    FROM (
      SELECT
        mp.player_id,
        mp.elo_after,
        ROW_NUMBER() OVER (
          PARTITION BY mp.player_id
          ORDER BY m.played_at DESC, m.id DESC
        ) as rn
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE m.game_id = ? AND m.season_id = ? AND m.played_at <= ?
    ) t
    JOIN players p ON p.id = t.player_id
    WHERE rn = 1
  `).all(gameId, seasonId, at) as {
    player_id: number;
    elo_after: number;
    player_name: string;
    avatar_url: string | null;
  }[];

  // Season participations at or before the moment: W/L/D + trend deltas.
  const seasonRows = db.prepare(`
    SELECT mp.player_id, mp.team, mp.score, m.id as match_id, m.played_at,
           mp.elo_after - mp.elo_before as delta
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ? AND m.season_id = ? AND m.played_at <= ?
    ORDER BY m.played_at ASC, m.id ASC
  `).all(gameId, seasonId, at) as {
    player_id: number;
    team: number;
    score: number;
    match_id: number;
    played_at: string;
    delta: number;
  }[];

  // Team scores per match for outcome computation
  const matchTeamScores = new Map<number, Map<number, number>>();
  for (const row of seasonRows) {
    if (!matchTeamScores.has(row.match_id)) {
      matchTeamScores.set(row.match_id, new Map());
    }
    matchTeamScores.get(row.match_id)!.set(row.team, row.score);
  }

  const wld = new Map<number, { wins: number; losses: number; draws: number }>();
  const trends = new Map<number, number[]>();
  for (const row of seasonRows) {
    if (!wld.has(row.player_id)) wld.set(row.player_id, { wins: 0, losses: 0, draws: 0 });
    if (!trends.has(row.player_id)) trends.set(row.player_id, []);
    const stats = wld.get(row.player_id)!;

    let opponentScore: number | null = null;
    for (const [team, score] of matchTeamScores.get(row.match_id)!) {
      if (team !== row.team) {
        opponentScore = score;
        break;
      }
    }
    if (opponentScore !== null) {
      if (row.score > opponentScore) stats.wins++;
      else if (row.score < opponentScore) stats.losses++;
      else stats.draws++;
    }

    const trend = trends.get(row.player_id)!;
    trend.push(row.delta);
    if (trend.length > 10) trend.shift();
  }

  // Last appearance (any season) at or before the moment
  const lastMatchRows = db.prepare(`
    SELECT mp.player_id, MAX(m.played_at) as last_match_at
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ? AND m.played_at <= ?
    GROUP BY mp.player_id
  `).all(gameId, at) as { player_id: number; last_match_at: string }[];
  const lastMatch = new Map(lastMatchRows.map(r => [r.player_id, r.last_match_at]));

  const entries: LadderSnapshotEntry[] = boardRows
    .filter(row => ladderState.get(row.player_id)?.onLadder ?? false)
    .map(row => {
      const stats = wld.get(row.player_id) ?? { wins: 0, losses: 0, draws: 0 };
      return {
        player_id: row.player_id,
        player_name: row.player_name,
        avatar_url: row.avatar_url,
        elo: row.elo_after,
        rank: 0,
        wins: stats.wins,
        losses: stats.losses,
        draws: stats.draws,
        trend: trends.get(row.player_id) ?? [],
        last_match_at: lastMatch.get(row.player_id) ?? null,
      };
    })
    .sort((a, b) => {
      if (b.elo !== a.elo) return b.elo - a.elo;
      return a.player_name.localeCompare(b.player_name);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN season_id = ? THEN 1 ELSE 0 END) as in_season
    FROM matches
    WHERE game_id = ? AND played_at <= ?
  `).get(seasonId, gameId, at) as { total: number; in_season: number | null };

  return {
    game_id: gameId,
    at,
    season: seasonRow ? { id: seasonRow.id, name: seasonRow.name } : null,
    total_matches: counts.total,
    season_matches: counts.in_season ?? 0,
    entries,
  };
}