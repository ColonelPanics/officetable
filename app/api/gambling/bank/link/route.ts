// POST /api/gambling/bank/link   — register or connect a player's Alces Bookie
//                                   account (money's central home; no mint here)
// POST /api/gambling/bank/unlink — disconnect it from the site player
//
// Registration is MANUAL per user decision: a player either has the site
// create a fresh bank account, or links one they already registered (e.g.
// 'AdamB' on the bank) to the player they're acting as — credentials for
// future transfers are stored server-side and never returned here.

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  linkBankAccount,
  unlinkBankAccount,
  kickBankSync,
} from '@/lib/bank';
import {
  validateBankUsername,
  validateBankPassword,
  resetAlcesBreaker,
} from '@/lib/alcesBank';
import { gambleErrorResponse, requirePlayerId, requireSessionPlayer } from '@/lib/gambleApi';
import { applySessionCookie } from '@/lib/session';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      player_id?: number | string;
      action?: string;
      username?: string;
      password?: string;
    };
    const playerId = requirePlayerId(body.player_id);
    const action = body.action === 'create' ? 'create' : body.action === 'link' ? 'link' : null;
    if (!action) {
      return NextResponse.json({ error: "action must be 'create' or 'link'" }, { status: 400 });
    }
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';
    const usernameError = validateBankUsername(username);
    const passwordError = validateBankPassword(password);
    if (usernameError || passwordError) {
      return NextResponse.json({ error: usernameError ?? passwordError }, { status: 400 });
    }

    // Knowing the bank username + password IS the authorisation here (the same
    // credential proof our login uses) — so linking/connecting is allowed while
    // logged out, including re-linking an already-linked profile. Unlink
    // (DELETE) still needs the owner's session; a successful link logs the
    // browser in as this profile.

    // One bank account belongs to one site player
    const taken = db.prepare(`
      SELECT player_id FROM bank_accounts WHERE bank_username = ? AND player_id != ?
    `).get(username, playerId) as { player_id: number } | undefined;
    if (taken) {
      return NextResponse.json(
        { error: 'That bank account is already linked to another player' },
        { status: 409 },
      );
    }

    // Name-collision courtesy was removed: the bank itself is the source of
    // truth for a taken username (204 on register, 409 when taken) and the
    // guess here wrongly blocked legitimate first-time registrations.

    try {
      // The user clicked this on purpose — it always gets a real attempt,
      // even mid-outage-backoff (the breaker only shields background syncs).
      resetAlcesBreaker();
      const { balance } = await linkBankAccount(playerId, action, username, password);
      kickBankSync();
      // Auto-login: the creds just registered on the bank ARE the site login.
      const res = NextResponse.json({ player_id: playerId, bank_username: username, balance });
      applySessionCookie(res, playerId);
      return res;
    } catch (e) {
      // Map EVERY bank failure to a readable message — including the ones
      // surfacing from lib/bank's own wrappers. Duck-type the code so no
      // error class identity issue can turn this into an opaque 500.
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string })?.code;
      if (code === 'already_taken') {
        return NextResponse.json({ error: 'That bank username is already taken — either pick another or use "Link existing account"', code }, { status: 409 });
      }
      if (code === 'unauthorised') {
        return NextResponse.json({ error: 'The bank rejected that username/password', code }, { status: 401 });
      }
      if (code === 'bank_not_linked' || code === 'bank_disabled') {
        return NextResponse.json({ error: msg, code }, { status: 400 });
      }
      if (typeof code === 'string' && code) {
        return NextResponse.json({ error: msg, code }, { status: 502 });
      }
      throw e;
    }
  } catch (error) {
    return gambleErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { player_id?: number | string };
    const playerId = requirePlayerId(body.player_id);
    await requireSessionPlayer(playerId); // disconnecting needs the owner's session
    unlinkBankAccount(playerId);
    return NextResponse.json({ player_id: playerId, bank_username: null });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}