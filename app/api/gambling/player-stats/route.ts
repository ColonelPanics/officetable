// GET /api/gambling/player-stats?player_id=N — one profile's gambling record.
// Same tracking as the gambling leaderboard, per person: balance/net/wagered/
// bets W-L, plus every gamble they've played and every bet they've placed.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { seedBalance, netHistory } from '@/lib/bank';
import { gambleErrorResponse } from '@/lib/gambleApi';

interface Summary {
  balance: number;
  net: number;
  wagered: number;
  bets_won: number;
  bets_lost: number;
  gambles_played: number;
  gambles_won: number;
  gambles_lost: number;
  gambles_drawn: number;
}

interface PlayerGamble {
  gamble_match_id: number;
  game_name: string;
  scheduled_at: string;
  status: string;
  side: 'red' | 'blue';
  opponent_id: number;
  opponent_name: string;
  my_score: number | null;
  opponent_score: number | null;
  entry_fee: number;
  entry_net: number; // everything they personally got from this gamble, excluding their own bets
  result: 'win' | 'loss' | 'draw' | null;
}

interface PlayerBet {
  id: number;
  gamble_match_id: number;
  created_at: string;
  game_name: string;
  scheduled_at: string;
  red_player_name: string;
  blue_player_name: string;
  red_score: number;
  blue_score: number;
  stake: number;
  decimal_odds: number;
  status: string;
  payout: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const playerId = parseInt(searchParams.get('player_id') ?? '', 10);
    if (!Number.isInteger(playerId)) {
      return NextResponse.json({ error: 'player_id required' }, { status: 400 });
    }

    const player = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(playerId) as
      | { id: number; name: string }
      | undefined;
    if (!player) {
      return NextResponse.json({ error: 'Player not found' }, { status: 404 });
    }

    // Summary — same tracking as the gambling leaderboard
    const s = db.prepare(`
      SELECT COALESCE(bal.balance, ${seedBalance()}) as balance,
        COALESCE((SELECT SUM(amount) FROM bank_transactions
          WHERE player_id = @pid AND ref_type NOT IN ('topup', 'seed', 'resync')), 0) as net,
        COALESCE((SELECT SUM(-amount) FROM bank_transactions
          WHERE player_id = @pid AND amount < 0 AND ref_type NOT IN ('topup', 'seed', 'resync')), 0) as wagered,
        COALESCE((SELECT SUM(status = 'won') FROM bets WHERE bettor_id = @pid), 0) as bets_won,
        COALESCE((SELECT SUM(status = 'lost') FROM bets WHERE bettor_id = @pid), 0) as bets_lost,
        COALESCE((SELECT COUNT(*) FROM gamble_matches gm
          WHERE gm.status = 'settled' AND (gm.red_player_id = @pid OR gm.blue_player_id = @pid)), 0) as gambles_played
      FROM (SELECT 1) dummy
      LEFT JOIN bank_accounts bal ON bal.player_id = @pid
    `).get({ pid: playerId }) as unknown as Summary;

    // Gambles they were a player in, with the recorded final score (team 0 = red).
    // entry_net = all ledger rows tagged with this gamble but not their bets
    // (entry fee debit, entry share back, pot shares, refunds on cancel).
    const gambles = (db.prepare(`
      SELECT gm.id as gamble_match_id, g.name as game_name, gm.scheduled_at, gm.status,
        (CASE WHEN gm.red_player_id = @pid THEN 'red' ELSE 'blue' END) as side,
        opp.id as opponent_id, opp.name as opponent_name,
        gm.entry_fee,
        CASE WHEN gm.red_player_id = @pid THEN mpr.score ELSE mpb.score END as my_score,
        CASE WHEN gm.red_player_id = @pid THEN mpb.score ELSE mpr.score END as opponent_score,
        COALESCE(entry.entry_net, 0) + COALESCE(fee.fee_paid, 0) as entry_net
      FROM gamble_matches gm
      JOIN games g ON g.id = gm.game_id
      JOIN players opp ON opp.id = (CASE WHEN gm.red_player_id = @pid THEN gm.blue_player_id ELSE gm.red_player_id END)
      LEFT JOIN match_participants mpr ON mpr.match_id = gm.match_id AND mpr.team = 0
      LEFT JOIN match_participants mpb ON mpb.match_id = gm.match_id AND mpb.team = 1
      LEFT JOIN (
        SELECT ref_id, SUM(amount) as entry_net
        FROM bank_transactions
        WHERE player_id = @pid
          AND ref_type IN ('player_share', 'pot_winner_share', 'pot_score_share', 'refund')
        GROUP BY ref_id
      ) entry ON entry.ref_id = gm.id
      LEFT JOIN (
        -- the fee debit is tagged with the challenge, not the gamble match
        SELECT ref_id, SUM(amount) as fee_paid
        FROM bank_transactions
        WHERE player_id = @pid AND ref_type = 'challenge_fee'
        GROUP BY ref_id
      ) fee ON fee.ref_id = gm.challenge_id
      WHERE (gm.red_player_id = @pid OR gm.blue_player_id = @pid)
        AND gm.status IN ('settled', 'cancelled')
      ORDER BY gm.scheduled_at DESC
    `).all({ pid: playerId }) as unknown) as {
      gamble_match_id: number; game_name: string; scheduled_at: string; status: string;
      side: 'red' | 'blue'; opponent_id: number; opponent_name: string;
      entry_fee: number; my_score: number | null; opponent_score: number | null;
      entry_net: number; fee_paid: number | null;
    }[];

    const gambleRows: PlayerGamble[] = gambles.map(g => ({
      ...g,
      fee_paid: undefined,
      result:
        g.status !== 'settled' || g.my_score === null || g.opponent_score === null
          ? null
          : g.my_score > g.opponent_score ? 'win'
          : g.my_score < g.opponent_score ? 'loss'
          : 'draw',
    }));

    s.gambles_won = gambleRows.filter(r => r.result === 'win').length;
    s.gambles_lost = gambleRows.filter(r => r.result === 'loss').length;
    s.gambles_drawn = gambleRows.filter(r => r.result === 'draw').length;

    // Every bet they've placed, on any gamble
    const bets = (db.prepare(`
      SELECT b.id, b.gamble_match_id, b.created_at,
        g.name as game_name, gm.scheduled_at,
        r.name as red_player_name, bl.name as blue_player_name,
        b.red_score, b.blue_score, b.stake, b.decimal_odds, b.status, b.payout
      FROM bets b
      JOIN gamble_matches gm ON gm.id = b.gamble_match_id
      JOIN games g ON g.id = gm.game_id
      JOIN players r ON r.id = gm.red_player_id
      JOIN players bl ON bl.id = gm.blue_player_id
      WHERE b.bettor_id = @pid
        AND gm.status IN ('settled', 'cancelled')
      ORDER BY b.created_at DESC
    `).all({ pid: playerId }) as unknown) as PlayerBet[];

    return NextResponse.json({
      summary: s,
      net_history: netHistory(playerId),
      gambles: gambleRows,
      bets,
	});
  } catch (error) {
    return gambleErrorResponse(error);
  }
}