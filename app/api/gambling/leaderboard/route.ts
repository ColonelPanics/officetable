// GET /api/gambling/leaderboard — who's up, who's down
// Players ranked by gambling net profit. Net = every signed ledger row on a
// player's account except free money ('seed'/'topup'); refunds cancel their
// stake/fee, so cancelled gambles don't move anyone. House rows (player_id
// IS NULL — the house fee + pot cut) are reported as the casino's P&L.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getBank, seedBalance, alcesMirrorEnabled, netHistory, autoReconcileBalances } from '@/lib/bank';
import { gambleErrorResponse } from '@/lib/gambleApi';

interface GamblerRow {
  player_id: number;
  name: string;
  avatar_url?: string | null;
  balance: number;
  net: number;
  wagered: number;
  bets_won: number;
  bets_lost: number;
  gambles_played: number;
  retired?: number;
  last_match_at?: string | null;
  is_inactive?: boolean;
}

const SQL = `
  SELECT p.id as player_id, p.name, p.avatar_url, p.status = 'retired' as retired,
    COALESCE(bal.balance, ${seedBalance()}) as balance,
    COALESCE(pl.net, 0) as net,
    COALESCE(pl.wagered, 0) as wagered,
    COALESCE(bb.won, 0) as bets_won,
    COALESCE(bb.lost, 0) as bets_lost,
    (SELECT COUNT(*) FROM gamble_matches gm
      WHERE gm.status = 'settled' AND (gm.red_player_id = p.id OR gm.blue_player_id = p.id)
    ) as gambles_played,
    lm.last_match_at
  FROM players p
  LEFT JOIN bank_accounts bal ON bal.player_id = p.id
  LEFT JOIN (
    SELECT player_id,
           SUM(amount) as net,
           SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as wagered
    FROM bank_transactions
    WHERE ref_type NOT IN ('topup', 'seed', 'resync')
    GROUP BY player_id
  ) pl ON pl.player_id = p.id
  LEFT JOIN (
    SELECT bettor_id,
           SUM(status = 'won') as won,
           SUM(status = 'lost') as lost
    FROM bets
    GROUP BY bettor_id
  ) bb ON bb.bettor_id = p.id
  LEFT JOIN (
    -- Last match they played, any game — same inactivity rule as the office
    -- leaderboard (no match within inactive_threshold_days ⇒ inactive).
    SELECT mp.player_id, MAX(m.played_at) as last_match_at
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    GROUP BY mp.player_id
  ) lm ON lm.player_id = p.id
`;

export async function GET(request: NextRequest) {
  try {
    // Throttled truth sync (default 5 min) — the leaderboard's balance column
    // must track the bookie, especially with other apps moving the same money.
    autoReconcileBalances();
    const { searchParams } = new URL(request.url);
    const limitRaw = parseInt(searchParams.get('limit') ?? '', 10);

    // With the central bank live, only players who registered a bank account
    // are on the gambling table at all — unlinked players hold zero and never
    // appear, whatever their active/retired status.
    const linkedOnly = alcesMirrorEnabled()
      ? `WHERE p.id IN (SELECT player_id FROM bank_accounts WHERE bank_username IS NOT NULL)`
      : '';
    const rows = (db.prepare(`${SQL} ${linkedOnly} ORDER BY net DESC, balance DESC`).all() as unknown) as GamblerRow[];

    // Inactivity: same rule as the office leaderboard — no match within the
    // settings' inactive_threshold_days (default 60), none at all ⇒ inactive.
    const thresholdSetting = db.prepare(
      `SELECT value FROM settings WHERE key = 'inactive_threshold_days'`)
      .get() as { value: string } | undefined;
    const inactiveThresholdDays = thresholdSetting ? parseInt(thresholdSetting.value, 10) : 60;
    const now = Date.now();
    for (const row of rows) {
      row.is_inactive = row.last_match_at
        ? (now - new Date(row.last_match_at.replace(' ', 'T') + 'Z').getTime())
          > inactiveThresholdDays * 24 * 60 * 60 * 1000
        : true;
    }

    // The casino's own results: house-pot movements + the 10% entry fees,
    // excluding the opening float ('topup'/'seed' are free money, not P&L).
    const house = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as net FROM bank_transactions
      WHERE player_id IS NULL AND ref_type NOT IN ('topup', 'seed', 'resync')`)
      .get() as { net: number };

    const bank = getBank();
    return NextResponse.json({
      house_balance: bank.getHouseBalance(),
      house_net: house.net,
      house_history: netHistory(null),
      players: Number.isInteger(limitRaw)
        ? rows.slice(0, limitRaw)
        : rows,
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}