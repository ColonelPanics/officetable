// GET  /api/gambling/challenges  — challenge lists (mine + open on table)
// POST /api/gambling/challenges  — create a challenge (terms only, no money)

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import db from '@/lib/db';
import {
  createChallenge, createTeamChallenge, getChallenge, getChallengeSlots, getChallengeTerms, syncStatuses,
  type ChallengeTermsInput,
} from '@/lib/gamble';
import { computeOddsLadder } from '@/lib/gambleOdds';
import { announceChallengeIssued, announceTeamChallengeIssued } from '@/lib/gambleNotifications';
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
      // Mine — plus broadcast challenges and any team challenge I hold a seat
      // in, plus open team/broadcast challenges which anyone can act on
      conditions.push(`(
        c.challenger_id = ? OR c.opponent_id = ?
        OR (c.broadcast = 1 AND c.status IN ('pending', 'countered'))
        OR EXISTS (SELECT 1 FROM challenge_slots s WHERE s.challenge_id = c.id AND s.player_id = ?)
      )`);
      params.push(parseInt(playerId, 10), parseInt(playerId, 10), parseInt(playerId, 10));
    }
    if (status) {
      conditions.push(`c.status = ?`);
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const challenges = db.prepare(`${LIST_SQL} ${where} ORDER BY c.id DESC LIMIT 50`)
      .all(...params) as Challenge[];
    // Attach seat maps for team challenges (legacy 1v1s get an empty one).
    for (const c of challenges) {
      (c as Challenge & { slots?: unknown }).slots = getChallengeSlots(c.id);
    }
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

    // Team gambles: explicit seats per side — a player id per seat or null for
    // a broadcast seat ("me & broadcast vs broadcast & broadcast", 1v2s, 2v2s…).
    // A 1-1 shape routes to the legacy single-challenge flow.
    let challengeId: number;
    let broadcast: boolean;
    if (body.red_slots != null || body.blue_slots != null) {
      const parseSlots = (v: unknown): (number | null)[] => {
        if (!Array.isArray(v)) {
          return NextResponse.json(
            { error: 'red_slots/blue_slots must be arrays of player ids (or null for a broadcast seat)' },
            { status: 400 }
          ) as never;
        }
        return v.map(x => (x == null ? null : requirePlayerId(x)));
      };
      const redSlots = parseSlots(body.red_slots ?? [challengerId]);
      const blueSlots = parseSlots(body.blue_slots ?? []);
      broadcast = false;
      if (redSlots.length === 1 && blueSlots.length === 1 && redSlots[0] != null && blueSlots[0] != null) {
        challengeId = createChallenge(gameId, challengerId, redSlots[0], terms);
      } else {
        challengeId = createTeamChallenge(gameId, challengerId, redSlots, blueSlots, terms);
      }
    } else {
      // Broadcast challenge: no opponent — first non-challenger to accept plays
      broadcast = body.broadcast === true || body.broadcast === 1;
      const opponentId = broadcast ? null : requirePlayerId(body.opponent_id);
      challengeId = createChallenge(gameId, challengerId, opponentId, terms);
    }

    // Announce (fire and forget) with the pre-accept odds preview —
    // broadcast challenges can't preview (red may be undetermined yet)
    const challenge = getChallenge(challengeId)!;
    let ladder = null;
    const slots = getChallengeSlots(challengeId);
    const isTeam = slots.length > 0;
    if (!broadcast && !isTeam) {
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
    if (isTeam) announceTeamChallengeIssued(challenge, slots).catch(err => console.error('gamble announce failed:', err));
    else announceChallengeIssued(challenge).catch(err => console.error('gamble announce failed:', err));

    revalidatePath('/', 'layout');
    return NextResponse.json(
      { challenge_id: challengeId, challenge, slots, odds_preview: ladder },
      { status: 201 }
    );
  } catch (error) {
    return gambleErrorResponse(error);
  }
}