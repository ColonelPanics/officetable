// POST /api/gambling/matches/[id]/bets
// { player_id, red_score, blue_score, stake } → 201 { bet_id, balance }
// Participants are blocked server-side (match-fixing guard).

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { placeBet } from '@/lib/gamble';
import { getBank } from '@/lib/bank';
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
    const bettorId = requirePlayerId(body.player_id);
    await requireSessionPlayer(bettorId); // no betting in someone else's name
    const redScore = parseInt(String(body.red_score), 10);
    const blueScore = parseInt(String(body.blue_score), 10);
    const stake = parseInt(String(body.stake), 10);

    const betId = placeBet(matchId, bettorId, redScore, blueScore, stake);

    revalidatePath('/', 'layout');
    return NextResponse.json(
      { bet_id: betId, balance: getBank().getBalance(bettorId) },
      { status: 201 }
    );
  } catch (error) {
    return gambleErrorResponse(error);
  }
}