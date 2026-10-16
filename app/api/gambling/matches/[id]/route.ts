// GET /api/gambling/matches/[id] — gamble match detail
// Query: ?player_id= to include that viewer's own bets/role flags.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  getGambleMatch, getBets, getBetPool, deriveStatus, syncStatuses,
  getSettleSummary, getGambleParticipants,
} from '@/lib/gamble';
import { isWithinEditWindow } from '@/lib/elo';
import { gambleErrorResponse } from '@/lib/gambleApi';
import type { SettleSummary } from '@/lib/types';

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

    // Full roster (team gambles have MORE than two seats; legacy 1v1s are
    // backfilled into the same table).
    const roster = getGambleParticipants(matchId);
    const isParticipant = Number.isInteger(playerId) && roster.some(p => p.player_id === playerId);
    const myBets = Number.isInteger(playerId)
      ? bets.filter(b => b.bettor_id === playerId)
      : [];

    // Final score + reconstructed settle details for a settled gamble: the
    // settle itself replays the ledger so the page can show per-player entry
    // shares + pot split even when nobody just settled in this session.
    let finalScore: { red: number; blue: number } | null = null;
    let recordedPlayedAt: string | null = null;
    let summary: SettleSummary | null = null;
    if (gm.status === 'settled' && gm.match_id) {
      summary = getSettleSummary(gm.id);
      const parts = db.prepare(`
        SELECT team, score FROM match_participants
        WHERE match_id = ? AND team IN (0, 1) ORDER BY team`)
        .all(gm.match_id) as { team: number; score: number }[];
      if (parts.some(p => p.team === 0) && parts.some(p => p.team === 1)) {
        finalScore = {
          red: parts.find(p => p.team === 0)!.score,
          blue: parts.find(p => p.team === 1)!.score,
        };
      }
      const recorded = db.prepare(`SELECT played_at FROM matches WHERE id = ?`)
        .get(gm.match_id) as { played_at: string } | undefined;
      recordedPlayedAt = recorded?.played_at ?? null;
    }

    // Correction offer: participants may fix a wrong score within the same
    // 24-hour edit window office matches use (money true-ups with the bookie).
    const canCorrect = isParticipant && gm.status === 'settled'
      && Boolean(recordedPlayedAt) && finalScore !== null
      && isWithinEditWindow(recordedPlayedAt!);

    return NextResponse.json({
      match: gm,
      derived_status: derived.status,
      seconds_to_close: derived.secondsToClose,
      bets,
      pool,
      final_score: finalScore,
      summary,
      participants: roster,
      my_bets: myBets,
      my_staked: myBets.reduce((s, b) => s + b.stake, 0),
      is_participant: isParticipant,
      can_bet: derived.status === 'open' && !isParticipant,
      can_score: isParticipant && (derived.status === 'awaiting_score' || derived.status === 'bets_closed'),
      can_correct: canCorrect,
      can_cancel: isParticipant && (derived.status === 'open' || derived.status === 'bets_closed' || derived.status === 'awaiting_score'),
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}