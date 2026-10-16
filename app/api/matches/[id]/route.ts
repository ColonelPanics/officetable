import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import db from '@/lib/db';
import { correctMatch, deleteMatchAndReplay, isWithinEditWindow } from '@/lib/elo';
import { getPunditryForMatch } from '@/lib/punditry';
import { validatePointTimeline } from '@/lib/timeline';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const matchId = parseInt(id, 10);

  if (isNaN(matchId)) {
    return NextResponse.json({ error: 'Invalid match ID' }, { status: 400 });
  }

  const matchStmt = db.prepare(`
    SELECT m.*, g.name as game_name
    FROM matches m
    JOIN games g ON m.game_id = g.id
    WHERE m.id = ?
  `);
  const match = matchStmt.get(matchId);

  if (!match) {
    return NextResponse.json({ error: 'Match not found' }, { status: 404 });
  }

  const participantsStmt = db.prepare(`
    SELECT mp.*, p.name as player_name, p.avatar_url
    FROM match_participants mp
    JOIN players p ON mp.player_id = p.id
    WHERE mp.match_id = ?
  `);
  const participants = participantsStmt.all(matchId);

  const achievementsStmt = db.prepare(`
    SELECT
      a.id as achievement_id,
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
  const achievements = achievementsStmt.all(matchId);

  const punditry = getPunditryForMatch(matchId);

  return NextResponse.json({
    ...match,
    participants,
    achievements,
    punditry,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const matchId = parseInt(id, 10);

    if (isNaN(matchId)) {
      return NextResponse.json({ error: 'Invalid match ID' }, { status: 400 });
    }

    // Get the match to check edit window
    const matchStmt = db.prepare(`SELECT * FROM matches WHERE id = ?`);
    const match = matchStmt.get(matchId) as { id: number; played_at: string } | undefined;

    if (!match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 });
    }

    // Check if within edit window (24 hours)
    if (!isWithinEditWindow(match.played_at)) {
      return NextResponse.json(
        { error: 'Match can only be edited within 24 hours of being recorded' },
        { status: 403 }
      );
    }

    // A match that backs a settled gamble must be corrected through the
    // gamble flow — the gamble's match_id pointer and its bets' won/lost
    // records must be re-derived with the new score (the Elo replay re-creates
    // match rows under fresh ids, which would leave match_id dangling).
    const gambleRef = db.prepare(`SELECT id FROM gamble_matches WHERE match_id = ? AND status = 'settled'`)
      .get(matchId) as { id: number } | undefined;
    if (gambleRef) {
      return NextResponse.json(
        { error: `This match is the settlement record of gamble #${gambleRef.id} — correct its score on the gamble match page (/gambling/matches/${gambleRef.id}) so the bet ladder is corrected too` },
        { status: 409 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { teams, timeline: rawTimeline } = body as {
      teams: { team: number; player_ids: number[]; score: number }[];
      timeline?: unknown;
    };

    if (!teams || teams.length < 2) {
      return NextResponse.json(
        { error: 'At least 2 teams are required' },
        { status: 400 }
      );
    }

    // Validate scores
    for (const team of teams) {
      if (typeof team.score !== 'number' || team.score < 0) {
        return NextResponse.json(
          { error: 'All teams must have a valid score (non-negative number)' },
          { status: 400 }
        );
      }
    }

    // Optional corrected timeline (live-recorded matches may re-score points).
    // Omitted = keep the original timeline verbatim; explicit null drops it.
    let timeline: Parameters<typeof correctMatch>[2] = undefined;
    if (rawTimeline !== undefined) {
      if (rawTimeline === null) {
        timeline = null;
      } else {
        const checked = validatePointTimeline(rawTimeline, teams, teams.map(t => t.score));
        if (checked.error || !checked.timeline) {
          return NextResponse.json(
            { error: checked.error ?? 'Invalid timeline' },
            { status: 400 }
          );
        }
        timeline = checked.timeline;
      }
    }

    // Perform the correction (gamble-backed matches are rejected above —
    // they must go through the gamble correction flow)
    correctMatch(matchId, teams, timeline);

    revalidatePath('/', 'layout');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating match:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update match' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const matchId = parseInt(id, 10);

    if (isNaN(matchId)) {
      return NextResponse.json({ error: 'Invalid match ID' }, { status: 400 });
    }

    // Get the match to check edit window
    const matchStmt = db.prepare(`SELECT * FROM matches WHERE id = ?`);
    const match = matchStmt.get(matchId) as { id: number; played_at: string } | undefined;

    if (!match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 });
    }

    // Check if within edit window (24 hours)
    if (!isWithinEditWindow(match.played_at)) {
      return NextResponse.json(
        { error: 'Match can only be deleted within 24 hours of being recorded' },
        { status: 403 }
      );
    }

    // A settled gamble's settlement record can only be undone together with
    // the gamble itself — deleting it here would dangle gamble_matches.match_id
    // and leave the bet ladder forever wrong.
    const gambleRef = db.prepare(`SELECT id FROM gamble_matches WHERE match_id = ? AND status = 'settled'`)
      .get(matchId) as { id: number } | undefined;
    if (gambleRef) {
      return NextResponse.json(
        { error: `This match is the settlement record of gamble #${gambleRef.id} — settle corrections with the bookie instead of deleting it` },
        { status: 409 }
      );
    }

    // Delete the match and replay subsequent matches to recalculate ratings
    deleteMatchAndReplay(matchId);

    revalidatePath('/', 'layout');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting match:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete match' },
      { status: 500 }
    );
  }
}