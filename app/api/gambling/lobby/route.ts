// GET /api/gambling/lobby?player_id=&game_id=
// One-stop payload for the gambling lobby page. Runs the lazy status sync
// first so everything below sees the current clock state.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { syncStatuses, deriveStatus, getBetPool } from '@/lib/gamble';
import { getBank, isBankLinked } from '@/lib/bank';
import { gambleErrorResponse } from '@/lib/gambleApi';
import type { Challenge, GambleMatch, OddsLadder } from '@/lib/types';

const CHALLENGE_SQL = `
  SELECT c.*, g.name as game_name,
         cha.name as challenger_name, opp.name as opponent_name, tu.name as terms_by_name
  FROM challenges c
  JOIN players cha ON cha.id = c.challenger_id
  LEFT JOIN players opp ON opp.id = c.opponent_id
  JOIN players tu ON tu.id = c.terms_by
  LEFT JOIN games g ON g.id = c.game_id
`;

const MATCH_SQL = `
  SELECT gm.*, g.name as game_name,
         red.name as red_player_name, blue.name as blue_player_name
  FROM gamble_matches gm
  JOIN games g ON g.id = gm.game_id
  JOIN players red ON red.id = gm.red_player_id
  JOIN players blue ON blue.id = gm.blue_player_id
`;

export async function GET(request: NextRequest) {
  try {
    syncStatuses();
    const { searchParams } = new URL(request.url);
    const playerId = parseInt(searchParams.get('player_id') ?? '', 10);
    const gameId = parseInt(searchParams.get('game_id') ?? '', 10);

    const bank = getBank();

    // Challenges I'm part of that are still negotiable
    const myChallenges = Number.isInteger(playerId)
      ? db.prepare(`${CHALLENGE_SQL}
          WHERE c.status IN ('pending', 'countered')
            AND (c.challenger_id = ? OR c.opponent_id = ?)
          ORDER BY c.id DESC LIMIT 20`).all(playerId, playerId) as Challenge[]
      : [];

    // Broadcast challenges: nobody picked, any non-challenger may accept
    const broadcasts = db.prepare(`${CHALLENGE_SQL}
      WHERE c.broadcast = 1 AND c.status IN ('pending', 'countered')
        ${Number.isInteger(playerId) ? 'AND c.challenger_id != ?' : ''}
      ORDER BY c.id DESC LIMIT 10`)
      .all(...(Number.isInteger(playerId) ? [playerId] : [])) as Challenge[];

    // Public callouts: a DIRECT (non-broadcast) challenge that's still open is
    // visible to everyone — that's the callout. Only the named opponent can
    // accept (respond enforces it), so viewers here get the taunt, not buttons.
    // Challenges involving the viewer are already in my_challenges.
    const callouts = db.prepare(`${CHALLENGE_SQL}
      WHERE c.broadcast = 0 AND c.status IN ('pending', 'countered')
        AND c.opponent_id IS NOT NULL
        ${Number.isInteger(playerId) ? 'AND c.challenger_id != ? AND c.opponent_id != ?' : ''}
      ORDER BY c.id DESC LIMIT 10`)
      .all(...(Number.isInteger(playerId) ? [playerId, playerId] : [])) as Challenge[];

    // Live gamble matches (bets open / closed-awaiting-score)
    const liveRows = db.prepare(
      `${MATCH_SQL} WHERE gm.status IN ('open', 'awaiting_score')
       ${Number.isInteger(gameId) ? 'AND gm.game_id = ?' : ''}
       ORDER BY gm.scheduled_at ASC LIMIT 30`
    ).all(...(Number.isInteger(gameId) ? [gameId] : [])) as GambleMatch[];

    const live = liveRows.map(row => {
      const derived = deriveStatus(row);
      const ladder = JSON.parse(row.odds_json) as OddsLadder;
      const top = ladder.outcomes.slice().sort((a, b) => b.prob - a.prob).slice(0, 3);
      return {
        ...row,
        derived_status: derived.status,
        seconds_to_close: derived.secondsToClose,
        pool: getBetPool(row.id),
        top_odds: top,
        predicted: ladder.predictedLine,
      };
    });

    // Recently settled
    const settledRows = db.prepare(
      `${MATCH_SQL} WHERE gm.status = 'settled'
       ${Number.isInteger(gameId) ? 'AND gm.game_id = ?' : ''}
       ORDER BY gm.settled_at DESC LIMIT 10`
    ).all(...(Number.isInteger(gameId) ? [gameId] : [])) as GambleMatch[];

    return NextResponse.json({
      me: Number.isInteger(playerId)
        ? { player_id: playerId, balance: bank.getBalance(playerId), bank_linked: isBankLinked(playerId) }
        : null,
      house_balance: bank.getHouseBalance(),
      my_challenges: myChallenges,
      broadcast_challenges: broadcasts,
      callouts,
      live_matches: live,
      settled_matches: settledRows.map(row => ({
        id: row.id,
        game_name: row.game_name,
        red_player_name: row.red_player_name,
        blue_player_name: row.blue_player_name,
        entry_fee: row.entry_fee,
        settled_at: row.settled_at,
      })),
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}