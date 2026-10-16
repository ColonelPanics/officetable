import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import db from '@/lib/db';
import { processMatch } from '@/lib/elo';
import { sendGoogleChatNotification, buildMatchNotification } from '@/lib/notifications';
import { getAchievementsForMatch } from '@/lib/achievements';
import { getPunditryForMatch } from '@/lib/punditry';
import { resolveScopeSeasonId, getCurrentSeason } from '@/lib/seasons';
import { syncStatuses, settleGambleMatch, getGambleMatch, GambleError } from '@/lib/gamble';
import { announceSettled } from '@/lib/gambleNotifications';
import { requirePlayerId } from '@/lib/gambleApi';
import { readSessionPlayer } from '@/lib/session';
import { validatePointTimeline } from '@/lib/timeline';
import type { MatchWithParticipants, CreateMatchInput, MatchFilters, PaginationMeta } from '@/lib/types';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Parse pagination params
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;

  // Parse filter params
  const gameId = searchParams.get('game_id');
  const dateFrom = searchParams.get('date_from');
  const dateTo = searchParams.get('date_to');
  const playerIdsStr = searchParams.get('player_ids');
  const playerCount = searchParams.get('player_count');
  const hasAchievements = searchParams.get('has_achievements');
  const minSkillChange = searchParams.get('min_skill_change');
  // Season scoping: scope=season (default, current season) | alltime;
  // optional season_id selects a specific (past) season.
  const targetSeasonId = resolveScopeSeasonId(searchParams.get('scope'), searchParams.get('season_id'));
  const isAllTime = targetSeasonId === 0;
  // The Elo deltas shown per match belong to the ledger being viewed:
  // season views show that ledger's swing, all time shows the continuous one.
  const eloBeforeCol = isAllTime ? 'mp.alltime_elo_before' : 'mp.elo_before';
  const eloAfterCol = isAllTime ? 'mp.alltime_elo_after' : 'mp.elo_after';

  // Parse player_ids (comma-separated)
  const playerIds = playerIdsStr
    ? playerIdsStr.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id))
    : [];

  // Build WHERE conditions and params
  const whereConditions: string[] = [];
  const params: (string | number)[] = [];

  if (gameId) {
    whereConditions.push('m.game_id = ?');
    params.push(parseInt(gameId, 10));
  }

  // Season scope: all-time shows everything (each match exists once);
  // season views filter to the target ledger's matches.
  if (targetSeasonId !== 0) {
    whereConditions.push('m.season_id = ?');
    params.push(targetSeasonId);
  }

  if (dateFrom) {
    whereConditions.push('DATE(m.played_at) >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    whereConditions.push('DATE(m.played_at) <= ?');
    params.push(dateTo);
  }

  // Player filter: AND logic - match must contain ALL selected players
  if (playerIds.length > 0) {
    for (const playerId of playerIds) {
      whereConditions.push('EXISTS (SELECT 1 FROM match_participants mp WHERE mp.match_id = m.id AND mp.player_id = ?)');
      params.push(playerId);
    }
  }

  // Player count filter
  if (playerCount) {
    const count = parseInt(playerCount, 10);
    whereConditions.push('(SELECT COUNT(DISTINCT player_id) FROM match_participants WHERE match_id = m.id) = ?');
    params.push(count);
  }

  // Achievements filter
  if (hasAchievements === 'true') {
    whereConditions.push('EXISTS (SELECT 1 FROM player_achievements pa WHERE pa.match_id = m.id)');
  }

  // Min skill change filter — interpreted in the viewed ledger
  if (minSkillChange) {
    const minChange = parseFloat(minSkillChange);
    whereConditions.push(`EXISTS (SELECT 1 FROM match_participants mp WHERE mp.match_id = m.id AND ABS(${eloAfterCol} - ${eloBeforeCol}) >= ?)`);
    params.push(minChange);
  }

  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

  // Count query for pagination
  const countQuery = `
    SELECT COUNT(DISTINCT m.id) as total
    FROM matches m
    JOIN games g ON m.game_id = g.id
    ${whereClause}
  `;
  const countStmt = db.prepare(countQuery);
  const countResult = countStmt.get(...params) as { total: number };
  const total = countResult.total;
  const totalPages = Math.ceil(total / limit);

  // Main query with pagination
  const matchesQuery = `
    SELECT m.*, g.name as game_name
    FROM matches m
    JOIN games g ON m.game_id = g.id
    ${whereClause}
    ORDER BY m.played_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const stmt = db.prepare(matchesQuery);
  const matches = stmt.all(...params);

  // Get participants for each match, with the viewed ledger's deltas aliased
  // to elo_before/elo_after (raw season + all-time values included too)
  const participantsStmt = db.prepare(`
    SELECT mp.id, mp.match_id, mp.player_id, mp.team, mp.score,
           ${eloBeforeCol} as elo_before, ${eloAfterCol} as elo_after,
           mp.elo_before as season_elo_before, mp.elo_after as season_elo_after,
           mp.alltime_elo_before, mp.alltime_elo_after,
           p.name as player_name, p.avatar_url
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    WHERE mp.match_id = ?
  `);

  // Get achievements for each match
  const achievementsStmt = db.prepare(`
    SELECT
      pa.achievement_id,
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

  const matchesWithParticipants: MatchWithParticipants[] = matches.map((match: any) => {
    const participants = participantsStmt.all(match.id);
    const achievements = achievementsStmt.all(match.id);
    const punditry = getPunditryForMatch(match.id);
    return {
      ...match,
      participants: participants.map((p: any) => ({
        ...p,
        player_name: p.player_name,
      })),
      game_name: match.game_name,
      achievements: achievements.map((a: any) => ({
        achievement_id: a.achievement_id,
        achievement_name: a.achievement_name,
        achievement_description: a.achievement_description,
        achievement_icon: a.achievement_icon,
        player_id: a.player_id,
        player_name: a.player_name
      })),
      punditry
    };
  });

  const pagination: PaginationMeta = {
    page,
    limit,
    total,
    totalPages,
  };

  return NextResponse.json({ matches: matchesWithParticipants, pagination });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { game_id, notes, teams, timeline: rawTimeline } = body as CreateMatchInput & { timeline?: unknown };

    if (!game_id || !teams || teams.length < 2) {
      return NextResponse.json(
        { error: 'game_id and at least 2 teams are required' },
        { status: 400 }
      );
    }

    // Validate all teams have scores
    for (const team of teams) {
      if (typeof team.score !== 'number' || team.score < 0) {
        return NextResponse.json(
          { error: 'All teams must have a valid score (non-negative number)' },
          { status: 400 }
        );
      }
    }

    // Live-scorer timeline (optional): validate shape + that the recorded
    // points actually add up to the final scores being stored.
    let timeline = null;
    if (rawTimeline !== undefined && rawTimeline !== null) {
      const checked = validatePointTimeline(rawTimeline, teams, teams.map(t => t.score));
      if (checked.error || !checked.timeline) {
        return NextResponse.json(
          { error: checked.error ?? 'Invalid timeline' },
          { status: 400 }
        );
      }
      timeline = checked.timeline;
    }

    // Gamble settle hook: a two-team record whose roster seats match an open
    // gamble match (either side order — red/blue sides compare as SETS, so
    // A & B vs B & A on Team 1 both attach) settles that gamble — team gambles
    // (1v2, 2v2…) included. The match is recorded once, through
    // settleGambleMatch's own processMatch.
    //
    // Trust guard: settling moves real money (player shares + the pot), so the
    // hook only fires when the record comes from a rostered player (pass
    // `recorded_by` = your player id; the gamble match page does this via its
    // own settle route). A third-party record that matches an open gamble is
    // rejected — it must not settle the pot, and it must not double-record the
    // match that the participants' settle will record. If no gamble matches,
    // recording behaves exactly as before.
    syncStatuses();
    const hasPlayers = (t: CreateMatchInput['teams'][number]) => Array.isArray(t.player_ids) && t.player_ids.length > 0;
    if (teams.length === 2 && hasPlayers(teams[0]) && hasPlayers(teams[1])) {
      // Seat sets (deduped, order-free) for both recorded sides
      const side0Ids = [...new Set(teams[0].player_ids)];
      const side1Ids = [...new Set(teams[1].player_ids)];
      let recordedBy: number | null = null;
      if (body.recorded_by != null) {
        try { recordedBy = requirePlayerId(body.recorded_by); } catch { recordedBy = null; }
      }

      // Candidate open gambles for this game — match on full roster seat sets,
      // either orientation (gamble_match_participants is backfilled for all
      // legacy 1v1s, so the roster table is always complete).
      const openGambleRows = db.prepare(`
        SELECT id FROM gamble_matches
        WHERE game_id = ? AND status IN ('open', 'awaiting_score')
        ORDER BY id DESC
      `).all(game_id) as { id: number }[];
      const rosterStmt = db.prepare(`
        SELECT team, player_id FROM gamble_match_participants WHERE gamble_match_id = ?
      `);
      const sameSeats = (a: number[], b: number[]) =>
        a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

      let attached: { gambleId: number; redTeam: CreateMatchInput['teams'][number]; blueTeam: CreateMatchInput['teams'][number]; rosterAll: number[] } | null = null;
      for (const gmRow of openGambleRows) {
        const roster = rosterStmt.all(gmRow.id) as { team: number; player_id: number }[];
        const seat0 = [...new Set(roster.filter(r => r.team === 0).map(r => r.player_id))];
        const seat1 = [...new Set(roster.filter(r => r.team === 1).map(r => r.player_id))];
        let redTeam: CreateMatchInput['teams'][number]
        let blueTeam: CreateMatchInput['teams'][number]
        if (sameSeats(side0Ids, seat0) && sameSeats(side1Ids, seat1)) {
          redTeam = teams[0]; blueTeam = teams[1];
        } else if (sameSeats(side0Ids, seat1) && sameSeats(side1Ids, seat0)) {
          redTeam = teams[1]; blueTeam = teams[0];
        } else {
          continue;
        }
        attached = {
          gambleId: gmRow.id,
          redTeam,
          blueTeam,
          rosterAll: [...new Set(roster.map(r => r.player_id))],
        };
        break;
      }

      if (attached) {
        // Settling a gamble moves real money, so under the session model the
        // recorder must be LOGGED IN AS a rostered player — a body-supplied
        // recorded_by alone is forgeable by anyone who can reach the API.
        const sessionPlayer = await readSessionPlayer();
        if (sessionPlayer === null) {
          return NextResponse.json(
            {
              error: 'This result settles an open gamble — log in (top right) as one of the participants to record it',
              code: 'not_logged_in',
              gamble_match_id: attached.gambleId,
            },
            { status: 403 }
          );
        }
        if (recordedBy !== null && recordedBy !== sessionPlayer) {
          return NextResponse.json(
            { error: "You are logged in as a different player — you can't record a result in someone else's name", code: 'forbidden' },
            { status: 403 }
          );
        }
        if (!attached.rosterAll.includes(sessionPlayer)) {
          // recorded_by (when supplied) must equal the session player — checked
          // above — so a forged "recording on behalf of" a participant never
          // gets past this gate either.
          return NextResponse.json(
            {
              error: 'This result settles an open gamble — only one of its participants may record it (from the gamble match page, or logged in as themselves)',
              code: 'not_a_participant',
              gamble_match_id: attached.gambleId,
            },
            { status: 409 }
          );
        }
        let summary;
        try {
          summary = settleGambleMatch(attached.gambleId, [attached.redTeam, attached.blueTeam], notes, timeline);
        } catch (e) {
          // Gamble-side rejections (bets still open, teams mismatch…) surface
          // as their own message — a plain "failed to create match" would
          // confuse the live scorer / recorder who don't know a gamble is
          // attached to this matchup.
          if (e instanceof GambleError) {
            return NextResponse.json(
              { error: e.message, code: e.code, gamble_match_id: attached.gambleId },
              { status: 409 }
            );
          }
          throw e;
        }
        const gmFull = getGambleMatch(attached.gambleId)!;
        announceSettled(gmFull, summary).catch(err => console.error('gamble announce failed:', err));
        revalidatePath('/', 'layout');
        // match_id returned so the live scorer routes to the match report it
        // just generated (the bet attach itself is invisible from the
        // recorder's side — it's just a normal match record to them).
        return NextResponse.json({ success: true, gamble_match_id: attached.gambleId, match_id: summary.matchId, summary }, { status: 201 });
      }
    }

    // Get game name for notification
    const gameStmt = db.prepare('SELECT name, image_url FROM games WHERE id = ?');
    const game = gameStmt.get(game_id) as { name: string; image_url?: string | null } | undefined;

    // Get player names for notification
    const playerIds = teams.flatMap(t => t.player_ids);
    const placeholders = playerIds.map(() => '?').join(',');
    const playersStmt = db.prepare(`SELECT id, name, avatar_url FROM players WHERE id IN (${placeholders})`);
    const players = playersStmt.all(...playerIds) as { id: number; name: string; avatar_url: string | null }[];
    const playerNameMap = new Map(players.map(p => [p.id, p.name]));

    // Build avatar URLs for players that have one (used in Google Chat notifications).
    // Avatar URLs are external links, so they're embeddable by Chat regardless of
    // where the app itself is hosted.
    const playerAvatarMap = new Map<number, string>();
    for (const p of players) {
      if (p.avatar_url) {
        playerAvatarMap.set(p.id, p.avatar_url);
      }
    }

    // Rank shifts are calculated against the same table shown on the
    // leaderboard: retired players AND inactive players (no match within
    // inactive_threshold_days) are hidden, so they must not affect ranks.
    const thresholdSetting = db.prepare(`SELECT value FROM settings WHERE key = 'inactive_threshold_days'`).get() as { value: string } | undefined;
    const inactiveThresholdDays = thresholdSetting ? parseInt(thresholdSetting.value, 10) : 60;
    const inactiveCutoffMs = Date.now() - inactiveThresholdDays * 24 * 60 * 60 * 1000;

    // Last match date per player in this game (before this match is recorded)
    const lastMatchRows = db.prepare(`
      SELECT mp.player_id, MAX(m.played_at) as last_match_at
      FROM match_participants mp
      JOIN matches m ON mp.match_id = m.id
      WHERE m.game_id = ?
      GROUP BY mp.player_id
    `).all(game_id) as { player_id: number; last_match_at: string }[];
    const playerLastMatch = new Map<number, string>();
    for (const row of lastMatchRows) {
      playerLastMatch.set(row.player_id, row.last_match_at);
    }

    // A player is ranked if they're not retired and have played recently enough
    const isRanked = (playerId: number) => {
      const lastMatchAt = playerLastMatch.get(playerId);
      return lastMatchAt !== undefined && new Date(lastMatchAt.replace(' ', 'T')).getTime() >= inactiveCutoffMs;
    };

    const fetchRankings = () => {
      // Rank-shift calc runs on the SEASON ledger (the live competition).
      const currentSeasonId = getCurrentSeason()?.id ?? 0;
      return (db.prepare(`
        SELECT pr.player_id, pr.elo
        FROM player_ratings pr
        JOIN players p ON pr.player_id = p.id
        WHERE pr.game_id = ? AND pr.season_id = ? AND (p.status IS NULL OR p.status != 'retired')
        ORDER BY pr.elo DESC, p.name ASC
      `).all(game_id, currentSeasonId) as { player_id: number; elo: number }[])
        .filter(row => isRanked(row.player_id));
    };

    const toRankMap = (rankings: { player_id: number }[]) => {
      const map = new Map<number, number>();
      rankings.forEach((row, index) => map.set(row.player_id, index + 1));
      return map;
    };

    const rankBefore = toRankMap(fetchRankings());

    // Process match and get skill changes
    const result = processMatch({ game_id, notes, teams, timeline });

    // Get rankings AFTER the match
    const rankAfter = toRankMap(fetchRankings());

    // Calculate rank changes (positive = moved up, negative = moved down).
    // Players who were unranked before the match (e.g. inactive players
    // returning after a long break) aren't shown a rank shift.
    const rankChanges = new Map<number, number>();
    for (const playerId of playerIds) {
      const before = rankBefore.get(playerId);
      const after = rankAfter.get(playerId);
      if (before === undefined || after === undefined) continue;
      // Rank change: positive means moved UP in ranking (lower number is better)
      rankChanges.set(playerId, before - after);
    }

    // Get achievements earned in this match (payout shown once per player —
    // achievementPayouts holds each player's TOTAL paid for the match)
    const payoutShown = new Set<number>();
    const matchAchievements = getAchievementsForMatch(result.matchId);
    const matchAchievementsWithPayout = matchAchievements.map(a => {
      const firstForPlayer = !payoutShown.has(a.player_id);
      payoutShown.add(a.player_id);
      return { ...a, payout: firstForPlayer ? result.achievementPayouts.get(a.player_id) : undefined };
    });

    // Get punditry facts for this match
    const punditryFacts = getPunditryForMatch(result.matchId);

    // Send notification (async, don't wait for it)
    if (game) {
      const notification = buildMatchNotification(
        game.name,
        result.matchId,
        teams,
        playerNameMap,
        result.skillChanges,
        game.image_url,
        notes,
        rankChanges,
        matchAchievementsWithPayout.map(a => ({
          playerId: a.player_id,
          achievementName: a.achievement_name,
          achievementIcon: a.achievement_icon,
          payout: a.payout
        })),
        punditryFacts.map(p => ({ description: p.description })),
        playerAvatarMap
      );
      sendGoogleChatNotification(notification).catch(err => {
        console.error('Failed to send notification:', err);
      });
    }

    // Revalidate the home page to show new data
    revalidatePath('/', 'layout');

    // match_id is returned so the live scorer can hand users straight to the
    // match report it just generated.
    return NextResponse.json({ success: true, match_id: result.matchId }, { status: 201 });
  } catch (error) {
    console.error('Error creating match:', error);
    return NextResponse.json({ error: 'Failed to create match' }, { status: 500 });
  }
}