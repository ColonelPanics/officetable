// GET    /api/gambling/auth — whoami: the logged-in session player (or null)
// POST   login {username, password} — reuses the player's linked Alces
//        Bookie bank credentials (exact local match against bank_accounts;
//        the bank API is never contacted here) and issues the session cookie
// DELETE logout — clears it

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { applySessionCookie, clearSessionCookie, readSessionPlayer } from '@/lib/session';
import { gambleErrorResponse } from '@/lib/gambleApi';

interface SessionPlayer {
  id: number;
  name: string;
}

function playerFor(playerId: number): SessionPlayer | undefined {
  return db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(playerId) as
    | SessionPlayer
    | undefined;
}

export async function GET() {
  try {
    const playerId = await readSessionPlayer();
    const player = playerId !== null ? (playerFor(playerId) ?? null) : null;
    return NextResponse.json({ player });
  } catch (error) {
    return gambleErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { username?: string; password?: string };
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';
    if (!username || !password) {
      return NextResponse.json({ error: 'Bank username and password are required' }, { status: 400 });
    }

    const row = db.prepare(`
      SELECT player_id FROM bank_accounts
      WHERE bank_username = ? AND bank_password = ?
    `).get(username, password) as { player_id: number } | undefined;

    if (!row) {
      return NextResponse.json({ error: 'Wrong bank username or password' }, { status: 401 });
    }
    const player = playerFor(row.player_id);
    if (!player) {
      return NextResponse.json({ error: 'Wrong bank username or password' }, { status: 401 });
    }

    const res = NextResponse.json({ player });
    applySessionCookie(res, player.id);
    return res;
  } catch (error) {
    return gambleErrorResponse(error);
  }
}

export async function DELETE() {
  const res = NextResponse.json({ player: null });
  clearSessionCookie(res);
  return res;
}