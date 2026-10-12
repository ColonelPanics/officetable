// POST /api/gambling/matches/[id]/cancel
// { player_id } — a participant cancels the gamble: open bet stakes and both
// entry fees are refunded; the challenge closes as cancelled.

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { cancelGambleMatch, getGambleMatch, getBetPool } from '@/lib/gamble';
import { announceCancelled } from '@/lib/gambleNotifications';
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
    await requireSessionPlayer(playerId); // cancelling moves (refunds) money

    const gm = getGambleMatch(matchId);
    if (!gm) return NextResponse.json({ error: 'Gamble match not found' }, { status: 404 });
    if (playerId !== gm.red_player_id && playerId !== gm.blue_player_id) {
      return NextResponse.json({ error: 'Only the two players may cancel the gamble' }, { status: 403 });
    }

    const refundTotal = 2 * gm.entry_fee + getBetPool(matchId);
    cancelGambleMatch(matchId);

    announceCancelled(gm, refundTotal).catch(err => console.error('gamble announce failed:', err));

    revalidatePath('/', 'layout');
    return NextResponse.json({ cancelled: true, refunded: refundTotal });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}