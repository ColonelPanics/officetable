// GET /api/gambling/odds-preview?game_id=&red=&blue=
// Live odds ladder for a prospective 1v1 matchup — Elo + head-to-head blend,
// computed fresh (nothing frozen). Used by the challenge form's preview.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { computeOddsLadder } from '@/lib/gambleOdds';
import { gambleErrorResponse } from '@/lib/gambleApi';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gameId = parseInt(searchParams.get('game_id') ?? '', 10);
    const red = parseInt(searchParams.get('red') ?? '', 10);
    const blue = parseInt(searchParams.get('blue') ?? '', 10);

    if (!Number.isInteger(gameId) || !Number.isInteger(red) || !Number.isInteger(blue)) {
      return NextResponse.json({ error: 'game_id, red and blue are required' }, { status: 400 });
    }

    const game = db.prepare(`SELECT score_value, score_type FROM games WHERE id = ?`)
      .get(gameId) as { score_value: number; score_type: string } | undefined;
    if (!game) return NextResponse.json({ error: 'Unknown game' }, { status: 404 });
    if (game.score_type !== 'best_of') {
      return NextResponse.json({ error: 'Betting is only set up for fixed-total games' }, { status: 400 });
    }

    const ladder = computeOddsLadder({
      gameId,
      redPlayerIds: [red],
      bluePlayerIds: [blue],
      total: game.score_value,
    });

    return NextResponse.json({ ladder });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}