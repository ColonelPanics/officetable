import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getLadderSnapshot, getLadderTimeline } from '@/lib/ladderHistory';

/**
 * Ladder time machine: GET /api/ladder-history?game_id=1&at=<moment>
 *  - game_id (required)
 *  - at: optional moment ('YYYY-MM-DD' = that day as it stood at midnight;
 *    full datetimes accepted). Default = now (the board as it stands).
 *  - include_timeline: optional 'true' to also return the sport's full match
 *    timeline (for the front-end slider).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const gameId = parseInt(searchParams.get('game_id') || '', 10);
  if (isNaN(gameId)) {
    return NextResponse.json({ error: 'Valid game_id is required' }, { status: 400 });
  }

  const game = db.prepare(`SELECT id, name FROM games WHERE id = ?`).get(gameId);
  if (!game) {
    return NextResponse.json({ error: 'Game not found' }, { status: 404 });
  }

  const at = searchParams.get('at') ?? undefined;
  let snapshot;
  try {
    snapshot = getLadderSnapshot(gameId, at ?? new Date());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Invalid "at" moment' },
      { status: 400 }
    );
  }

  const timeline = searchParams.get('include_timeline') === 'true'
    ? getLadderTimeline(gameId)
    : undefined;

  return NextResponse.json({ ...snapshot, timeline });
}