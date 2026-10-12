// GET  /api/gambling/challenges  — challenge lists (mine + open on table)
// POST /api/gambling/challenges  — create a challenge (terms only, no money)

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import db from '@/lib/db';
import {
  createChallenge, getChallenge, getChallengeTerms, syncStatuses,
  type ChallengeTermsInput,
} from '@/lib/gamble';
import { computeOddsLadder } from '@/lib/gambleOdds';
import { announceChallengeIssued } from '@/lib/gambleNotifications';
import { gambleErrorResponse, requirePlayerId, requireSessionPlayer } from '@/lib/gambleApi';
import type { Challenge } from '@/lib/types';

const LIST_SQL = `
  SELECT c.*, g.name as game_name,
         cha.name as challenger_name, opp.name as opponent_name, tu.name as terms_by_name
  FROM challenges c
  JOIN players cha ON cha.id = c.challenger_id
  LEFT JOIN players opp ON opp.id = c.opponent_id
  JOIN players tu ON tu.id = c.terms_by
  LEFT JOIN games g ON g.id = c.game_id
`;

export async function GET(request: NextRequest) {
  try {
    syncStatuses();
    const { searchParams } = new URL(request.url);
    const playerId = searchParams.get('player_id');
    const status = searchParams.get('status'); // optional filter

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (playerId) {
      // Mine — plus broadcast challenges, which anyone can still act on
      conditions.push(`(c.challenger_id = ? OR c.opponent_id = ? OR (c.broadcast = 1 AND c.status IN ('pending', 'countered')))`);
      params.push(parseInt(playerId, 10), parseInt(playerId, 10));
    }
    if (status) {
      conditions.push(`c.status = ?`);
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const challenges = db.prepare(`${LIST_SQL} ${where} ORDER BY c.id DESC LIMIT 50`)
      .all(...params) as Challenge[];
    return NextResponse.json({ challenges });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const challengerId = requirePlayerId(body.challenger_id);
    await requireSessionPlayer(challengerId); // challenges are money actions
    // Broadcast challenge: no opponent — first non-challenger to accept plays
    const broadcast = body.broadcast === true || body.broadcast === 1;
    const opponentId = broadcast ? null : requirePlayerId(body.opponent_id);
    const gameId = parseInt(String(body.game_id), 10);
    if (!Number.isInteger(gameId)) {
      return NextResponse.json({ error: 'game_id is required' }, { status: 400 });
    }

    const terms: ChallengeTermsInput = {
      entryFee: parseInt(String(body.entry_fee), 10),
      scheduledAt: String(body.scheduled_at ?? ''),
      side: body.side === 'blue' ? 'blue' : 'red',
      payoutLine: typeof body.payout_line === 'string' ? body.payout_line : undefined,
      specialRules: body.special_rules != null ? String(body.special_rules) : undefined,
    };

    const challengeId = createChallenge(gameId, challengerId, opponentId, terms);

    // Announce (fire and forget) with the pre-accept odds preview —
    // broadcast challenges can't preview (red may be undetermined yet)
    const challenge = getChallenge(challengeId)!;
    let ladder = null;
    if (!broadcast) {
      const game = db.prepare(`SELECT score_value FROM games WHERE id = ?`).get(gameId) as { score_value: number };
      const bluePlayerId = challenge.red_player_id === challenge.challenger_id
        ? challenge.opponent_id : challenge.challenger_id;
      ladder = computeOddsLadder({
        gameId,
        redPlayerIds: [challenge.red_player_id!],
        bluePlayerIds: [bluePlayerId!],
        total: game.score_value,
      });
    }
    announceChallengeIssued(challenge).catch(err => console.error('gamble announce failed:', err));

    revalidatePath('/', 'layout');
    return NextResponse.json(
      { challenge_id: challengeId, challenge, odds_preview: ladder },
      { status: 201 }
    );
  } catch (error) {
    return gambleErrorResponse(error);
  }
}