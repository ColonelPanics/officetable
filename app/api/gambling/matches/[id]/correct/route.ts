// POST /api/gambling/matches/[id]/correct
// { player_id, red_score, blue_score, notes? }
// Corrects the final score of a SETTLED gamble: re-runs the recorded match
// through the Elo correction replay and re-derives every bet's won/lost +
// payout (the ladder). Deliberately writes NO bank rows — the money that
// moved at the original settle is trued up with the bookie out-of-band.
// Same access rules as settle: only the two participants, logged in as
// themselves, and within the 24-hour edit window office matches use.

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import db from '@/lib/db';
import { correctGambleScore, getGambleMatch } from '@/lib/gamble';
import { announceCorrected } from '@/lib/gambleNotifications';
import { isWithinEditWindow } from '@/lib/elo';
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
    await requireSessionPlayer(playerId); // same gate as settle — no anonymous corrections
    const redScore = parseInt(String(body.red_score), 10);
    const blueScore = parseInt(String(body.blue_score), 10);

    const gm = getGambleMatch(matchId);
    if (!gm) return NextResponse.json({ error: 'Gamble match not found' }, { status: 404 });
    if (playerId !== gm.red_player_id && playerId !== gm.blue_player_id) {
      return NextResponse.json(
        { error: 'Only the two players may correct the result score' },
        { status: 403 }
      );
    }

    // 24-hour edit window, measured on the recorded match itself — after
    // that, the correction belongs to the bookie (scripts/correct-gamble-score.ts).
    if (gm.match_id) {
      const recorded = db.prepare(`SELECT played_at FROM matches WHERE id = ?`)
        .get(gm.match_id) as { played_at: string } | undefined;
      if (recorded && !isWithinEditWindow(recorded.played_at)) {
        return NextResponse.json(
          { error: 'The 24-hour edit window has passed — settle corrections with the bookie (they can run the correct-gamble-score script)' },
          { status: 403 }
        );
      }
    }

    const summary = correctGambleScore(matchId, redScore, blueScore, body.notes);

    announceCorrected(gm, summary.previousScore, summary.finalScore)
      .catch(err => console.error('gamble correction announce failed:', err));

    revalidatePath('/', 'layout');
    return NextResponse.json({ summary }, { status: 201 });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}