// GET /api/gambling/matches/[id] — gamble match detail
// Query: ?player_id= to include that viewer's own bets/role flags.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  getGambleMatch, getBets, getBetPool, deriveStatus, syncStatuses,
} from '@/lib/gamble';
import { gambleErrorResponse } from '@/lib/gambleApi';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    syncStatuses();
    const { id } = await params;
    const matchId = parseInt(id, 10);
    const gm = getGambleMatch(matchId);
    if (!gm) {
      return NextResponse.json({ error: 'Gamble match not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const playerId = parseInt(searchParams.get('player_id') ?? '', 10);

    const derived = deriveStatus(gm);
    const bets = getBets(matchId);
    const pool = getBetPool(matchId);

    const isParticipant = Number.isInteger(playerId)
      && (playerId === gm.red_player_id || playerId === gm.blue_player_id);
    const myBets = Number.isInteger(playerId)
      ? bets.filter(b => b.bettor_id === playerId)
      : [];

    // Final score for a settled gamble: read back the real match the settle
    // recorded. team 0 = red, team 1 = blue (the settle path guarantees this
    // orientation). Returned unoriented as {red, blue} for the UI.
    let finalScore: { red: number; blue: number } | null = null;
    if (gm.status === 'settled' && gm.match_id) {
      const parts = db.prepare(`
        SELECT team, score FROM match_participants
        WHERE match_id = ? AND team IN (0, 1) ORDER BY team`)
        .all(gm.match_id) as { team: number; score: number }[];
      if (parts.length === 2) finalScore = { red: parts[0].score, blue: parts[1].score };
    }

    return NextResponse.json({
      match: gm,
      derived_status: derived.status,
      seconds_to_close: derived.secondsToClose,
      bets,
      pool,
      final_score: finalScore,
      my_bets: myBets,
      my_staked: myBets.reduce((s, b) => s + b.stake, 0),
      is_participant: isParticipant,
      can_bet: derived.status === 'open' && !isParticipant,
      can_score: isParticipant && (derived.status === 'awaiting_score' || derived.status === 'bets_closed'),
      can_cancel: isParticipant && (derived.status === 'open' || derived.status === 'bets_closed' || derived.status === 'awaiting_score'),
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}