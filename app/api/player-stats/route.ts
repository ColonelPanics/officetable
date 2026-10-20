import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { ALLTIME_SEASON_ID, resolveScopeSeasonId } from '@/lib/seasons';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get('player_id');

  if (!playerId) {
    return NextResponse.json({ error: 'player_id is required' }, { status: 400 });
  }

  // Season scoping: scope=season (default, current season) | alltime;
  // season_id selects a specific (past) season's ledger.
  const targetSeasonId = resolveScopeSeasonId(searchParams.get('scope'), searchParams.get('season_id'));
  const isAllTime = targetSeasonId === ALLTIME_SEASON_ID;
  const seasonFilter = isAllTime ? '' : 'AND m.season_id = ?';
  // elo_* columns hold the match's own season ledger; alltime_* the continuous one
  const eloAfterCol = isAllTime ? 'mp.alltime_elo_after' : 'mp.elo_after';
  const eloBeforeCol = isAllTime ? 'mp.alltime_elo_before' : 'mp.elo_before';
  const scopeParams = (gameParams: (string | number)[]) =>
    isAllTime ? gameParams : [...gameParams, targetSeasonId];

  // Get player info
  const playerStmt = db.prepare(`
    SELECT id, name, status, created_at, avatar_url FROM players WHERE id = ?
  `);
  const player = playerStmt.get(parseInt(playerId)) as { id: number; name: string; status: string; created_at: string };

  // Get first match date across all games
  const firstMatchStmt = db.prepare(`
    SELECT MIN(m.played_at) as first_played_at
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.player_id = ?
  `);
  const firstMatch = firstMatchStmt.get(parseInt(playerId)) as { first_played_at: string | null } | undefined;

  if (!player) {
    return NextResponse.json({ error: 'Player not found' }, { status: 404 });
  }

  // Get all games
  const gamesStmt = db.prepare(`SELECT id, name, score_type, score_value FROM games ORDER BY name`);
  const games = gamesStmt.all() as { id: number; name: string; score_type: string; score_value: number }[];

  // Get player's rating and stats for each game
  const gameStats = [];
  for (const game of games) {
  // Get player's rating for this game from the target ledger
  const ratingStmt = db.prepare(`
    SELECT elo FROM player_ratings WHERE player_id = ? AND game_id = ? AND season_id = ?
  `);
  const rating = ratingStmt.get(parseInt(playerId), game.id, targetSeasonId) as { elo: number } | undefined;

  if (isAllTime && !rating) continue; // Player hasn't played this game

  // Get match stats for this game (in scope)
  const statsStmt = db.prepare(`
    SELECT
      COUNT(*) as total_matches,
      SUM(CASE WHEN score > opponent_score THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN score < opponent_score THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN score = opponent_score THEN 1 ELSE 0 END) as draws,
      SUM(score) as points_scored,
      SUM(opponent_score) as points_conceded
    FROM (
      SELECT
        mp.score,
        mp.match_id,
        (SELECT MAX(score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team) as opponent_score
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ?${seasonFilter}
    )
  `);
  const stats = statsStmt.get(...scopeParams([parseInt(playerId), game.id])) as {
      total_matches: number;
      wins: number;
      losses: number;
      draws: number;
      points_scored: number;
      points_conceded: number;
    };

    // Chart history: scoped per ledger view
    //  - all-time: ONE continuous series (no breaks) of alltime ledger values
    //  - season: every season's season-ledger values, segmented with null
    //    break points so the flat resets are visible discontinuities
    // Stats/records below stay scoped to the target season (or all-time).
    const historyStmt = db.prepare(`
      SELECT ${eloAfterCol} as elo_after, m.played_at, m.season_id
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ?
      ORDER BY m.played_at ASC, m.id ASC
    `);
    const historyRows = historyStmt.all(parseInt(playerId), game.id) as {
      elo_after: number; played_at: string; season_id: number
    }[];

    const eloHistory: { elo_after: number; played_at: string }[] = [];
    if (isAllTime) {
      for (const row of historyRows) {
        eloHistory.push({ elo_after: row.elo_after, played_at: row.played_at });
      }
    } else {
      let lastHistorySeason: number | null = null;
      for (const row of historyRows) {
        if (lastHistorySeason !== null && row.season_id !== lastHistorySeason) {
          // Null point breaks the line so the flat reset is visible
          eloHistory.push({ elo_after: null as unknown as number, played_at: row.played_at });
        }
        eloHistory.push({ elo_after: row.elo_after, played_at: row.played_at });
        lastHistorySeason = row.season_id;
      }
    }

    // Record series: the in-scope slice of the same data (season rows only
    // for season scope; everything for all-time)
    const recordHistory = isAllTime
      ? eloHistory.filter(h => h.elo_after != null)
      : historyRows
          .filter(r => r.season_id === targetSeasonId)
          .map(r => ({ elo_after: r.elo_after, played_at: r.played_at }));

    // Calculate highest and lowest Elo (in-scope series + rating row)
    const currentElo = rating?.elo ?? 0;
    let highestElo = currentElo;
    let lowestElo = currentElo;
    for (const record of recordHistory) {
      if (record.elo_after > highestElo) highestElo = record.elo_after;
      if (record.elo_after < lowestElo) lowestElo = record.elo_after;
    }

    // Get match results in chronological order for streak calculation
    const matchResultsStmt = db.prepare(`
      SELECT
        mp.match_id,
        mp.score,
        (SELECT MAX(score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team) as opponent_score,
        m.played_at
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ?${seasonFilter}
      ORDER BY m.played_at ASC
    `);
    const matchResults = matchResultsStmt.all(...scopeParams([parseInt(playerId), game.id])) as {
      match_id: number;
      score: number;
      opponent_score: number;
      played_at: string;
    }[];

    // Calculate streaks with dates
    let longestWinStreak = 0;
    let longestLoseStreak = 0;
    let longestUnbeatenStreak = 0;
    let currentWinStreak = 0;
    let currentLoseStreak = 0;
    let currentUnbeatenStreak = 0;
    let winStreakStart = 0;
    let loseStreakStart = 0;
    let unbeatenStreakStart = 0;
    let longestWinStreakStart = 0;
    let longestWinStreakEnd = 0;
    let longestLoseStreakStart = 0;
    let longestLoseStreakEnd = 0;
    let longestUnbeatenStreakStart = 0;
    let longestUnbeatenStreakEnd = 0;
    /** Result letters in play order (W/L/D) — also feeds the current streak. */
    const resultLetters: string[] = [];

    for (let i = 0; i < matchResults.length; i++) {
      const match = matchResults[i];
      const result = match.score > match.opponent_score ? 'W'
        : match.score < match.opponent_score ? 'L' : 'D';
      resultLetters.push(result);

      if (result === 'W') {
        // Win
        if (currentWinStreak === 0) winStreakStart = i;
        currentWinStreak++;
        currentLoseStreak = 0;
        if (currentWinStreak > longestWinStreak) {
          longestWinStreak = currentWinStreak;
          longestWinStreakStart = winStreakStart;
          longestWinStreakEnd = i;
        }
      } else if (result === 'L') {
        // Loss
        if (currentLoseStreak === 0) loseStreakStart = i;
        currentWinStreak = 0;
        currentLoseStreak++;
        if (currentLoseStreak > longestLoseStreak) {
          longestLoseStreak = currentLoseStreak;
          longestLoseStreakStart = loseStreakStart;
          longestLoseStreakEnd = i;
        }
      } else {
        // Draw
        currentWinStreak = 0;
        currentLoseStreak = 0;
      }

      // Unbeaten: every non-loss extends the run, a loss resets it. The
      // record used to only ADVANCE on draws — a long WIN streak left the
      // unbeaten record untouched (Oscar's 6-win streak showed 1).
      if (result === 'L') {
        currentUnbeatenStreak = 0;
      } else {
        if (currentUnbeatenStreak === 0) unbeatenStreakStart = i;
        currentUnbeatenStreak++;
        if (currentUnbeatenStreak > longestUnbeatenStreak) {
          longestUnbeatenStreak = currentUnbeatenStreak;
          longestUnbeatenStreakStart = unbeatenStreakStart;
          longestUnbeatenStreakEnd = i;
        }
      }
    }

    // Current streak — the house 'W5'/'L2'/'D1' convention (same as
    // head-to-head): the last match's result and how many of it in a row.
    let currentStreak = '';
    if (resultLetters.length > 0) {
      const last = resultLetters[resultLetters.length - 1];
      let count = 1;
      for (let i = resultLetters.length - 2; i >= 0; i--) {
        if (resultLetters[i] !== last) break;
        count++;
      }
      currentStreak = `${last}${count}`;
    }

    // Find when highest and lowest Elo occurred
    let highestEloDate: string | null = null;
    let lowestEloDate: string | null = null;

    for (const record of recordHistory) {
      if (record.elo_after === highestElo) {
        highestEloDate = record.played_at;
      }
      if (record.elo_after === lowestElo) {
        lowestEloDate = record.played_at;
      }
    }

    // Find biggest Elo gain and loss from single matches (in the scope ledger)
    const biggestGainStmt = db.prepare(`
      SELECT
        mp.match_id,
        ${eloBeforeCol} as elo_before,
        ${eloAfterCol} as elo_after,
        ${eloAfterCol} - ${eloBeforeCol} as gain,
        mp.score,
        m.played_at
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ?${seasonFilter}
      ORDER BY gain DESC
      LIMIT 1
    `);
    const biggestGain = biggestGainStmt.get(...scopeParams([parseInt(playerId), game.id])) as {
      match_id: number;
      elo_before: number;
      elo_after: number;
      gain: number;
      score: number;
      played_at: string;
    } | undefined;

    const biggestLossStmt = db.prepare(`
      SELECT
        mp.match_id,
        ${eloBeforeCol} as elo_before,
        ${eloAfterCol} as elo_after,
        ${eloBeforeCol} - ${eloAfterCol} as loss,
        mp.score,
        m.played_at
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.game_id = ?${seasonFilter}
      ORDER BY loss DESC
      LIMIT 1
    `);
    const biggestLoss = biggestLossStmt.get(...scopeParams([parseInt(playerId), game.id])) as {
      match_id: number;
      elo_before: number;
      elo_after: number;
      loss: number;
      score: number;
      played_at: string;
    } | undefined;

    // Get opponent and teammate details for biggest gain/loss matches
    let biggestGainDetails = null;
    let biggestLossDetails = null;

    if (biggestGain) {
      const teamStmt = db.prepare(`
        SELECT team FROM match_participants WHERE match_id = ? AND player_id = ?
      `);
      const teamInfo = teamStmt.get(biggestGain.match_id, parseInt(playerId)) as { team: number } | undefined;

      const opponentsStmt = db.prepare(`
        SELECT p.name as player_name, mp.score
        FROM match_participants mp
        JOIN players p ON mp.player_id = p.id
        WHERE mp.match_id = ? AND mp.team != ?
      `);
      const opponents = opponentsStmt.all(biggestGain.match_id, teamInfo?.team ?? 0) as {
        player_name: string;
        score: number;
      }[];

      const teammatesStmt = db.prepare(`
        SELECT p.name as player_name
        FROM match_participants mp
        JOIN players p ON mp.player_id = p.id
        WHERE mp.match_id = ? AND mp.team = ? AND mp.player_id != ?
      `);
      const teammates = teammatesStmt.all(biggestGain.match_id, teamInfo?.team ?? 0, parseInt(playerId)) as {
        player_name: string;
      }[];

      biggestGainDetails = {
        gain: biggestGain.gain,
        date: biggestGain.played_at,
        score: biggestGain.score,
        opponent_score: opponents[0]?.score ?? 0,
        opponents: opponents.map(o => o.player_name),
        teammates: teammates.map(t => t.player_name)
      };
    }

    if (biggestLoss) {
      const teamStmt = db.prepare(`
        SELECT team FROM match_participants WHERE match_id = ? AND player_id = ?
      `);
      const teamInfo = teamStmt.get(biggestLoss.match_id, parseInt(playerId)) as { team: number } | undefined;

      const opponentsStmt = db.prepare(`
        SELECT p.name as player_name, mp.score
        FROM match_participants mp
        JOIN players p ON mp.player_id = p.id
        WHERE mp.match_id = ? AND mp.team != ?
      `);
      const opponents = opponentsStmt.all(biggestLoss.match_id, teamInfo?.team ?? 0) as {
        player_name: string;
        score: number;
      }[];

      const teammatesStmt = db.prepare(`
        SELECT p.name as player_name
        FROM match_participants mp
        JOIN players p ON mp.player_id = p.id
        WHERE mp.match_id = ? AND mp.team = ? AND mp.player_id != ?
      `);
      const teammates = teammatesStmt.all(biggestLoss.match_id, teamInfo?.team ?? 0, parseInt(playerId)) as {
        player_name: string;
      }[];

      biggestLossDetails = {
        loss: biggestLoss.loss,
        date: biggestLoss.played_at,
        score: biggestLoss.score,
        opponent_score: opponents[0]?.score ?? 0,
        opponents: opponents.map(o => o.player_name),
        teammates: teammates.map(t => t.player_name)
      };
    }

    // Get achievements for this game
    const achievementsStmt = db.prepare(`
      SELECT
        a.id as achievement_id,
        a.name as achievement_name,
        a.description as achievement_description,
        a.category as achievement_category,
        a.icon as achievement_icon,
        COUNT(*) as count,
        MIN(pa.earned_at) as first_earned_at
      FROM player_achievements pa
      JOIN achievements a ON pa.achievement_id = a.id
      WHERE pa.player_id = ? AND pa.game_id = ?${isAllTime ? '' : ' AND pa.season_id = ?'}
      GROUP BY a.id
      ORDER BY
        CASE a.category
          WHEN 'milestone' THEN 1
          WHEN 'ranking' THEN 2
          WHEN 'streak' THEN 3
          WHEN 'special' THEN 4
          WHEN 'time_based' THEN 5
          ELSE 6
        END,
        a.name
    `);
    const achievements = achievementsStmt.all(...scopeParams([parseInt(playerId), game.id])) as {
      achievement_id: number;
      achievement_name: string;
      achievement_description: string;
      achievement_category: string;
      achievement_icon: string | null;
      count: number;
      first_earned_at: string;
    }[];

    gameStats.push({
      game_id: game.id,
      game_name: game.name,
      score_type: game.score_type,
      score_value: game.score_value,
      elo: currentElo,
      ...stats,
      current_streak: currentStreak,
      records: {
        highest_elo: highestElo,
        highest_elo_date: highestEloDate,
        lowest_elo: lowestElo,
        lowest_elo_date: lowestEloDate,
        longest_win_streak: longestWinStreak,
        longest_win_streak_start: matchResults[longestWinStreakStart]?.played_at ?? null,
        longest_win_streak_end: matchResults[longestWinStreakEnd]?.played_at ?? null,
        longest_lose_streak: longestLoseStreak,
        longest_lose_streak_start: matchResults[longestLoseStreakStart]?.played_at ?? null,
        longest_lose_streak_end: matchResults[longestLoseStreakEnd]?.played_at ?? null,
        longest_unbeaten_streak: longestUnbeatenStreak,
        longest_unbeaten_streak_start: matchResults[longestUnbeatenStreakStart]?.played_at ?? null,
        longest_unbeaten_streak_end: matchResults[longestUnbeatenStreakEnd]?.played_at ?? null,
        biggest_gain: biggestGainDetails,
        biggest_loss: biggestLossDetails,
      },
      elo_history: eloHistory.map(h => ({
        elo: h.elo_after as number | null,
        date: h.played_at
      })),
      achievements
    });
  }

  // Sort by ELO descending
  gameStats.sort((a, b) => b.elo - a.elo);

  // Get recent matches (across all games)
  const recentMatchesStmt = db.prepare(`
    SELECT
      m.id,
      m.game_id,
      m.played_at,
      m.notes,
      g.name as game_name,
      mp.team,
      mp.score,
      ${eloBeforeCol} as elo_before,
      ${eloAfterCol} as elo_after
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    JOIN games g ON m.game_id = g.id
    WHERE mp.player_id = ?${seasonFilter}
    ORDER BY m.played_at DESC
    LIMIT 20
  `);
  const recentMatches = recentMatchesStmt.all(...scopeParams([parseInt(playerId)])) as {
    id: number;
    game_id: number;
    played_at: string;
    notes: string | null;
    game_name: string;
    team: number;
    score: number;
    elo_before: number;
    elo_after: number;
  }[];

  // For each match, get the opponent info (players on different teams) and teammates
  const matchesWithOpponents = recentMatches.map(match => {
    const opponentsStmt = db.prepare(`
      SELECT p.name as player_name, mp.score, mp.team
      FROM match_participants mp
      JOIN players p ON mp.player_id = p.id
      WHERE mp.match_id = ? AND mp.team != ?
    `);
    const opponents = opponentsStmt.all(match.id, match.team) as {
      player_name: string;
      score: number;
      team: number;
    }[];

    const teammatesStmt = db.prepare(`
      SELECT p.name as player_name
      FROM match_participants mp
      JOIN players p ON mp.player_id = p.id
      WHERE mp.match_id = ? AND mp.team = ? AND mp.player_id != ?
    `);
    const teammates = teammatesStmt.all(match.id, match.team, parseInt(playerId)) as {
      player_name: string;
    }[];

    // Determine result - opponent score is the score of the opposing team(s)
    // For multi-team games, use the max opponent score to determine win/loss
    const opponentScore = opponents.length > 0
      ? Math.max(...opponents.map(o => o.score))
      : 0;
    let result: 'win' | 'loss' | 'draw';
    if (match.score > opponentScore) result = 'win';
    else if (match.score < opponentScore) result = 'loss';
    else result = 'draw';

    return {
      ...match,
      opponents,
      teammates: teammates.map(t => t.player_name),
      opponent_score: opponentScore,
      result
    };
  });

  // Calculate overall stats
  const overallStats = {
    total_matches: gameStats.reduce((sum, g) => sum + g.total_matches, 0),
    total_wins: gameStats.reduce((sum, g) => sum + g.wins, 0),
    total_losses: gameStats.reduce((sum, g) => sum + g.losses, 0),
    total_draws: gameStats.reduce((sum, g) => sum + g.draws, 0),
    total_points_scored: gameStats.reduce((sum, g) => sum + g.points_scored, 0),
    total_points_conceded: gameStats.reduce((sum, g) => sum + g.points_conceded, 0)
  };

  // Get all achievement definitions for computing locked vs unlocked
  const allAchievements = db.prepare(`
    SELECT id, name, description, category, icon
    FROM achievements
    ORDER BY
      CASE category
        WHEN 'milestone' THEN 1
        WHEN 'ranking' THEN 2
        WHEN 'streak' THEN 3
        WHEN 'special' THEN 4
        WHEN 'time_based' THEN 5
        ELSE 6
      END, name
  `).all() as { id: number; name: string; description: string; category: string; icon: string | null }[];

  return NextResponse.json({
    player: {
      ...player,
      first_played_at: firstMatch?.first_played_at ?? null,
    },
    overallStats,
    gameStats,
    recentMatches: matchesWithOpponents,
    allAchievements
  });
}