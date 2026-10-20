import db from './db';
import type { LeaderboardEntry, Game, GameStats } from './types';
import { ALLTIME_SEASON_ID, getCurrentSeason, getSeason } from './seasons';
import 'server-only';

export type { Game };
export type { GameStats };

export interface Record {
  player_id: number;
  player_name: string;
  value: number | string;
  date?: string;
  opponent?: string;
}

export interface GameRecords {
  highest_skill: Record | null;
  lowest_skill: Record | null;
  peak_skill_ever: Record | null;
  trough_skill_ever: Record | null;
  most_games: Record | null;
  highest_win_rate: Record | null;
  longest_win_streak: Record | null;
  longest_lose_streak: Record | null;
  longest_unbeaten_streak: Record | null;
  biggest_skill_gain: Record | null;
  biggest_skill_loss: Record | null;
}

export function getGames(): Game[] {
  return db.prepare('SELECT id, name, score_type, score_value, created_at, image_url FROM games').all() as Game[];
}

export interface LeaderboardOptions {
  includeRetired?: boolean;
  includeInactive?: boolean;
  scope?: 'season' | 'alltime';
  /** Explicit past-season id (takes precedence over scope). */
  seasonId?: number;
}

export function getLeaderboard(gameId: number, options: LeaderboardOptions = {}): LeaderboardEntry[] {
  const { includeRetired = false, includeInactive = false, scope = 'season' } = options;

  const currentSeason = getCurrentSeason();
  let targetSeasonId: number;
  if (options.seasonId !== undefined) {
    targetSeasonId = options.seasonId === ALLTIME_SEASON_ID || getSeason(options.seasonId)
      ? options.seasonId
      : (currentSeason?.id ?? ALLTIME_SEASON_ID);
  } else {
    targetSeasonId = scope === 'alltime' ? ALLTIME_SEASON_ID : (currentSeason?.id ?? ALLTIME_SEASON_ID);
  }

  const isAllTime = targetSeasonId === ALLTIME_SEASON_ID;
  // Inactivity rule (60 days) applies to the current-season leaderboard only;
  // past-season and all-time views show everyone.
  const applyInactivity = !isAllTime && targetSeasonId === currentSeason?.id;
  const seasonFilter = isAllTime ? '' : 'AND m.season_id = ?';
  // elo_before/elo_after hold the season ledger; alltime_* the never-resetting one
  const deltaExpr = isAllTime ? 'mp.alltime_elo_after - mp.alltime_elo_before' : 'mp.elo_after - mp.elo_before';

  const baseParams: (string | number)[] = isAllTime ? [gameId] : [gameId, targetSeasonId];

  // Get all match results for this game (in scope), calculating wins/losses/draws from scores
  const participations = db.prepare(`
    SELECT
      mp.player_id,
      mp.match_id,
      mp.team,
      mp.score,
      m.game_id
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
  `).all(...baseParams) as {
    player_id: number;
    match_id: number;
    team: number;
    score: number;
    game_id: number;
  }[];

  // Group by match and calculate outcomes
  const matchOutcomes: Map<number, { teams: Map<number, number> }> = new Map();

  for (const p of participations) {
    if (!matchOutcomes.has(p.match_id)) {
      matchOutcomes.set(p.match_id, { teams: new Map() });
    }
    matchOutcomes.get(p.match_id)!.teams.set(p.team, p.score);
  }

  // Calculate win/loss/draw for each player
  const playerStats: Map<number, { wins: number; losses: number; draws: number }> = new Map();

  for (const p of participations) {
    if (!playerStats.has(p.player_id)) {
      playerStats.set(p.player_id, { wins: 0, losses: 0, draws: 0 });
    }
    const stats = playerStats.get(p.player_id)!;
    const matchData = matchOutcomes.get(p.match_id)!;

    let opponentScore: number | null = null;
    for (const [team, score] of matchData.teams) {
      if (team !== p.team) {
        opponentScore = score;
        break;
      }
    }

    if (opponentScore !== null) {
      if (p.score > opponentScore) {
        stats.wins++;
      } else if (p.score < opponentScore) {
        stats.losses++;
      } else {
        stats.draws++;
      }
    }
  }

  // Get trend data (last 10 matches rating changes for each player, in scope)
  const trendRows = db.prepare(`
    SELECT
      mp.player_id,
      ${deltaExpr} as delta,
      m.played_at
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    ORDER BY m.played_at DESC, m.id DESC
  `).all(...(isAllTime ? [gameId] : [gameId, targetSeasonId])) as {
    player_id: number;
    delta: number;
    played_at: string;
  }[];

  // Group trend data by player, taking last 10 matches
  const playerTrends: Map<number, number[]> = new Map();
  const playerMatchCounts: Map<number, number> = new Map();

  for (const row of trendRows) {
    if (!playerTrends.has(row.player_id)) {
      playerTrends.set(row.player_id, []);
      playerMatchCounts.set(row.player_id, 0);
    }
    const trends = playerTrends.get(row.player_id)!;
    const count = playerMatchCounts.get(row.player_id)!;
    if (count < 10) {
      trends.unshift(row.delta);
      playerMatchCounts.set(row.player_id, count + 1);
    }
  }

  // Get base player data
  const statusFilter = includeRetired
    ? ''
    : " AND (p.status IS NULL OR p.status = 'active')";
  const rows = db.prepare(`
    SELECT
      pr.player_id,
      p.name as player_name,
      p.avatar_url,
      pr.elo,
      p.status
    FROM player_ratings pr
    JOIN players p ON pr.player_id = p.id
    WHERE pr.game_id = ? AND pr.season_id = ?${statusFilter}
    ORDER BY pr.elo DESC, p.name ASC
  `).all(gameId, targetSeasonId) as {
    player_id: number;
    player_name: string;
    avatar_url: string | null;
    elo: number;
    status: string | null;
  }[];

  // Get last match date per player for inactivity calculation
  const lastMatchRows = db.prepare(`
    SELECT
      mp.player_id,
      MAX(m.played_at) as last_match_at
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?
    GROUP BY mp.player_id
  `).all(gameId) as { player_id: number; last_match_at: string }[];

  const playerLastMatch: Map<number, string> = new Map();
  for (const row of lastMatchRows) {
    playerLastMatch.set(row.player_id, row.last_match_at);
  }

  // Read inactive threshold from settings
  const thresholdSetting = db.prepare(`SELECT value FROM settings WHERE key = 'inactive_threshold_days'`).get() as { value: string } | undefined;
  const inactiveThresholdDays = thresholdSetting ? parseInt(thresholdSetting.value, 10) : 60;
  const now = Date.now();

  let result = rows.map(row => {
    const stats = playerStats.get(row.player_id) || { wins: 0, losses: 0, draws: 0 };
    const trend = playerTrends.get(row.player_id) || [];
    const lastMatchAt = playerLastMatch.get(row.player_id);
    const isInactive = applyInactivity
      ? (lastMatchAt
        ? (now - new Date(lastMatchAt).getTime()) > inactiveThresholdDays * 24 * 60 * 60 * 1000
        : true) // No matches = inactive
      : false;

    return {
      player_id: row.player_id,
      player_name: row.player_name,
      avatar_url: row.avatar_url,
      elo: row.elo,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      status: (row.status === 'retired' ? 'retired' : 'active') as 'active' | 'retired',
      is_inactive: isInactive,
      last_match_at: lastMatchAt || undefined,
      trend,
    };
  });

  if (!includeInactive) {
    result = result.filter(entry => !entry.is_inactive);
  }

  return result;
}

export function getGameStats(gameId: number, options: { scope?: 'season' | 'alltime'; seasonId?: number } = {}): GameStats {
  const { scope = 'season' } = options;
  const currentSeason = getCurrentSeason();
  let targetSeasonId: number;
  if (options.seasonId !== undefined) {
    targetSeasonId = options.seasonId === ALLTIME_SEASON_ID || getSeason(options.seasonId)
      ? options.seasonId
      : (currentSeason?.id ?? ALLTIME_SEASON_ID);
  } else {
    targetSeasonId = scope === 'alltime' ? ALLTIME_SEASON_ID : (currentSeason?.id ?? ALLTIME_SEASON_ID);
  }
  const isAllTime = targetSeasonId === ALLTIME_SEASON_ID;
  const seasonFilter = isAllTime ? '' : 'AND m.season_id = ?';
  const baseParams: (string | number)[] = isAllTime ? [gameId] : [gameId, targetSeasonId];

  const matchesResult = db.prepare(`
    SELECT COUNT(DISTINCT m.id) as count
    FROM matches m
    WHERE m.game_id = ?${seasonFilter}
  `).get(...baseParams) as { count: number };

  const pointsResult = db.prepare(`
    SELECT mp.team, SUM(mp.score) as total_points
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    GROUP BY mp.team
  `).all(...baseParams) as { team: number; total_points: number }[];

  let team0Points = 0;
  let team1Points = 0;
  for (const row of pointsResult) {
    if (row.team === 0) team0Points = row.total_points;
    else if (row.team === 1) team1Points = row.total_points;
  }

  const activePlayersResult = db.prepare(`
    SELECT COUNT(DISTINCT pr.player_id) as count
    FROM player_ratings pr
    JOIN players p ON pr.player_id = p.id
    WHERE pr.game_id = ? AND pr.season_id = ? AND (p.status IS NULL OR p.status = 'active')
  `).get(gameId, targetSeasonId) as { count: number };

  const totalPlayersResult = db.prepare(`
    SELECT COUNT(DISTINCT pr.player_id) as count
    FROM player_ratings pr
    WHERE pr.game_id = ? AND pr.season_id = ?
  `).get(gameId, targetSeasonId) as { count: number };

  return {
    game_id: gameId,
    total_matches: matchesResult.count,
    team0_points: team0Points,
    team1_points: team1Points,
    active_players: activePlayersResult.count,
    total_players: totalPlayersResult.count,
  };
}

export interface GameRecordsOptions {
  scope?: 'season' | 'alltime';
  /** Explicit season id (takes precedence over scope). */
  seasonId?: number;
}

export function getGameRecords(gameId: number, options: GameRecordsOptions = {}): GameRecords {
  // Records are computed in the scope being viewed: for a season, every
  // query filters to that season's matches and uses its ledger's elo columns;
  // for all-time, matches run free and the continuous alltime ledger is used.
  const { scope = 'season' } = options;
  const currentSeasonRow = getCurrentSeason();
  let targetSeasonId: number;
  if (options.seasonId !== undefined) {
    targetSeasonId = options.seasonId === ALLTIME_SEASON_ID || getSeason(options.seasonId)
      ? options.seasonId
      : (currentSeasonRow?.id ?? ALLTIME_SEASON_ID);
  } else {
    targetSeasonId = scope === 'alltime' ? ALLTIME_SEASON_ID : (currentSeasonRow?.id ?? ALLTIME_SEASON_ID);
  }
  const isAllTime = targetSeasonId === ALLTIME_SEASON_ID;
  const seasonFilter = isAllTime ? '' : 'AND m.season_id = ?';
  const eloAfterCol = isAllTime ? 'mp.alltime_elo_after' : 'mp.elo_after';
  const eloDeltaExpr = isAllTime
    ? 'mp.alltime_elo_after - mp.alltime_elo_before'
    : 'mp.elo_after - mp.elo_before';
  const scopeParams = (base: (string | number)[]): (string | number)[] =>
    isAllTime ? base : [...base, targetSeasonId];

  const records: GameRecords = {
    highest_skill: null,
    lowest_skill: null,
    peak_skill_ever: null,
    trough_skill_ever: null,
    most_games: null,
    highest_win_rate: null,
    longest_win_streak: null,
    longest_lose_streak: null,
    longest_unbeaten_streak: null,
    biggest_skill_gain: null,
    biggest_skill_loss: null
  };

  // Highest skill in the viewed ledger (active players only)
  const highestSkill = db.prepare(`
    SELECT pr.player_id, p.name as player_name, pr.elo as value
    FROM player_ratings pr
    JOIN players p ON pr.player_id = p.id
    WHERE pr.game_id = ? AND pr.season_id = ?
      AND (p.status IS NULL OR p.status = 'active')
    ORDER BY pr.elo DESC, p.name ASC
    LIMIT 1
  `).get(gameId, targetSeasonId) as Record | undefined;
  records.highest_skill = highestSkill || null;

  // Lowest skill in the viewed ledger (active players with at least 5 in-scope games)
  const lowestSkill = db.prepare(`
    SELECT pr.player_id, p.name as player_name, pr.elo as value
    FROM player_ratings pr
    JOIN players p ON pr.player_id = p.id
    WHERE pr.game_id = ? AND pr.season_id = ?
      AND (p.status IS NULL OR p.status = 'active')
    AND (
      SELECT COUNT(*) FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = pr.player_id AND m.game_id = ?${seasonFilter}
    ) >= 5
    ORDER BY pr.elo ASC, p.name ASC
    LIMIT 1
  `).get(...scopeParams([gameId, targetSeasonId, gameId])) as Record | undefined;
  records.lowest_skill = lowestSkill || null;

  // Peak skill reached in the viewed ledger
  const peakSkillEver = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      ${eloAfterCol} as value,
      m.played_at as date
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    ORDER BY value DESC, p.name ASC
    LIMIT 1
  `).get(...scopeParams([gameId])) as Record | undefined;
  records.peak_skill_ever = peakSkillEver || null;

  // Trough skill in the viewed ledger (min 5 in-scope games at that point)
  const troughSkillEver = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      ${eloAfterCol} as value,
      m.played_at as date
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter} AND (
      SELECT COUNT(*) FROM match_participants mp2
      JOIN matches m2 ON mp2.match_id = m2.id
      WHERE mp2.player_id = mp.player_id AND m2.game_id = ?${seasonFilter.replace(/\bm\.season_id/g, 'm2.season_id')} AND m2.played_at <= m.played_at
    ) >= 5
    ORDER BY value ASC, p.name ASC
    LIMIT 1
  `).get(...(isAllTime ? [gameId, gameId] : [gameId, targetSeasonId, gameId, targetSeasonId])) as Record | undefined;
  records.trough_skill_ever = troughSkillEver || null;

  // Most games played (in scope)
  const mostGames = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      COUNT(*) as value
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    GROUP BY mp.player_id
    ORDER BY value DESC, p.name ASC
    LIMIT 1
  `).get(...scopeParams([gameId])) as Record | undefined;
  records.most_games = mostGames || null;

  // Highest win rate (min 20 games)
  const highestWinRate = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      CAST(SUM(CASE
        WHEN mp.score > (SELECT MAX(mp2.score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team)
        THEN 1 ELSE 0
      END) AS FLOAT) / COUNT(*) * 100 as value
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    GROUP BY mp.player_id
    HAVING COUNT(*) >= 20
    ORDER BY value DESC, p.name ASC
    LIMIT 1
  `).get(...scopeParams([gameId])) as Record | undefined;
  records.highest_win_rate = highestWinRate || null;

  // Calculate streaks - fetch all in-scope match data in a single query (avoiding N+1)
  const allMatchResults = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      m.played_at,
      mp.score,
      mp.team,
      m.id as match_id
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    ORDER BY m.played_at ASC, m.id ASC
  `).all(...scopeParams([gameId])) as { player_id: number; player_name: string; played_at: string; score: number; team: number; match_id: number }[];

  // Build a map of match_id -> team scores for quick lookup
  const matchTeamScores: Map<number, Map<number, number>> = new Map();
  for (const row of allMatchResults) {
    if (!matchTeamScores.has(row.match_id)) {
      matchTeamScores.set(row.match_id, new Map());
    }
    matchTeamScores.get(row.match_id)!.set(row.team, row.score);
  }

  // Group results by player
  const playerMatches: Map<number, { player_name: string; matches: { played_at: string; score: number; opponent_score: number }[] }> = new Map();
  for (const row of allMatchResults) {
    if (!playerMatches.has(row.player_id)) {
      playerMatches.set(row.player_id, { player_name: row.player_name, matches: [] });
    }
    const teamScores = matchTeamScores.get(row.match_id)!;
    let opponentScore = 0;
    for (const [team, score] of teamScores) {
      if (team !== row.team) {
        opponentScore = score;
        break;
      }
    }
    playerMatches.get(row.player_id)!.matches.push({
      played_at: row.played_at,
      score: row.score,
      opponent_score: opponentScore
    });
  }

  let longestWinStreak: { player_id: number; player_name: string; streak: number; start: string; end: string } | null = null;
  let longestLoseStreak: { player_id: number; player_name: string; streak: number; start: string; end: string } | null = null;
  let longestUnbeatenStreak: { player_id: number; player_name: string; streak: number; start: string; end: string } | null = null;

  for (const [player_id, data] of playerMatches) {
    let currentWinStreak = 0;
    let currentLoseStreak = 0;
    let currentUnbeatenStreak = 0;
    let winStreakStart: string | null = null;
    let loseStreakStart: string | null = null;
    let unbeatenStreakStart: string | null = null;

    for (const match of data.matches) {
      const isWin = match.score > match.opponent_score;
      const isLoss = match.score < match.opponent_score;

      if (isWin) {
        if (currentWinStreak === 0) winStreakStart = match.played_at;
        currentWinStreak++;
        currentLoseStreak = 0;
        if (currentWinStreak > (longestWinStreak?.streak || 0)) {
          longestWinStreak = {
            player_id,
            player_name: data.player_name,
            streak: currentWinStreak,
            start: winStreakStart!,
            end: match.played_at
          };
        }
      } else if (isLoss) {
        if (currentLoseStreak === 0) loseStreakStart = match.played_at;
        currentWinStreak = 0;
        currentLoseStreak++;
        if (currentLoseStreak > (longestLoseStreak?.streak || 0)) {
          longestLoseStreak = {
            player_id,
            player_name: data.player_name,
            streak: currentLoseStreak,
            start: loseStreakStart!,
            end: match.played_at
          };
        }
      } else {
        currentWinStreak = 0;
        currentLoseStreak = 0;
      }

      // Unbeaten (wins + draws, broken only by a loss) — counts EVERY
      // non-loss, not just draws: the record used to only advance on draws,
      // so a long WIN streak showed no unbeaten record at all (Oscar, 2026-10).
      if (isLoss) currentUnbeatenStreak = 0;
      else {
        if (currentUnbeatenStreak === 0) unbeatenStreakStart = match.played_at;
        currentUnbeatenStreak++;
        if (currentUnbeatenStreak > (longestUnbeatenStreak?.streak || 0)) {
          longestUnbeatenStreak = {
            player_id,
            player_name: data.player_name,
            streak: currentUnbeatenStreak,
            start: unbeatenStreakStart!,
            end: match.played_at
          };
        }
      }
    }
  }

  if (longestWinStreak) {
    records.longest_win_streak = {
      player_id: longestWinStreak.player_id,
      player_name: longestWinStreak.player_name,
      value: longestWinStreak.streak,
      date: longestWinStreak.start !== longestWinStreak.end
        ? `${longestWinStreak.start?.split(' ')[0]} - ${longestWinStreak.end?.split(' ')[0]}`
        : longestWinStreak.start?.split(' ')[0]
    };
  }

  if (longestLoseStreak) {
    records.longest_lose_streak = {
      player_id: longestLoseStreak.player_id,
      player_name: longestLoseStreak.player_name,
      value: longestLoseStreak.streak,
      date: longestLoseStreak.start !== longestLoseStreak.end
        ? `${longestLoseStreak.start?.split(' ')[0]} - ${longestLoseStreak.end?.split(' ')[0]}`
        : longestLoseStreak.start?.split(' ')[0]
    };
  }

  if (longestUnbeatenStreak) {
    records.longest_unbeaten_streak = {
      player_id: longestUnbeatenStreak.player_id,
      player_name: longestUnbeatenStreak.player_name,
      value: longestUnbeatenStreak.streak,
      date: longestUnbeatenStreak.start !== longestUnbeatenStreak.end
        ? `${longestUnbeatenStreak.start?.split(' ')[0]} - ${longestUnbeatenStreak.end?.split(' ')[0]}`
        : longestUnbeatenStreak.start?.split(' ')[0]
    };
  }

  // Biggest single game skill gain (viewed ledger)
  const biggestGain = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      ${eloDeltaExpr} as value,
      m.played_at as date
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    ORDER BY value DESC, p.name ASC
    LIMIT 1
  `).get(...scopeParams([gameId])) as Record | undefined;
  records.biggest_skill_gain = biggestGain || null;

  // Biggest single game skill loss (viewed ledger)
  const biggestLoss = db.prepare(`
    SELECT
      mp.player_id,
      p.name as player_name,
      -(${eloDeltaExpr}) as value,
      m.played_at as date
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?${seasonFilter}
    ORDER BY value DESC, p.name ASC
    LIMIT 1
  `).get(...scopeParams([gameId])) as Record | undefined;
  records.biggest_skill_loss = biggestLoss || null;

  return records;
}