// Shared helpers for the gambling API routes: error → HTTP status mapping,
// the standard validation of the explicit actor (player_id) body field, and
// the session gate for money actions.

import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { GambleError } from '@/lib/gamble';
import { BankError } from '@/lib/bank';
import { readSessionPlayer } from './session';

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  unknown_game: 400,
  unknown_player: 400,
  same_player: 400,
  bad_terms: 400,
  bad_counter: 400,
  bad_stake: 400,
  bad_score: 400,
  bad_teams: 400,
  unsupported_game: 400,
  teams_mismatch: 400,
  not_negotiable: 409,
  not_your_turn: 409,
  already_settled: 409,
  already_cancelled: 409,
  bets_closed: 409,
  insufficient_funds: 409,
  not_a_participant: 403,
  participants_may_not_bet: 403,
};

/** Map lib errors to HTTP responses; centrally-bank errors too; anything else is a 500. */
export function gambleErrorResponse(error: unknown): NextResponse {
  if (error instanceof GambleError || error instanceof BankError) {
    const code = (error as GambleError).code;
    return NextResponse.json({ error: (error as Error).message, code }, { status: STATUS_BY_CODE[code] ?? 400 });
  }
  // Alces Bank errors (any bank-side failure) must read as an honest gateway
  // problem, never an opaque "Gambling operation failed".
  const maybeError = error as { code?: string; message?: string } | null;
  if (maybeError && typeof maybeError.code === 'string' && maybeError.code) {
    const status =
      maybeError.code === 'already_taken' ? 409
      : maybeError.code === 'unauthorised' ? 401
      : maybeError.code === 'not_found' ? 404
      : maybeError.code === 'insufficient_funds' ? 409
      : 502; // unreachable, service_error, anything else from the bank
    return NextResponse.json({ error: maybeError.message ?? 'Central bank error', code: maybeError.code }, { status });
  }
  console.error('gambling route error:', error);
  return NextResponse.json({ error: 'Gambling operation failed' }, { status: 500 });
}

/** Validated actor id from a body field. The actor must still be the logged-in
 *  session player for money actions — see requireSessionPlayer. */
export function requirePlayerId(value: unknown): number {
  const id = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(id)) {
    throw new GambleError('player_id is required — log in (top right) to act as a player', 'bad_actor');
  }
  const row = db.prepare(`SELECT id FROM players WHERE id = ?`).get(id) as { id: number } | undefined;
  if (!row) throw new GambleError('Unknown player', 'unknown_player');
  return id;
}

/** Session gate for every money action: the actor must be logged in and BE
 *  the session player. A free identity pick is no longer an identity. */
export async function requireSessionPlayer(actorId: number): Promise<void> {
  const sessionPlayerId = await readSessionPlayer();
  if (sessionPlayerId === null) {
    throw new GambleError(
      'You must be logged in as this player to do that — log in with your bank username and password (top right)',
      'not_logged_in',
    );
  }
  if (sessionPlayerId !== actorId) {
    throw new GambleError(
      'You are logged in as a different player — you can\'t act in someone else\'s name',
      'forbidden',
    );
  }
}

STATUS_BY_CODE['bets_still_open'] = 409;
STATUS_BY_CODE['bad_actor'] = 400;
STATUS_BY_CODE['challenge_expired'] = 409;
STATUS_BY_CODE['counter_not_allowed'] = 409;
STATUS_BY_CODE['no_open_slot'] = 409;
STATUS_BY_CODE['bank_not_linked'] = 403;
STATUS_BY_CODE['bet_exceeds_pot'] = 409;
STATUS_BY_CODE['not_logged_in'] = 403;
STATUS_BY_CODE['forbidden'] = 403;
STATUS_BY_CODE['not_settled'] = 409;
STATUS_BY_CODE['recorded_match_missing'] = 409;
STATUS_BY_CODE['score_mismatch'] = 409;