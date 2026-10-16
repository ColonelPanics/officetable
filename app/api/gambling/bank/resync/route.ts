// POST /api/gambling/bank/resync — re-arm every failed mirror row and drain.
// Movements parked 'failed' (10 dead attempts) only move again when somebody
// presses this; the drainer itself never hammers the bank's API.
//
// Throttled: each press triggers one real drain, so re-arm-spamming this
// endpoint would hammer the bank's API. One re-arm per minute across the
// whole app (in-memory) — a second press within the window just reports the
// backlog without touching the bank again.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { kickBankSync, bankSyncBacklog, alcesMirrorEnabled } from '@/lib/bank';
import { gambleErrorResponse, requirePlayerId, requireSessionPlayer } from '@/lib/gambleApi';

const RESYNC_COOLDOWN_MS = 60 * 1000;
let lastResyncAt = 0;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { player_id?: number | string };
    const playerId = requirePlayerId(body.player_id);
    await requireSessionPlayer(playerId); // resync moves their money to the bank
    if (!alcesMirrorEnabled()) {
      return NextResponse.json({ error: 'Central bank is not configured' }, { status: 400 });
    }
    const now = Date.now();
    const cooldownRemainingMs = Math.max(0, RESYNC_COOLDOWN_MS - (now - lastResyncAt));
    if (cooldownRemainingMs === 0) {
      lastResyncAt = now;
      // Re-arm failed rows AND legacy 'unverified' ones. There is no
      // verification step any more: the drainer just re-sends whatever is
      // queued, fire-and-forget, and the bank-truth resync absorbs anything
      // the bank never accepted.
      const result = db.prepare(`
        UPDATE bank_sync SET status = 'pending', attempts = 0, error = NULL
        WHERE status IN ('failed', 'unverified')
      `).run();
      kickBankSync(); // one controlled drain; won't loop if things still fail
      return NextResponse.json({
        requeued: result.changes,
        backlog: bankSyncBacklog(),
      });
    }
    // Inside the cooldown — honest no-op, no bank traffic.
    return NextResponse.json({
      requeued: 0,
      retry_in_seconds: Math.ceil(cooldownRemainingMs / 1000),
      backlog: bankSyncBacklog(),
    });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}