// GET  /api/gambling/bank?player_id=  — balance + ledger for a player (or the
//      house when player_id is omitted/house=1); player_id adds the player's
//      central-bank (Alces Bookie) link status — NEVER their stored password.
//
// There is deliberately NO top-up/withdraw endpoint: the site has no mint —
// the central Alces Bookie bank controls real balances, and site movements
// are earned through challenges, bets and settlements.

import { NextRequest, NextResponse } from 'next/server';
import { getBank, bankSyncBacklog, getLinkedAccount, alcesMirrorEnabled, autoReconcileBalances } from '@/lib/bank';
import { gambleErrorResponse, requirePlayerId } from '@/lib/gambleApi';

const bank = getBank();

export async function GET(request: NextRequest) {
  try {
    // Truth sync for the display — throttled (default 5 min) so page views
    // can't hammer the bookie; money movements reconcile immediately anyway.
    // Fire-and-forget: this response may still show the previous snapshot;
    // the next refresh shows the resynced numbers.
    autoReconcileBalances();
    const { searchParams } = new URL(request.url);
    const playerIdRaw = searchParams.get('player_id');

    if (playerIdRaw === null || playerIdRaw === 'house') {
      return NextResponse.json({
        house_balance: bank.getHouseBalance(),
        transactions: bank.listTransactions(null),
      });
    }

    const playerId = requirePlayerId(playerIdRaw);
    const linked = getLinkedAccount(playerId);
    return NextResponse.json({
      player_id: playerId,
      balance: bank.getBalance(playerId),
      transactions: bank.listTransactions(playerId),
      house_balance: bank.getHouseBalance(),
      mirror_enabled: alcesMirrorEnabled(),
      linked_account: linked ? {
        bank_username: linked.bank_username,
        bank_linked_at: linked.bank_linked_at,
      } : null,
      bank_username: linked?.bank_username ?? null,
      sync_backlog: alcesMirrorEnabled() ? bankSyncBacklog() : null,
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}