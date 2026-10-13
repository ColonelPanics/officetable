import db from './db';
import type { PlayerRating, LeaderboardEntry, CreateMatchInput } from './types';
import { checkAchievements, saveAchievements, deleteAchievementsForMatch, deleteAchievementsForMatches } from './achievements';
import { resolveSeason, ALLTIME_SEASON_ID } from './seasons';

// Elo constants
const DEFAULT_ELO = 0;
const K_FACTOR = 25;

// For team games, we use the SUM of team Elo (not the average)
// This supports "unfair" line-ups (e.g. 1v2)

/**
 * Get (or create) a player's rating row for a given ledger.
 * seasonId 0 = the all-time ledger (never resets); a real season id =
 * that season's ledger, which flat-resets to DEFAULT_ELO (0) at season start.
 * New players seed 0 in BOTH ledgers.
 */
export function getOrCreatePlayerRating(playerId: number, gameId: number, seasonId: number): PlayerRating {
  const select = db.prepare(`
    SELECT * FROM player_ratings WHERE player_id = ? AND game_id = ? AND season_id = ?
  `);
  const existing = select.get(playerId, gameId, seasonId) as PlayerRating | undefined;
  if (existing) return existing;

  const upsert = db.prepare(`
    INSERT INTO player_ratings (player_id, game_id, season_id, elo)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, game_id, season_id) DO UPDATE SET elo = elo
  `);
  upsert.run(playerId, gameId, seasonId, DEFAULT_ELO);
  return select.get(playerId, gameId, seasonId) as PlayerRating;
}

/**
 * Persist a rating value to a ledger row (insert or update).
 */
function savePlayerRating(playerId: number, gameId: number, seasonId: number, elo: number): void {
  db.prepare(`
    INSERT INTO player_ratings (player_id, game_id, season_id, elo)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, game_id, season_id) DO UPDATE SET elo = excluded.elo
  `).run(playerId, gameId, seasonId, elo);
}

export function getLeaderboard(gameId: number, seasonId: number = ALLTIME_SEASON_ID): LeaderboardEntry[] {
  const stmt = db.prepare(`
    SELECT
      pr.player_id,
      p.name as player_name,
      pr.elo,
      COALESCE(wins.count, 0) as wins,
      COALESCE(losses.count, 0) as losses,
      COALESCE(draws.count, 0) as draws
    FROM player_ratings pr
    JOIN players p ON pr.player_id = p.id
    LEFT JOIN (
      SELECT mp.player_id, COUNT(*) as count
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE m.season_id = ?
        AND mp.score > 0 AND mp.score > (
        SELECT MAX(score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team
      )
      GROUP BY mp.player_id
    ) wins ON wins.player_id = pr.player_id
    LEFT JOIN (
      SELECT mp.player_id, COUNT(*) as count
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE m.season_id = ?
        AND mp.score >= 0 AND mp.score < (
        SELECT MAX(score) FROM match_participants mp2 WHERE mp2.match_id = mp.match_id AND mp2.team != mp.team
      )
      GROUP BY mp.player_id
    ) losses ON losses.player_id = pr.player_id
    LEFT JOIN (
      SELECT mp.player_id, COUNT(*) as count
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE m.season_id = ?
        AND EXISTS (
        SELECT 1 FROM match_participants mp2
        WHERE mp2.match_id = mp.match_id
        AND mp2.team != mp.team
        AND mp2.score = mp.score
      )
      GROUP BY mp.player_id
    ) draws ON draws.player_id = pr.player_id
    WHERE pr.game_id = ? AND pr.season_id = ?
    ORDER BY pr.elo DESC, p.name ASC
  `);
  return stmt.all(seasonId, seasonId, seasonId, gameId, seasonId) as LeaderboardEntry[];
}

/**
 * Calculate expected score for player A against player B.
 * Returns a value between 0 and 1 representing the probability of A winning.
 */
function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 180));
}

/**
 * Calculate effective Elo for a team.
 * We sum the team so "unfair" line-ups (e.g. 1v2) work.
 */
function averageTeamElo(ratings: number[]): number {
  if (ratings.length === 0) return DEFAULT_ELO;
  return ratings.reduce((sum, r) => sum + r, 0);
}

/**
 * Calculate point ratio for each team.
 */
function getPointRatios(teams: CreateMatchInput['teams']): number[] {
  const totalScore = teams.reduce((sum, t) => sum + t.score, 0);
  if (totalScore === 0) {
    // If no points scored, distribute equally
    return teams.map(() => 1 / teams.length);
  }
  return teams.map(t => t.score / totalScore);
}

/**
 * Compute the rating change for each team from a single ledger's ratings.
 * Each ledger (season / all-time) computes its deltas independently from its
 * own seeded ratings — deltas are NEVER shared between ledgers.
 */
function computeTeamRatingChanges(
  teams: CreateMatchInput['teams'],
  ratingsByPlayer: Map<number, number>,
  results: number[]
): number[] {
  const teamAverageElos = teams.map(team =>
    averageTeamElo(team.player_ids.map(id => ratingsByPlayer.get(id) ?? DEFAULT_ELO))
  );

  const ratingChanges: number[] = [];
  for (let i = 0; i < teams.length; i++) {
    let opponentElo: number;
    if (teams.length === 2) {
      opponentElo = teamAverageElos[1 - i];
    } else {
      // Multi-team: use average of all other teams
      const otherElos = teamAverageElos.filter((_, j) => j !== i);
      opponentElo = averageTeamElo(otherElos);
    }

    const expected = expectedScore(teamAverageElos[i], opponentElo);
    const actual = results[i];
    ratingChanges.push(K_FACTOR * (actual - expected));
  }
  return ratingChanges;
}

export interface ProcessedMatch {
  matchId: number;
  /** Season-ledger skill changes (the live competition). */
  skillChanges: Map<number, { before: number; after: number; change: number }>;
  /** All-time-leader skill changes. */
  skillChangesAllTime: Map<number, { before: number; after: number; change: number }>;
  /** Season the match was assigned to (resolved from played_at). */
  seasonId: number;
}

/**
 * Process a match into BOTH ledgers:
 *  - Season ledger: seeded from that season's ratings (0 at season start).
 *  - All-time ledger: seeded from continuous all-time ratings.
 * Expected-score inputs come from each ledger's own ratings.
 * `elo_before/elo_after` on participants = the match's own SEASON ledger;
 * `alltime_elo_before/after` = the never-resetting all-time ledger.
 */
export function processMatch(input: CreateMatchInput, matchTimestamp?: Date): ProcessedMatch {
  const { game_id, notes, teams } = input;
  const matchDate = matchTimestamp || new Date();
  // Season is resolved from played_at, not insert date — late-entered
  // matches slot into the correct season.
  const seasonId = resolveSeason(matchDate);

  // Seed both ledgers for every player
  const seasonRatingsByPlayer: Map<number, number> = new Map();
  const alltimeRatingsByPlayer: Map<number, number> = new Map();

  for (const team of teams) {
    for (const playerId of team.player_ids) {
      seasonRatingsByPlayer.set(playerId, getOrCreatePlayerRating(playerId, game_id, seasonId).elo);
      alltimeRatingsByPlayer.set(playerId, getOrCreatePlayerRating(playerId, game_id, ALLTIME_SEASON_ID).elo);
    }
  }

  // Get point ratios (team_score / total_score)
  const results = getPointRatios(teams);

  // Calculate rating changes independently per ledger
  const seasonRatingChanges = computeTeamRatingChanges(teams, seasonRatingsByPlayer, results);
  const alltimeRatingChanges = computeTeamRatingChanges(teams, alltimeRatingsByPlayer, results);

  const insertMatch = db.prepare(`
    INSERT INTO matches (game_id, notes, played_at, season_id) VALUES (?, ?, ?, ?)
  `);

  const insertParticipant = db.prepare(`
    INSERT INTO match_participants (match_id, player_id, team, score, elo_before, elo_after, alltime_elo_before, alltime_elo_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Store skill changes for return
  const skillChanges: Map<number, { before: number; after: number; change: number }> = new Map();
  const skillChangesAllTime: Map<number, { before: number; after: number; change: number }> = new Map();

  // Use transaction for atomicity
  let matchId: number = 0;

  const updateRatings = db.transaction(() => {
    // Create match record with timestamp
    const playedAt = matchDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const matchResult = insertMatch.run(game_id, notes || null, playedAt, seasonId);
    matchId = matchResult.lastInsertRowid as number;

    // Update each team's players in both ledgers
    for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
      const team = teams[teamIndex];
      const change = seasonRatingChanges[teamIndex];
      const alltimeChange = alltimeRatingChanges[teamIndex];

      for (const playerId of team.player_ids) {
        const seasonBefore = seasonRatingsByPlayer.get(playerId)!;
        const seasonAfter = seasonBefore + change;
        const alltimeBefore = alltimeRatingsByPlayer.get(playerId)!;
        const alltimeAfter = alltimeBefore + alltimeChange;

        savePlayerRating(playerId, game_id, seasonId, seasonAfter);
        savePlayerRating(playerId, game_id, ALLTIME_SEASON_ID, alltimeAfter);

        insertParticipant.run(
          matchId,
          playerId,
          team.team,
          team.score,
          seasonBefore,
          seasonAfter,
          alltimeBefore,
          alltimeAfter
        );

        skillChanges.set(playerId, { before: seasonBefore, after: seasonAfter, change });
        skillChangesAllTime.set(playerId, { before: alltimeBefore, after: alltimeAfter, change: alltimeChange });
      }
    }
  });

  updateRatings();

  // Check and save achievements (scoped to the match's own season)
  const participants = teams.flatMap(team =>
    team.player_ids.map(playerId => ({
      player_id: playerId,
      team: team.team,
      score: team.score,
      elo_before: skillChanges.get(playerId)?.before ?? 0,
      elo_after: skillChanges.get(playerId)?.after ?? 0
    }))
  );

  const achievementResults = checkAchievements({
    matchId,
    gameId: game_id,
    seasonId,
    playedAt: matchDate,
    teams,
    participants,
    playerNameMap: new Map() // Will be populated by caller if needed
  });

  if (achievementResults.length > 0) {
    saveAchievements(achievementResults, game_id, seasonId);
  }

  return { matchId, skillChanges, skillChangesAllTime, seasonId };
}

// ---------------------------------------------------------------------------
// Replay machinery (used by correctMatch / deleteMatchAndReplay)
// ---------------------------------------------------------------------------

interface ReplayableMatch {
  /** Original match id (so old->new ids can be mapped for achievement re-checks). */
  matchId: number;
  teams: { team: number; player_ids: number[]; score: number }[];
  /** Original played_at string (preserved verbatim). */
  timestamp: string;
  notes: string | null;
}

/**
 * Preserve the original timestamp string exactly to avoid timezone drift.
 */
function normalisePlayedAt(ts: string): string {
  return ts.replace('T', ' ').replace(/\.\d+Z$/, '').substring(0, 19);
}

/**
 * Parse a stored 'YYYY-MM-DD HH:MM:SS' datetime (UTC) as a Date.
 */
function parseDbDate(ts: string): Date {
  const s = ts.replace('T', ' ');
  return new Date(s.length === 19 ? `${s}Z` : s);
}

/**
 * Seed an in-memory ratings map for replaying matches after a given point.
 * Takes each player's most recent rating BEFORE the anchor point:
 *  - season ledger: only matches in that same season count (a boundary
 *    resets to 0, so anchors from earlier seasons yield DEFAULT_ELO);
 *  - all-time ledger (seasonId === 0): any match before the anchor.
 * Rows with the same played_at are ordered by id, matching replay order.
 */
function seedRatingsBefore(
  gameId: number,
  anchorTimestamp: string,
  anchorMatchId: number,
  playerIds: Iterable<number>,
  seasonId: number
): Map<number, number> {
  const valueCol = seasonId === ALLTIME_SEASON_ID ? 'mp.alltime_elo_after' : 'mp.elo_after';
  const seasonFilter = seasonId === ALLTIME_SEASON_ID ? '' : 'AND m.season_id = ?';

  const ids = [...playerIds];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');

  const params: (string | number)[] = [
    gameId,
    ...ids,
    anchorTimestamp,
    anchorTimestamp,
    anchorMatchId,
  ];
  if (seasonId !== ALLTIME_SEASON_ID) params.push(seasonId);

  const rows = db.prepare(`
    SELECT mp.player_id, ${valueCol} as value
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE m.game_id = ?
      AND mp.player_id IN (${placeholders})
      AND (m.played_at < ? OR (m.played_at = ? AND m.id < ?))
      ${seasonFilter}
    ORDER BY m.played_at DESC, m.id DESC
  `).all(...params) as { player_id: number; value: number | null }[];

  const seed = new Map<number, number>();
  for (const row of rows) {
    if (!seed.has(row.player_id)) {
      seed.set(row.player_id, row.value ?? DEFAULT_ELO);
    }
  }
  for (const pid of ids) {
    if (!seed.has(pid)) seed.set(pid, DEFAULT_ELO);
  }
  return seed;
}

/**
 * Re-check achievements for replayed matches (each scoped to its own season).
 */
interface ReplayContext {
  gameId: number;
  matchesToReplay: ReplayableMatch[];
  seasonSeed: Map<number, number>;
  alltimeSeed: Map<number, number>;
  /** Season the seed ratings belong to (season of the anchor match). */
  seedSeason: number;
}

/**
 * Core dual-ledger replay: replays matches through BOTH ledgers in order.
 *  - All-time ledger replays straight through with no resets.
 *  - Season ledger resolves each match's season from its timestamp; when the
 *    replay crosses into a new season, every in-memory rating resets to 0.
 * Per-match ledger rows are written as we go, so every season's ratings end
 * up consistent (including seasons the replay passes through and closes).
 * Returns the old->new match id map for achievement re-checks.
 */
function replayCore(ctx: ReplayContext): Map<number, number> {
  const { gameId, matchesToReplay, seasonSeed, alltimeSeed, seedSeason } = ctx;

  const oldToNewMatchIds: Map<number, number> = new Map();

  const deleteParticipantsForMatch = db.prepare(`DELETE FROM match_participants WHERE match_id = ?`);
  const deleteMatch = db.prepare(`DELETE FROM matches WHERE id = ?`);
  const insertMatch = db.prepare(`
    INSERT INTO matches (game_id, notes, played_at, season_id) VALUES (?, ?, ?, ?)
  `);
  const insertParticipant = db.prepare(`
    INSERT INTO match_participants (match_id, player_id, team, score, elo_before, elo_after, alltime_elo_before, alltime_elo_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seasonMap: Map<number, number> = new Map(seasonSeed);
  const alltimeMap: Map<number, number> = new Map(alltimeSeed);
  let currentReplaySeason: number = seedSeason;

  const run = db.transaction(() => {
    // Remove the replayed matches (they get re-created with fresh deltas)
    for (const m of matchesToReplay) {
      deleteParticipantsForMatch.run(m.matchId);
      deleteMatch.run(m.matchId);
    }

    for (const matchData of matchesToReplay) {
      const matchSeason = resolveSeason(matchData.timestamp);

      if (matchSeason !== currentReplaySeason) {
        // Crossing a season boundary: flat reset of the SEASON ledger only.
        for (const pid of seasonMap.keys()) {
          seasonMap.set(pid, DEFAULT_ELO);
        }
        currentReplaySeason = matchSeason;
      }

      // Read each ledger's current ratings for the participants
      const seasonRatingsByPlayer = new Map<number, number>();
      const alltimeRatingsByPlayer = new Map<number, number>();
      for (const team of matchData.teams) {
        for (const playerId of team.player_ids) {
          seasonRatingsByPlayer.set(playerId, seasonMap.get(playerId) ?? DEFAULT_ELO);
          alltimeRatingsByPlayer.set(playerId, alltimeMap.get(playerId) ?? DEFAULT_ELO);
        }
      }

      const totalScore = matchData.teams.reduce((sum, t) => sum + t.score, 0);
      const results = totalScore === 0
        ? matchData.teams.map(() => 1 / matchData.teams.length)
        : matchData.teams.map(t => t.score / totalScore);

      // Independent deltas per ledger
      const seasonChanges = computeTeamRatingChanges(matchData.teams, seasonRatingsByPlayer, results);
      const alltimeChanges = computeTeamRatingChanges(matchData.teams, alltimeRatingsByPlayer, results);

      const playedAt = normalisePlayedAt(matchData.timestamp);
      const result = insertMatch.run(gameId, matchData.notes ?? null, playedAt, matchSeason);
      const newMatchId = result.lastInsertRowid as number;
      oldToNewMatchIds.set(matchData.matchId, newMatchId);

      const seen = new Set<number>();
      for (let teamIndex = 0; teamIndex < matchData.teams.length; teamIndex++) {
        const team = matchData.teams[teamIndex];
        const seasonChange = seasonChanges[teamIndex];
        const alltimeChange = alltimeChanges[teamIndex];

        for (const playerId of team.player_ids) {
          if (seen.has(playerId)) continue; // same player listed on two teams guard
          seen.add(playerId);

          const seasonBefore = seasonRatingsByPlayer.get(playerId)!;
          const seasonAfter = seasonBefore + seasonChange;
          const alltimeBefore = alltimeRatingsByPlayer.get(playerId)!;
          const alltimeAfter = alltimeBefore + alltimeChange;

          seasonMap.set(playerId, seasonAfter);
          alltimeMap.set(playerId, alltimeAfter);

          savePlayerRating(playerId, gameId, matchSeason, seasonAfter);
          savePlayerRating(playerId, gameId, ALLTIME_SEASON_ID, alltimeAfter);

          insertParticipant.run(
            newMatchId,
            playerId,
            team.team,
            team.score,
            seasonBefore,
            seasonAfter,
            alltimeBefore,
            alltimeAfter
          );
        }
      }
    }
  });

  run();

  return oldToNewMatchIds;
}

/**
 * Re-check achievements for replayed matches (each scoped to its own season).
 */
function recheckAchievementsForReplay(
  gameId: number,
  matchesToReplay: ReplayableMatch[],
  oldToNewMatchIds: Map<number, number>
): void {
  for (const matchData of matchesToReplay) {
    const newMatchId = oldToNewMatchIds.get(matchData.matchId);
    if (!newMatchId) continue;

    const participants = db.prepare(`
      SELECT player_id, team, score, elo_before, elo_after
      FROM match_participants WHERE match_id = ?
    `).all(newMatchId) as { player_id: number; team: number; score: number; elo_before: number; elo_after: number }[];

    const playedAt = parseDbDate(normalisePlayedAt(matchData.timestamp));
    const seasonId = resolveSeason(matchData.timestamp);

    const achievementResults = checkAchievements({
      matchId: newMatchId,
      gameId,
      seasonId,
      playedAt,
      teams: matchData.teams,
      participants,
      playerNameMap: new Map()
    });

    if (achievementResults.length > 0) {
      saveAchievements(achievementResults, gameId, seasonId);
    }
  }
}

/**
 * Correct a match result and replay all subsequent matches through both
 * ledgers. Ratings are recalculated from the corrected match forward.
 * Returns the old→new match id map: correcting DELETES and re-creates match
 * rows (fresh ids), so callers that link other tables by match_id must
 * re-point them.
 */
export function correctMatch(
  matchId: number,
  newTeams: { team: number; player_ids: number[]; score: number }[]
): Map<number, number> {
  const originalMatch = db.prepare(`
    SELECT * FROM matches WHERE id = ?
  `).get(matchId) as { id: number; game_id: number; played_at: string; notes: string | null; season_id: number } | undefined;

  if (!originalMatch) {
    throw new Error('Match not found');
  }

  const gameId = originalMatch.game_id;
  const anchorTimestamp = originalMatch.played_at;
  const anchorSeason = resolveSeason(anchorTimestamp);

  // All matches for this game from the correction point forward,
  // in deterministic chronological order.
  const matchesFromAnchor = db.prepare(`
    SELECT id, played_at, notes FROM matches
    WHERE game_id = ? AND (played_at > ? OR (played_at = ? AND id >= ?))
    ORDER BY played_at ASC, id ASC
  `).all(gameId, anchorTimestamp, anchorTimestamp, matchId) as { id: number; played_at: string; notes: string | null }[];

  // Collect all players involved in the replay + the new line-up
  const playerIds = new Set<number>();
  const getMatchPlayersStmt = db.prepare(`SELECT DISTINCT player_id FROM match_participants WHERE match_id = ?`);
  for (const m of matchesFromAnchor) {
    for (const p of getMatchPlayersStmt.all(m.id) as { player_id: number }[]) {
      playerIds.add(p.player_id);
    }
  }
  for (const team of newTeams) {
    for (const pid of team.player_ids) {
      playerIds.add(pid);
    }
  }

  // Build the replay list: the corrected match first, then the originals
  const matchesToReplay: ReplayableMatch[] = [];
  matchesToReplay.push({
    matchId,
    teams: newTeams,
    timestamp: anchorTimestamp,
    notes: originalMatch.notes
  });

  const getParticipantsStmt = db.prepare(`
    SELECT player_id, team, score FROM match_participants WHERE match_id = ?
  `);

  for (const m of matchesFromAnchor) {
    if (m.id === matchId) continue;

    const participants = getParticipantsStmt.all(m.id) as { player_id: number; team: number; score: number }[];
    const teams: { team: number; player_ids: number[]; score: number }[] = [];
    for (const p of participants) {
      let team = teams.find(t => t.team === p.team);
      if (!team) {
        team = { team: p.team, player_ids: [], score: p.score };
        teams.push(team);
      }
      team.player_ids.push(p.player_id);
    }

    matchesToReplay.push({
      matchId: m.id,
      teams,
      timestamp: m.played_at,
      notes: m.notes
    });
  }

  // Delete achievements for all matches being replayed
  deleteAchievementsForMatches(matchesToReplay.map(m => m.matchId));

  // Seed both ledgers from just before the correction point
  const seasonSeed = seedRatingsBefore(gameId, anchorTimestamp, matchId, playerIds, anchorSeason);
  const alltimeSeed = seedRatingsBefore(gameId, anchorTimestamp, matchId, playerIds, ALLTIME_SEASON_ID);

  const oldToNewMatchIds = replayCore({
    gameId,
    matchesToReplay,
    seasonSeed,
    alltimeSeed,
    seedSeason: anchorSeason
  });

  // Re-check achievements for all replayed matches
  recheckAchievementsForReplay(gameId, matchesToReplay, oldToNewMatchIds);

  // Mark the corrected match as edited
  const correctedMatchNewId = oldToNewMatchIds.get(matchId);
  if (correctedMatchNewId) {
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(`UPDATE matches SET is_edited = 1, edited_at = ? WHERE id = ?`).run(now, correctedMatchNewId);
  }
  return oldToNewMatchIds;
}

/**
 * Check if a match is within the edit window (24 hours).
 */
export function isWithinEditWindow(playedAt: string): boolean {
  const matchTime = parseDbDate(playedAt);
  const now = new Date();
  const hoursSince = (now.getTime() - matchTime.getTime()) / (1000 * 60 * 60);
  return hoursSince <= 24;
}

/**
 * Delete a match and replay all subsequent matches through both ledgers.
 */
export function deleteMatchAndReplay(matchId: number): void {
  const matchToDelete = db.prepare(`SELECT * FROM matches WHERE id = ?`)
    .get(matchId) as { id: number; game_id: number; played_at: string; notes: string | null; season_id: number } | undefined;

  if (!matchToDelete) {
    throw new Error('Match not found');
  }

  const gameId = matchToDelete.game_id;
  const anchorTimestamp = matchToDelete.played_at;
  const anchorSeason = resolveSeason(anchorTimestamp);

  // Subsequent matches in deterministic chronological order
  const subsequentMatches = db.prepare(`
    SELECT id, played_at, notes FROM matches
    WHERE game_id = ? AND (played_at > ? OR (played_at = ? AND id > ?))
    ORDER BY played_at ASC, id ASC
  `).all(gameId, anchorTimestamp, anchorTimestamp, matchId) as { id: number; played_at: string; notes: string | null }[];

  // Fast path: nothing to replay — just reverse this match's deltas in both ledgers.
  if (subsequentMatches.length === 0) {
    const participants = db.prepare(`
      SELECT player_id, elo_before, elo_after, alltime_elo_before, alltime_elo_after
      FROM match_participants WHERE match_id = ?
    `).all(matchId) as { player_id: number; elo_before: number; elo_after: number; alltime_elo_before: number; alltime_elo_after: number }[];

    deleteAchievementsForMatch(matchId);

    const deleteTransaction = db.transaction(() => {
      for (const p of participants) {
        // Season ledger: restore the anchor season's rating (elo_before is
        // the pre-match value of the match's own season ledger)
        savePlayerRating(p.player_id, gameId, matchToDelete.season_id || anchorSeason, p.elo_before);
        // All-time ledger: continuous, restore directly
        savePlayerRating(p.player_id, gameId, ALLTIME_SEASON_ID, p.alltime_elo_before);
      }
      db.prepare(`DELETE FROM match_participants WHERE match_id = ?`).run(matchId);
      db.prepare(`DELETE FROM matches WHERE id = ?`).run(matchId);
    });

    deleteTransaction();
    return;
  }

  // Collect players involved in subsequent matches
  const playerIds = new Set<number>();
  for (const m of subsequentMatches) {
    const participants = db.prepare(`SELECT DISTINCT player_id FROM match_participants WHERE match_id = ?`).all(m.id) as { player_id: number }[];
    for (const p of participants) {
      playerIds.add(p.player_id);
    }
  }

  // Collect subsequent matches to replay
  const matchesToReplay: ReplayableMatch[] = [];
  const getParticipantsStmt = db.prepare(`SELECT player_id, team, score FROM match_participants WHERE match_id = ?`);

  for (const m of subsequentMatches) {
    const participants = getParticipantsStmt.all(m.id) as { player_id: number; team: number; score: number }[];
    const teams: { team: number; player_ids: number[]; score: number }[] = [];
    for (const p of participants) {
      let team = teams.find(t => t.team === p.team);
      if (!team) {
        team = { team: p.team, player_ids: [], score: p.score };
        teams.push(team);
      }
      team.player_ids.push(p.player_id);
    }

    matchesToReplay.push({
      matchId: m.id,
      teams,
      timestamp: m.played_at,
      notes: m.notes
    });
  }

  // Delete achievements for the match being deleted and all subsequent matches
  deleteAchievementsForMatch(matchId);
  deleteAchievementsForMatches(matchesToReplay.map(m => m.matchId));

  // Seed both ledgers from just before the deleted match
  const seasonSeed = seedRatingsBefore(gameId, anchorTimestamp, matchId, playerIds, anchorSeason);
  const alltimeSeed = seedRatingsBefore(gameId, anchorTimestamp, matchId, playerIds, ALLTIME_SEASON_ID);

  const oldToNewMatchIds = replayCore({
    gameId,
    matchesToReplay,
    seasonSeed,
    alltimeSeed,
    seedSeason: anchorSeason
  });

  // Re-check achievements for all replayed matches
  recheckAchievementsForReplay(gameId, matchesToReplay, oldToNewMatchIds);
}