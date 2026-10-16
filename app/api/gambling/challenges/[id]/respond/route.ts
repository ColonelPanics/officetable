// POST /api/gambling/challenges/[id]/respond
// { player_id, action: 'accept' | 'decline' | 'cancel' | 'counter',
//   counter?: { entry_fee, scheduled_at, side } }
//
// Accept debits both entry fees and opens the gamble match with frozen odds.

import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { respondToChallenge, type ChallengeTermsInput } from '@/lib/gamble';
import { announceBetsOpen } from '@/lib/gambleNotifications';
import { gambleErrorResponse, requirePlayerId, requireSessionPlayer } from '@/lib/gambleApi';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const challengeId = parseInt(id, 10);
    if (!Number.isInteger(challengeId)) {
      return NextResponse.json({ error: 'Invalid challenge id' }, { status: 400 });
    }

    const body = await request.json();
    const playerId = requirePlayerId(body.player_id);
    await requireSessionPlayer(playerId); // responding moves money on accept
    const action = body.action;
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel' && action !== 'counter') {
      return NextResponse.json({ error: 'action must be accept, decline, cancel or counter' }, { status: 400 });
    }

    let counter: ChallengeTermsInput | undefined;
    if (action === 'counter') {
      if (!body.counter) {
        return NextResponse.json({ error: 'counter requires new terms' }, { status: 400 });
      }
      counter = {
        entryFee: parseInt(String(body.counter.entry_fee), 10),
        scheduledAt: String(body.counter.scheduled_at ?? ''),
        side: body.counter.side === 'blue' ? 'blue' : 'red',
        payoutLine: typeof body.counter.payout_line === 'string' ? body.counter.payout_line : undefined,
        specialRules: body.counter.special_rules != null ? String(body.counter.special_rules) : undefined,
      };
    }

    const result = respondToChallenge(
      challengeId, playerId, action, counter,
      body.claim_side === 'red' || body.claim_side === 'blue' ? body.claim_side : undefined
    );

    if (action === 'accept' && result.gambleMatch && result.ladder) {
      announceBetsOpen(result.gambleMatch).catch(err => console.error('gamble announce failed:', err));
    }

    revalidatePath('/', 'layout');
    return NextResponse.json(result, { status: action === 'accept' ? 201 : 200 });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}