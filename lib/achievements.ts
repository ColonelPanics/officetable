import db from './db';
import { resolveSeason, toDbDate } from './seasons';
import { getBank } from './bank';

export interface AchievementContext {
  matchId: number;
  gameId: number;
  /** Season the match belongs to (= its season ledger). */
  seasonId: number;
  playedAt: Date;
  /** The match's raw stored 'YYYY-MM-DD HH:MM:SS' (UTC) timestamp. When
   *  omitted it is derived from playedAt — passing the raw string avoids
   *  timezone drift in SQL timestamp comparisons. */
  playedAtDb?: string;
  teams: {
    team: number;
    player_ids: number[];
    score: number;
  }[];
  participants: {
    player_id: number;
    team: number;
    score: number;
    elo_before: number;
    elo_after: number;
  }[];
  playerNameMap: Map<number, string>;
}

export interface AchievementResult {
  achievementName: string;
  playerId: number;
  matchId: number;
  metadata?: object;
}

// (Ranking/board state comes from the ladder reconstruction inside
// checkAchievements below — see getLadderState.)

// Get player's total games in a game type within the match's season,
// up to and including a specific match
function getTotalGames(playerId: number, gameId: number, matchId: number, seasonId: number): number {
  const result = db.prepare(`
    SELECT COUNT(DISTINCT mp.match_id) as count
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ? AND m.id <= ? AND m.season_id = ?
  `).get(playerId, gameId, matchId, seasonId) as { count: number };
  return result.count;
}

// Get player's lowest elo ever in a game type within a season (season ledger)
function getLowestElo(playerId: number, gameId: number, seasonId: number): number | null {
  const result = db.prepare(`
    SELECT MIN(elo_before) as lowest FROM (
      SELECT mp.elo_before FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ? AND m.season_id = ?
      UNION
      SELECT elo as elo_before FROM player_ratings WHERE player_id = ? AND game_id = ? AND season_id = ?
    )
  `).get(playerId, gameId, seasonId, playerId, gameId, seasonId) as { lowest: number | null } | null;
  return result?.lowest ?? null;
}

// ---------------------------------------------------------------------------
// Ladder state over history
//
// The leaderboard's visibility rules (retired players hidden, inactive
// players hidden after the inactivity threshold) define who is "on the
// ladder". Achievement checks must rank against THAT board, and during
// historical recalculation they must be able to rebuild it for the match's
// own moment in time, so three dates are derived per player per sport
// straight from match history:
//   - first active: the first match they played in that sport (not when the
//     player row was added);
//   - inactive: the inactivity threshold (settings, current value) after
//     their most recent appearance at the moment being evaluated;
//   - retired: a retired player's final appearance (retirement dates aren't
//     stored, so the last match ever is the close-enough approximation).
// ---------------------------------------------------------------------------

/** Minimum matches a season board must have seen before board-position
 *  achievements (the_best, the_worst, boss_fight) can fire — rankings in a
 *  sub-10-match context are noise. */
const RANKING_MIN_BOARD_MATCHES = 10;

/** Moose bucks paid out of the table's pot each time an achievement is
 *  earned (live recording only — recalculation never re-pays). */
export const ACHIEVEMENT_PAYOUT = 5;

function inactiveThresholdDays(): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'inactive_threshold_days'`).get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) : 60;
}

function addDays(dbDate: string, days: number): string {
  const d = new Date(`${dbDate.replace(' ', 'T')}Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDbDate(d);
}

export interface LadderPlayerState {
  playerId: number;
  /** Current players.status — retirement is only knowable as of "now". */
  status: 'active' | 'retired';
  /** First match ever in this sport = when the player first appeared on the ladder. */
  firstActiveAt: string | null;
  /** Most recent appearance at or before the evaluated moment. */
  lastAppearanceAt: string | null;
  /** When the player counts as inactive: last appearance + threshold (non-retired only). */
  becomesInactiveAt: string | null;
  /** Retired players: their final appearance ≈ their retirement point. */
  retiredAt: string | null;
  /** Whether the player is on the ladder (visible/ranked) at that moment. */
  onLadder: boolean;
}

/**
 * Per-player ladder state for a sport at a moment in time (db timestamp
 * string). Recreates the board the leaderboard would show at that moment:
 *  - a player first appears on the ladder at their first match in the sport;
 *  - active players drop off inactive-threshold days after their latest
 *    appearance (evaluated against the given moment, so historical
 *    recalculation replays the timeline rather than using today's clock);
 *  - retired players stay on the ladder up to and including their final
 *    appearance; the inactivity grace does not outlive their retirement.
 */
export function getLadderState(gameId: number, atDb: string): Map<number, LadderPlayerState> {
  const thresholdDays = inactiveThresholdDays();

  const rows = db.prepare(`
    SELECT
      mp.player_id,
      p.status,
      MIN(m.played_at) as first_at,
      MAX(m.played_at) as last_at,
      MAX(CASE WHEN m.played_at <= ? THEN m.played_at END) as last_up_to
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    JOIN players p ON p.id = mp.player_id
    WHERE m.game_id = ?
    GROUP BY mp.player_id
  `).all(atDb, gameId) as {
    player_id: number;
    status: string | null;
    first_at: string;
    last_at: string;
    last_up_to: string | null;
  }[];

  const state = new Map<number, LadderPlayerState>();
  for (const row of rows) {
    const isRetired = row.status === 'retired';
    const firstActiveAt = row.first_at ?? null;
    const lastAppearanceAt = row.last_up_to ?? null;
    let retiredAt: string | null = null;
    let becomesInactiveAt: string | null = null;
    let onLadder = false;
    if (firstActiveAt !== null && firstActiveAt <= atDb) {
      if (isRetired) {
        retiredAt = row.last_at;
        onLadder = retiredAt !== null && atDb <= retiredAt;
      } else if (lastAppearanceAt !== null) {
        becomesInactiveAt = addDays(lastAppearanceAt, thresholdDays);
        onLadder = atDb <= becomesInactiveAt;
      }
    }
    state.set(row.player_id, {
      playerId: row.player_id,
      status: isRetired ? 'retired' : 'active',
      firstActiveAt,
      lastAppearanceAt,
      becomesInactiveAt,
      retiredAt,
      onLadder,
    });
  }
  return state;
}

// Check if this is opponent's first game EVER in this game type (all-time
// definition — season-scoping would let everyone re-farm this achievement
// at every season opener). Deliberately NOT season-scoped.
function isFirstGameForOpponent(playerId: number, gameId: number, matchId: number): boolean {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ? AND m.game_id = ? AND m.id < ?
  `).get(playerId, gameId, matchId) as { count: number };
  return result.count === 0;
}

export function checkAchievements(context: AchievementContext): AchievementResult[] {
  const results: AchievementResult[] = [];
  const { matchId, gameId, seasonId, playedAt, teams, participants, playerNameMap } = context;

  // Determine winners and losers
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

  // Match participants' pre-match elo (used by the against-the-odds checks)
  const eloBeforeMap = new Map<number, number>();
  for (const p of participants) {
    eloBeforeMap.set(p.player_id, p.elo_before);
  }

  // Get all players for name lookups (tiebreaker + achievement metadata)
  const allPlayerNamesBefore = new Map<number, string>();
  const allNamesStmt = db.prepare('SELECT id, name FROM players');
  for (const row of allNamesStmt.all() as { id: number; name: string }[]) {
    allPlayerNamesBefore.set(row.id, row.name);
  }

  // ===== INSTANT DETECTION =====

  // Fresh Blood: Claim points from a new player on their first game
  if (!isDraw) {
    for (const winnerId of winnerIds) {
      for (const loserId of loserIds) {
        if (isFirstGameForOpponent(loserId, gameId, matchId)) {
          results.push({
            achievementName: 'fresh_blood',
            playerId: winnerId,
            matchId,
            metadata: { new_player: playerNameMap.get(loserId) }
          });
        }
      }
    }
  }

  // Flawless Victory: Beat an opponent without conceding a point
  if (!isDraw && maxScore > 0) {
    const loserScore = teams.find(t => t.score < maxScore)?.score ?? 0;
    if (loserScore === 0) {
      for (const winnerId of winnerIds) {
        results.push({
          achievementName: 'flawless_victory',
          playerId: winnerId,
          matchId
        });
      }
    }
  }

  // Against the Odds / Against All Odds: Beat a player with higher Elo
  if (!isDraw) {
    for (const winnerId of winnerIds) {
      for (const loserId of loserIds) {
        const winnerElo = eloBeforeMap.get(winnerId) ?? 0;
        const loserElo = eloBeforeMap.get(loserId) ?? 0;
        const diff = loserElo - winnerElo;

        if (diff >= 100) {
          results.push({
            achievementName: 'against_all_odds',
            playerId: winnerId,
            matchId,
            metadata: { elo_difference: diff }
          });
        } else if (diff >= 50) {
          results.push({
            achievementName: 'against_the_odds',
            playerId: winnerId,
            matchId,
            metadata: { elo_difference: diff }
          });
        }
      }
    }
  }

  // Festive Cheer: Play on December 25th
  const month = playedAt.getMonth();
  const day = playedAt.getDate();
  if (month === 11 && day === 25) { // December is month 11 (0-indexed)
    for (const p of participants) {
      results.push({
        achievementName: 'festive_cheer',
        playerId: p.player_id,
        matchId
      });
    }
  }

  // Night Owl: Play between 00:00 and 03:00
  const hour = playedAt.getHours();
  if (hour >= 0 && hour < 3) {
    for (const p of participants) {
      results.push({
        achievementName: 'night_owl',
        playerId: p.player_id,
        matchId
      });
    }
  }

  // Resolve the raw db timestamp once — used for all SQL "as of this match"
  // comparisons (raw string avoids timezone drift from Date round-trips).
  const playedAtDb = context.playedAtDb ?? toDbDate(playedAt);

  // Board-position checks rank ONLY the ladder as it stood at this match's
  // moment — retired and inactive players are off the board (they don't
  // appear on the leaderboard, so they must not define #1 or last place),
  // and the values are rebuilt from match_participants history (see the
  // timeline query below) so recalculation works for any point in the past.
  const ladderState = getLadderState(gameId, playedAtDb);
  const onBoard = (playerId: number): boolean => ladderState.get(playerId)?.onLadder ?? false;

  // Board-position achievements only fire once the season's board has
  // settled: at least 10 matches played in it (this match included).
  const boardMatches = db.prepare(`
    SELECT COUNT(*) as count FROM matches
    WHERE game_id = ? AND season_id = ? AND played_at <= ?
  `).get(gameId, seasonId, playedAtDb) as { count: number };
  const boardSettled = boardMatches.count >= RANKING_MIN_BOARD_MATCHES;

  // Sort by elo descending (with player name tiebreaker) into a deterministic
  // ranking, restricted to players actually on the ladder.
  const sortRanked = (entries: [number, number][]): [number, number][] =>
    entries
      .filter(([id]) => onBoard(id))
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        const nameA = allPlayerNamesBefore.get(a[0]) ?? playerNameMap.get(a[0]) ?? '';
        const nameB = allPlayerNamesBefore.get(b[0]) ?? playerNameMap.get(b[0]) ?? '';
        return nameA.localeCompare(nameB);
      });

  // Rebuild the season-ledger ladder as of this match's moment: each player
  // owns the post-elo of their latest season match at or before now. For the
  // match's own participants the pre/post elo passed by the caller (which
  // knows this match's deltas in both leddgers) takes precedence, so live
  // recording and historical recalculation see exactly the same board.
  const ladderTimeline = db.prepare(`
    SELECT player_id, elo_after FROM (
      SELECT
        mp.player_id,
        mp.elo_after,
        ROW_NUMBER() OVER (
          PARTITION BY mp.player_id
          ORDER BY m.played_at DESC, m.id DESC
        ) as rn
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE m.game_id = ? AND m.season_id = ? AND m.played_at <= ? AND m.id != ?
    )
    WHERE rn = 1
  `).all(gameId, seasonId, playedAtDb, matchId) as { player_id: number; elo_after: number }[];

  const allEloBefore = new Map<number, number>();
  for (const row of ladderTimeline) {
    allEloBefore.set(row.player_id, row.elo_after);
  }
  for (const p of participants) {
    allEloBefore.set(p.player_id, p.elo_before);
  }

  const sortedBefore = sortRanked([...allEloBefore.entries()]);
  const numberOneBefore = sortedBefore[0]?.[0];
  const lastBefore = sortedBefore[sortedBefore.length - 1]?.[0];

  if (!isDraw && boardSettled) {
    for (const winnerId of winnerIds) {
      for (const loserId of loserIds) {
        if (loserId === numberOneBefore && winnerId !== numberOneBefore) {
          results.push({
            achievementName: 'boss_fight',
            playerId: winnerId,
            matchId,
            metadata: { defeated_ranked: 1 }
          });
        }
      }
    }
  }

  // The Best / The Worst: Only if rank changes into #1 or last position
  if (!isDraw && boardSettled) {
    // Calculate the after-match board (same timeline with this match applied)
    const allEloAfter = new Map<number, number>();
    for (const row of ladderTimeline) {
      allEloAfter.set(row.player_id, row.elo_after);
    }
    for (const p of participants) {
      allEloAfter.set(p.player_id, p.elo_after);
    }

    const sortedAfter = sortRanked([...allEloAfter.entries()]);
    const numberOneAfter = sortedAfter[0]?.[0];
    const lastAfter = sortedAfter[sortedAfter.length - 1]?.[0];

    // The Best: Only if player is now #1 AND wasn't #1 before
    for (const winnerId of winnerIds) {
      if (winnerId === numberOneAfter && winnerId !== numberOneBefore) {
        results.push({
          achievementName: 'the_best',
          playerId: winnerId,
          matchId
        });
      }
    }

    // The Worst: Only if player is now last AND wasn't last before
    for (const loserId of loserIds) {
      if (loserId === lastAfter && loserId !== lastBefore) {
        results.push({
          achievementName: 'the_worst',
          playerId: loserId,
          matchId
        });
      }
    }
  }

  // ===== MILESTONE DETECTION =====

  // Game count milestones
  const milestones: [number, string][] = [
    [100, 'mostly_harmless'],
    [500, 'committed'],
    [1000, 'dangerous'],
    [2000, 'resident'],
    [10000, 'elite']
  ];

  for (const p of participants) {
    const totalGames = getTotalGames(p.player_id, gameId, matchId, seasonId);
    for (const [threshold, name] of milestones) {
      if (totalGames === threshold) {
        results.push({
          achievementName: name,
          playerId: p.player_id,
          matchId,
          metadata: { total_games: threshold }
        });
      }
    }
  }

  // Improver: Gain 100 skill points from lowest point within the season ledger
  for (const p of participants) {
    const lowestElo = getLowestElo(p.player_id, gameId, seasonId);
    if (lowestElo !== null) {
      const currentElo = p.elo_after;
      const justReached = currentElo >= lowestElo + 100 && p.elo_before < lowestElo + 100;
      if (justReached) {
        const existing = db.prepare(`
          SELECT COUNT(*) as count FROM player_achievements pa
          JOIN achievements a ON pa.achievement_id = a.id
          WHERE pa.player_id = ? AND pa.game_id = ? AND pa.season_id = ? AND a.name = 'improver'
        `).get(p.player_id, gameId, seasonId) as { count: number };

        if (existing.count === 0) {
          results.push({
            achievementName: 'improver',
            playerId: p.player_id,
            matchId,
            metadata: { from_lowest: currentElo - lowestElo }
          });
        }
      }
    }
  }

  // ===== STREAK/HISTORICAL DETECTION =====

  // Unstable: See-saw 5+ skill points in consecutive games
  for (const p of participants) {
    // Must filter to matches up to and including current match for recalculation to work correctly
    const recentMatches = db.prepare(`
      SELECT mp.elo_before, mp.elo_after, m.played_at
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ? AND m.id <= ? AND m.season_id = ?
      ORDER BY m.played_at DESC
      LIMIT 2
    `).all(p.player_id, gameId, matchId, seasonId) as { elo_before: number; elo_after: number; played_at: string }[];

    if (recentMatches.length >= 2) {
      const change1 = recentMatches[0].elo_after - recentMatches[0].elo_before;
      const change2 = recentMatches[1].elo_after - recentMatches[1].elo_before;

      const absChange1 = Math.abs(change1);
      const absChange2 = Math.abs(change2);
      const oppositeDirections = (change1 > 0 && change2 < 0) || (change1 < 0 && change2 > 0);

      if (absChange1 >= 5 && absChange2 >= 5 && oppositeDirections) {
        results.push({
          achievementName: 'unstable',
          playerId: p.player_id,
          matchId,
          metadata: { change1, change2 }
        });
      }
    }
  }

  // The Dominator: Defeat a player in 10 consecutive games
  if (!isDraw) {
    for (const winnerId of winnerIds) {
      for (const loserId of loserIds) {
        // Check consecutive wins against this opponent
        const matches = db.prepare(`
          SELECT
            m.id as match_id,
            mp1.player_id as player1_id,
            mp1.score as player1_score,
            mp2.player_id as player2_id,
            mp2.score as player2_score
          FROM matches m
          JOIN match_participants mp1 ON m.id = mp1.match_id
          JOIN match_participants mp2 ON m.id = mp2.match_id
          WHERE m.game_id = ?
            AND mp1.player_id = ? AND mp2.player_id = ?
            AND mp1.team != mp2.team
            AND m.id <= ?
            AND m.season_id = ?
          ORDER BY m.played_at DESC
          LIMIT 10
        `).all(gameId, winnerId, loserId, matchId, seasonId) as {
          match_id: number;
          player1_id: number;
          player1_score: number;
          player2_id: number;
          player2_score: number;
        }[];

        if (matches.length >= 10) {
          const allWonByWinner = matches.every(m =>
            (m.player1_id === winnerId && m.player1_score > m.player2_score) ||
            (m.player2_id === winnerId && m.player2_score > m.player1_score)
          );

          if (allWonByWinner) {
            // Check if we already awarded this achievement for this streak
            const existingStreak = db.prepare(`
              SELECT COUNT(*) as count FROM player_achievements pa
              JOIN achievements a ON pa.achievement_id = a.id
              WHERE pa.player_id = ? AND pa.game_id = ? AND pa.season_id = ? AND a.name = 'the_dominator'
                AND JSON_EXTRACT(pa.metadata, '$.victim') = ?
            `).get(winnerId, gameId, seasonId, playerNameMap.get(loserId) ?? '') as { count: number };

            if (existingStreak.count === 0) {
              results.push({
                achievementName: 'the_dominator',
                playerId: winnerId,
                matchId,
                metadata: { victim: playerNameMap.get(loserId), streak: 10 }
              });
            }
          }
        }
      }
    }
  }

  // Nothing if not Consistent: Finish 5 consecutive games with the same score (full match result)
  for (const p of participants) {
    const recentMatches = db.prepare(`
      SELECT
        mp.score as player_score,
        (SELECT MAX(mp2.score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team) as opponent_score
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ? AND m.id <= ? AND m.season_id = ?
      ORDER BY m.played_at DESC
      LIMIT 5
    `).all(p.player_id, gameId, matchId, seasonId) as { player_score: number; opponent_score: number }[];

    if (recentMatches.length === 5) {
      const firstMatch = recentMatches[0];
      const allSameResult = recentMatches.every(m =>
        m.player_score === firstMatch.player_score && m.opponent_score === firstMatch.opponent_score
      );
      if (allSameResult) {
        results.push({
          achievementName: 'nothing_if_not_consistent',
          playerId: p.player_id,
          matchId,
          metadata: { player_score: firstMatch.player_score, opponent_score: firstMatch.opponent_score }
        });
      }
    }
  }

  // Comrades: Play 100 games against the same opponent
  for (const team of teams) {
    for (const otherTeam of teams) {
      if (team.team === otherTeam.team) continue;

      for (const playerId of team.player_ids) {
        for (const opponentId of otherTeam.player_ids) {
          // Check if we already awarded this achievement for this opponent pair
          const existingAchievement = db.prepare(`
            SELECT COUNT(*) as count FROM player_achievements pa
            JOIN achievements a ON pa.achievement_id = a.id
            WHERE pa.player_id = ? AND pa.game_id = ? AND pa.season_id = ? AND a.name = 'comrades'
              AND JSON_EXTRACT(pa.metadata, '$.opponent') = ?
          `).get(playerId, gameId, seasonId, playerNameMap.get(opponentId) ?? '') as { count: number };

          if (existingAchievement.count > 0) continue;

          const gamesAgainst = db.prepare(`
            SELECT COUNT(DISTINCT m.id) as count
            FROM matches m
            JOIN match_participants mp1 ON m.id = mp1.match_id
            JOIN match_participants mp2 ON m.id = mp2.match_id
            WHERE m.game_id = ?
              AND mp1.player_id = ? AND mp2.player_id = ?
              AND mp1.team != mp2.team
              AND m.id <= ?
              AND m.season_id = ?
          `).get(gameId, playerId, opponentId, matchId, seasonId) as { count: number };

          if (gamesAgainst.count === 100) {
            results.push({
              achievementName: 'comrades',
              playerId: playerId,
              matchId,
              metadata: { opponent: playerNameMap.get(opponentId) }
            });
          }
        }
      }
    }
  }

  // Dedication: Play at least once every 60 days for a year
  for (const p of participants) {
    const matchDates = db.prepare(`
      SELECT DISTINCT DATE(m.played_at) as play_date
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ? AND m.id <= ? AND m.season_id = ?
      ORDER BY play_date ASC
    `).all(p.player_id, gameId, matchId, seasonId) as { play_date: string }[];

    if (matchDates.length > 0) {
      const dates = matchDates.map(d => new Date(d.play_date));

      // Check if span is at least 365 days
      const firstDate = dates[0];
      const lastDate = dates[dates.length - 1];
      const spanDays = Math.floor((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));

      if (spanDays >= 365) {
        // Check max gap between consecutive play dates
        let maxGap = 0;
        for (let i = 1; i < dates.length; i++) {
          const gap = Math.floor((dates[i].getTime() - dates[i-1].getTime()) / (1000 * 60 * 60 * 24));
          maxGap = Math.max(maxGap, gap);
        }

        if (maxGap <= 60) {
          // Check if we already awarded this
          const existing = db.prepare(`
            SELECT COUNT(*) as count FROM player_achievements pa
            JOIN achievements a ON pa.achievement_id = a.id
            WHERE pa.player_id = ? AND pa.game_id = ? AND pa.season_id = ? AND a.name = 'dedication'
          `).get(p.player_id, gameId, seasonId) as { count: number };

          if (existing.count === 0) {
            results.push({
              achievementName: 'dedication',
              playerId: p.player_id,
              matchId,
              metadata: { span_days: spanDays, max_gap: maxGap }
            });
          }
        }
      }
    }
  }

  // Early Bird: Play and win the first game of the day
  const matchDate = playedAt.toISOString().split('T')[0];
  const firstGameOfDay = db.prepare(`
    SELECT m.id FROM matches m
    WHERE m.game_id = ? AND DATE(m.played_at) = ? AND m.season_id = ?
    ORDER BY m.played_at ASC
    LIMIT 1
  `).get(gameId, matchDate, seasonId) as { id: number } | undefined;

  if (firstGameOfDay?.id === matchId && !isDraw) {
    for (const winnerId of winnerIds) {
      results.push({
        achievementName: 'early_bird',
        playerId: winnerId,
        matchId,
        metadata: { date: matchDate }
      });
    }
  }

  return results;
}

export interface SaveAchievementsOptions {
  /** Pay each earner a small achievement payout out of the table's pot.
   *  Only for LIVE recording — recalculation/replay must never re-pay
   *  (players would farm the pot by triggering recalcs). */
  payFromPot?: boolean;
}

export function saveAchievements(results: AchievementResult[], gameId: number, seasonId: number, options: SaveAchievementsOptions = {}): Map<number, number> {
  // Re-earnable per season: rows are unique per (player, game, achievement, season)
  // for the "awarded-once" achievements, which is enforced by the per-season
  // dedup checks inside checkAchievements. Multiple-earn achievements (like
  // fresh_blood) legitimately produce multiple rows.
  const insertStmt = db.prepare(`
    INSERT INTO player_achievements (player_id, game_id, achievement_id, match_id, metadata, season_id, earned_at)
    VALUES (?, ?, (SELECT id FROM achievements WHERE name = ?), ?, ?, ?, ?)
  `);
  const playedAtStmt = db.prepare('SELECT played_at FROM matches WHERE id = ?');

  for (const result of results) {
    // The earned date is the MATCH's timestamp — when the achievement was
    // actually earned in play, NOT when the check ran (recalculated
    // achievements keep their original earn date, and don't all pile onto
    // the day the ladder went live).
    const playedAtRow = playedAtStmt.get(result.matchId) as { played_at: string } | undefined;
    insertStmt.run(
      result.playerId,
      gameId,
      result.achievementName,
      result.matchId,
      result.metadata ? JSON.stringify(result.metadata) : null,
      seasonId,
      playedAtRow?.played_at ?? toDbDate(new Date())
    );
  }

  if (options.payFromPot) {
    return payAchievementPayouts(results);
  }
  return new Map();
}

/**
 * Achievement payout: each freshly earned achievement pays a small amount of
 * moose bucks out of the table's pot to its earner — playing well literally
 * pays. Nothing is paid when the pot has no cash (the payout never overdrafts
 * the pot). Returns each earner's total paid (players who got nothing are
 * simply absent).
 */
function payAchievementPayouts(results: AchievementResult[]): Map<number, number> {
  const bank = getBank();
  const paid = new Map<number, number>();
  for (const result of results) {
    const pot = bank.getHouseBalance();
    if (pot < ACHIEVEMENT_PAYOUT) return paid; // table's pot has no cash left — stop paying
    const memo = `achievement payout — ${result.achievementName.replace(/_/g, ' ')}`;
    // Pot pays player: house debit (stays local — reconciled against the
    // bank's real pot by the resync) + player credit (mirrored to the central
    // bank as a service 'win' transfer by the bank_sync outbox).
    db.transaction(() => {
      bank.debit(null, ACHIEVEMENT_PAYOUT, { type: 'achievement_payout', id: result.matchId, memo });
      bank.credit(result.playerId, ACHIEVEMENT_PAYOUT, { type: 'achievement_payout', id: result.matchId, memo });
    })();
    paid.set(result.playerId, (paid.get(result.playerId) ?? 0) + ACHIEVEMENT_PAYOUT);
  }
  return paid;
}

export function deleteAchievementsForMatch(matchId: number): void {
  db.prepare('DELETE FROM player_achievements WHERE match_id = ?').run(matchId);
}

export function deleteAchievementsForMatches(matchIds: number[]): void {
  if (matchIds.length === 0) return;
  const placeholders = matchIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM player_achievements WHERE match_id IN (${placeholders})`).run(...matchIds);
}

export function getAchievementsForPlayer(playerId: number, gameId?: number, seasonId?: number): { achievement_id: number; achievement_name: string; achievement_description: string; achievement_category: string; count: number; first_earned_at: string }[] {
  let query = `
    SELECT
      a.id as achievement_id,
      a.name as achievement_name,
      a.description as achievement_description,
      a.category as achievement_category,
      COUNT(*) as count,
      MIN(pa.earned_at) as first_earned_at
    FROM player_achievements pa
    JOIN achievements a ON pa.achievement_id = a.id
    WHERE pa.player_id = ?
  `;
  const params: (number | number[])[] = [playerId];

  if (gameId) {
    query += ' AND pa.game_id = ?';
    params.push(gameId);
  }

  if (seasonId !== undefined) {
    query += ' AND pa.season_id = ?';
    params.push(seasonId);
  }

  query += ' GROUP BY a.id ORDER BY a.category, a.name';

  const stmt = db.prepare(query);
  return stmt.all(...params) as { achievement_id: number; achievement_name: string; achievement_description: string; achievement_category: string; count: number; first_earned_at: string }[];
}

export function getAchievementsForMatch(matchId: number): { achievement_name: string; achievement_description: string; achievement_icon: string | null; player_id: number; player_name: string }[] {
  const stmt = db.prepare(`
    SELECT
      a.name as achievement_name,
      a.description as achievement_description,
      a.icon as achievement_icon,
      pa.player_id,
      p.name as player_name
    FROM player_achievements pa
    JOIN achievements a ON pa.achievement_id = a.id
    JOIN players p ON pa.player_id = p.id
    WHERE pa.match_id = ?
    ORDER BY a.name, p.name
  `);
  return stmt.all(matchId) as { achievement_name: string; achievement_description: string; achievement_icon: string | null; player_id: number; player_name: string }[];
}

/**
 * Recalculate all achievements for a game.
 * This deletes existing achievements for the game and replays them from match
 * history, resolving each match's season so achievements get re-earned per
 * season correctly. Pass seasonId to restrict to a single season.
 * Returns the number of achievements awarded.
 */
export function recalculateAchievementsForGame(gameId: number, seasonId?: number): { matchesProcessed: number; achievementsAwarded: number } {
  // Delete existing achievements for this game (optionally one season only)
  if (seasonId !== undefined) {
    db.prepare('DELETE FROM player_achievements WHERE game_id = ? AND season_id = ?').run(gameId, seasonId);
  } else {
    db.prepare('DELETE FROM player_achievements WHERE game_id = ?').run(gameId);
  }

  // Get all matches for this game in chronological order
  const matches = db.prepare(`
    SELECT m.id, m.played_at, m.notes, m.season_id
    FROM matches m
    WHERE m.game_id = ?${seasonId !== undefined ? ' AND m.season_id = ?' : ''}
    ORDER BY m.played_at ASC, m.id ASC
  `).all(...(seasonId !== undefined ? [gameId, seasonId] : [gameId])) as { id: number; played_at: string; notes: string | null; season_id: number }[];

  // Get player name map
  const players = db.prepare('SELECT id, name FROM players').all() as { id: number; name: string }[];
  const playerNameMap = new Map(players.map(p => [p.id, p.name]));

  let achievementsAwarded = 0;

  for (const match of matches) {
    // Get participants for this match
    const participants = db.prepare(`
      SELECT player_id, team, score, elo_before, elo_after
      FROM match_participants
      WHERE match_id = ?
    `).all(match.id) as { player_id: number; team: number; score: number; elo_before: number; elo_after: number }[];

    // Group participants into teams
    const teamMap = new Map<number, { player_ids: number[]; score: number }>();
    for (const p of participants) {
      if (!teamMap.has(p.team)) {
        teamMap.set(p.team, { player_ids: [], score: p.score });
      }
      teamMap.get(p.team)!.player_ids.push(p.player_id);
    }

    const teams = Array.from(teamMap.values()).map((t, idx) => ({
      team: idx,
      player_ids: t.player_ids,
      score: t.score
    }));

    const playedAt = new Date(match.played_at.replace(' ', 'T'));

    // Season: resolve from the match's played_at (canonical), falling back to
    // the stored season_id if the timestamp can't resolve (e.g. before the
    // first season start).
    const matchSeasonId = resolveSeason(match.played_at) || match.season_id || 0;

    // Check achievements
    const achievementResults = checkAchievements({
      matchId: match.id,
      gameId,
      seasonId: matchSeasonId,
      playedAt,
      playedAtDb: match.played_at,
      teams,
      participants,
      playerNameMap
    });

    if (achievementResults.length > 0) {
      saveAchievements(achievementResults, gameId, matchSeasonId);
      achievementsAwarded += achievementResults.length;
    }
  }

  return { matchesProcessed: matches.length, achievementsAwarded };
}

/**
 * Recalculate achievements for all games.
 * Returns summary of achievements awarded per game.
 */
export function recalculateAllAchievements(): { game_name: string; matches_processed: number; achievements_awarded: number }[] {
  const games = db.prepare('SELECT id, name FROM games').all() as { id: number; name: string }[];

  const results = [];
  for (const game of games) {
    const result = recalculateAchievementsForGame(game.id);
    results.push({
      game_name: game.name,
      matches_processed: result.matchesProcessed,
      achievements_awarded: result.achievementsAwarded
    });
  }

  return results;
}