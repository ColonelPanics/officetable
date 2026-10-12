// Gambling-side sessions: a signed cookie proving who is logged in.
// Login credentials are the player's Alces Bookie bank username/password
// (exact local match against bank_accounts), so the session just says
// "this browser is logged in as player X until exp" — no session table.

import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import db from './db';

export const SESSION_COOKIE = 'ot_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

interface SessionPayload {
  p: number;
  exp: number;
}

function sessionSecret(): string {
  // Env first (never commit), settings table as generated-once fallback —
  // same precedent as the alces config in lib/alcesBank.ts.
  const fromEnv = process.env.OT_SESSION_SECRET;
  if (fromEnv) return fromEnv;
  let row = db.prepare(`SELECT value FROM settings WHERE key = 'ot_session_secret'`).get() as
    | { value: string }
    | undefined;
  if (!row?.value) {
    const generated = crypto.randomUUID().replace(/-/g, '');
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ot_session_secret', ?)`).run(generated);
    row = { value: generated };
  }
  return row.value;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

export function signSession(playerId: number): string {
  const payload = Buffer.from(
    JSON.stringify({ p: playerId, exp: Date.now() + SESSION_MAX_AGE_S * 1000 } satisfies SessionPayload)
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Player id the cookie proves, or null when absent/invalid/expired. */
export function verifySessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionPayload;
    if (!Number.isInteger(parsed.p) || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;
    return parsed.p;
  } catch {
    return null;
  }
}

/** The logged-in player id in this request's cookie jar (or null). */
export async function readSessionPlayer(): Promise<number | null> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

export function applySessionCookie(response: NextResponse, playerId: number): void {
  response.cookies.set(SESSION_COOKIE, signSession(playerId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}