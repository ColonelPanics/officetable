// POST /api/gambling/matches/[id]/settle
// { player_id, red_score, blue_score, notes? }
// Only the two gamble participants may enter the score (spec: the API waits
// until a player adds it). Records the match via the existing Elo flow and
// settles every bet + the pot in one transaction.

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { settleGambleMatch, getGambleMatch, getGambleParticipants } from '@/lib/gamble';
import { announceSettled } from '@/lib/gambleNotifications';
import { gambleErrorResponse, requirePlayerId, requireSessionPlayer } from '@/lib/gambleApi';
import { validatePointTimeline } from '@/lib/timeline';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const matchId = parseInt(id, 10);
    if (!Number.isInteger(matchId)) {
      return NextResponse.json({ error: 'Invalid match id' }, { status: 400 });
    }

    const body = await request.json();
    const playerId = requirePlayerId(body.player_id);
    await requireSessionPlayer(playerId); // settling pays out the pot
    const redScore = parseInt(String(body.red_score), 10);
    const blueScore = parseInt(String(body.blue_score), 10);

    const gm = getGambleMatch(matchId);
    if (!gm) return NextResponse.json({ error: 'Gamble match not found' }, { status: 404 });
    const roster = getGambleParticipants(matchId);
    if (!roster.some(p => p.player_id === playerId)) {
      return NextResponse.json(
        { error: 'Only a player in the gamble may enter the result score' },
        { status: 403 }
      );
    }

    // Teams come from the roster itself (works for 1v1s and any team shape —
    // red/blue scores are entered, the seats are known).
    const redPlayerIds = roster.filter(p => p.team === 0).map(p => p.player_id);
    const bluePlayerIds = roster.filter(p => p.team === 1).map(p => p.player_id);
    if (!redPlayerIds.length || !bluePlayerIds.length) {
      return NextResponse.json({ error: 'Gamble match has no roster' }, { status: 400 });
    }

    // Optional live-scorer timeline (team indexes: 0 = red, 1 = blue). The
    // recorded points must sum to the entered final scores.
    let timeline = null;
    if (body.timeline !== undefined && body.timeline !== null) {
      const teamsShape = [
        { team: 0, player_ids: redPlayerIds, score: redScore },
        { team: 1, player_ids: bluePlayerIds, score: blueScore },
      ];
      const checked = validatePointTimeline(body.timeline, teamsShape, [redScore, blueScore]);
      if (checked.error || !checked.timeline) {
        return NextResponse.json({ error: checked.error ?? 'Invalid timeline' }, { status: 400 });
      }
      timeline = checked.timeline;
    }

    const summary = settleGambleMatch(matchId, [
      { team: 0, player_ids: redPlayerIds, score: redScore },
      { team: 1, player_ids: bluePlayerIds, score: blueScore },
    ], body.notes ?? `gamble #${matchId}`, timeline);

    announceSettled(gm, summary).catch(err => console.error('gamble announce failed:', err));

    revalidatePath('/', 'layout');
    return NextResponse.json({ summary }, { status: 201 });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}