// POST /api/gambling/matches/[id]/settle
// { player_id, red_score, blue_score, notes? }
// Only the two gamble participants may enter the score (spec: the API waits
// until a player adds it). Records the match via the existing Elo flow and
// settles every bet + the pot in one transaction.

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { settleGambleMatch, getGambleMatch } from '@/lib/gamble';
import { announceSettled } from '@/lib/gambleNotifications';
import { gambleErrorResponse, requirePlayerId, requireSessionPlayer } from '@/lib/gambleApi';

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
    if (playerId !== gm.red_player_id && playerId !== gm.blue_player_id) {
      return NextResponse.json(
        { error: 'Only the two players may enter the result score' },
        { status: 403 }
      );
    }

    const summary = settleGambleMatch(matchId, [
      { team: 0, player_ids: [gm.red_player_id], score: redScore },
      { team: 1, player_ids: [gm.blue_player_id], score: blueScore },
    ], body.notes ?? `gamble #${matchId}`);

    announceSettled(gm, summary).catch(err => console.error('gamble announce failed:', err));

    revalidatePath('/', 'layout');
    return NextResponse.json({ summary }, { status: 201 });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}