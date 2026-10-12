// GET /api/gambling/challenges/[id] — challenge detail + negotiation thread

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getChallenge, getChallengeTerms, getGambleMatch, deriveStatus, getBetPool } from '@/lib/gamble';
import { computeOddsLadder } from '@/lib/gambleOdds';
import { gambleErrorResponse } from '@/lib/gambleApi';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const challengeId = parseInt(id, 10);
    const challenge = getChallenge(challengeId);
    if (!challenge) {
      return NextResponse.json({ error: 'Challenge not found' }, { status: 404 });
    }

    const terms_history = getChallengeTerms(challengeId);
    const gambleMatch = challenge.gamble_match_id ? getGambleMatch(challenge.gamble_match_id) : undefined;
    const derived = gambleMatch ? deriveStatus(gambleMatch) : null;

    // Frozen odds come with the match; while still negotiating, preview from
    // the current terms (same math the accept path freezes). Broadcast
    // challenges can't preview — red may still be undetermined.
    let odds_preview = null;
    if (!gambleMatch && terms_history.length > 0 && !challenge.broadcast) {
      const game = db.prepare(`SELECT score_value FROM games WHERE id = ?`)
        .get(challenge.game_id) as { score_value: number } | undefined;
      if (game) {
        const last = terms_history[terms_history.length - 1];
        const bluePlayerId = last.red_player_id === challenge.challenger_id
          ? challenge.opponent_id! : challenge.challenger_id;
        odds_preview = computeOddsLadder({
          gameId: challenge.game_id,
          redPlayerIds: [last.red_player_id!],
          bluePlayerIds: [bluePlayerId],
          total: game.score_value,
        });
      }
    }

    return NextResponse.json({
      challenge,
      terms_history,
      gamble_match: gambleMatch,
      derived_status: derived?.status ?? null,
      seconds_to_close: derived?.secondsToClose ?? null,
      pool: gambleMatch ? getBetPool(gambleMatch.id) : 0,
      ladder: odds_preview,
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}