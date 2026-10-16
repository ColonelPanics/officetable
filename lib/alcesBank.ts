// Alces Bookie — the office's shared central bank (all money virtual).
//
// http://10.151.0.85:3000/api/v1 — see /api/v1/docs (Scalar/OpenAPI).
// The site is a bookie on this bank: players register their OWN accounts
// (manually — the bank mints 500 at signup, so it is the money's truth), and
// every movement the gambling engine makes is mirrored here as a real
// player↔bookie-pot transfer through outbox rows (lib/bank.ts bank_sync).
//
// Probed behaviour worth remembering (migrated to the bank's 2026-10 API):
//  - Balances are only readable via GET /users pagination (strings, can be
//    fractional); GET /users/{username} answers 204 with no body.
//  - Plain user-to-user transfers are now POST /users/transaction/{recipient}
//    and authenticate as the SENDER in the body {username, password, amount}.
//    The old POST /transactions/{username} is GONE from the bank's API.
//  - Bookie transfers are POST /services/transaction, body {username,
//    password, serviceToken, amount, type}. They authenticate as the PLAYER
//    and have NO recipient: the counterparty is OUR SERVICE'S POT, resolved
//    from the token (readable via GET /services/{name}). `type` picks the
//    direction — 'loss' = the player pays the pot (stake/debit), 'win' = the
//    pot pays the player (payout/credit). The old
//    POST /transactions/service/{username} is deprecated but still live.
//  - Fees: receipts into an account are skimmed and the skim shows up
//    between ledger rows (NOT in a row's before/after) — ~1% under the new
//    service endpoint (probed: a 20-buck receipt lost 0.2), ~2% on the
//    deprecated service endpoint, ~5% plain. Balance-verified retries need
//    fee slack on skimmed sides.
//  - Errors: bad creds → 401 UNAUTHORISED, not enough money → 400
//    BAD_REQUEST "… does not have enough to send …", duplicate user → 409
//    CONFLICTING_RESOURCE, missing user → 404 NOT_FOUND, and a bad
//    serviceToken → 404 NOT_FOUND "No service with that token exists"
//    (NOT the 500 the old bank version answered with).

import db from './db';
import { decryptSecret, encryptSecret } from './crypto';

const DEFAULT_URL = 'http://10.151.0.85:3000/api/v1';

export class AlcesBankError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export interface AlcesConfig {
  baseUrl: string;
  serviceToken: string | null;
  serviceName: string;
  houseUser: string;
  housePassword: string | null;
}

function setting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value || undefined;
}

/** Secrets stored in the settings table are encrypted at rest (see lib/crypto.ts). */
function secretSetting(key: string): string | undefined {
  return decryptSecret(setting(key)) ?? undefined;
}

function setSecretSetting(key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, encryptSecret(value));
}

export function alcesConfig(): AlcesConfig {
  // Env first (never commit secrets), settings table as encrypted fallback.
  const serviceToken = envStr('ALCES_SERVICE_TOKEN') ?? secretSetting('alces_service_token') ?? null;
  let housePassword = envStr('ALCES_HOUSE_PASSWORD') ?? secretSetting('alces_house_password') ?? null;
  if (serviceToken && !secretSetting('alces_service_token')) {
    setSecretSetting('alces_service_token', serviceToken);
  }
  if (!housePassword && serviceToken) {
    // The house is the site's own bank user; its password is generated once
    // and kept (encrypted) in settings — it must never change under the ledger.
    housePassword = generateHousePassword();
    setSecretSetting('alces_house_password', housePassword);
  }
  // The bank caps passwords at 30 chars; an older generation scheme stored a
  // 35-char one that the bank can never accept (register always 400s). The
  // house user is minted by whatever registration finally succeeds, so a
  // regenerate-once here is safe.
  if (housePassword && housePassword.length > PASSWORD_MAX) {
    housePassword = generateHousePassword();
    setSecretSetting('alces_house_password', housePassword);
  }
  return {
    baseUrl: (envStr('ALCES_BANK_URL') ?? setting('alces_bank_url') ?? DEFAULT_URL).replace(/\/$/, ''),
    serviceToken,
    serviceName: envStr('ALCES_SERVICE_NAME') ?? setting('alces_service_name') ?? 'officetable',
    houseUser: envStr('ALCES_HOUSE_USER') ?? setting('alces_house_user') ?? 'officetablehouse',
    housePassword,
  };
}

/** Mirror is on when the app has its bookie service token. */
export function alcesMirrorEnabled(): boolean {
  return alcesConfig().serviceToken !== null;
}

const USERNAME_MIN = 4;
const USERNAME_MAX = 25;
const PASSWORD_MAX = 30;

/** Env var → undefined when unset OR empty/whitespace. Empty-string values
 *  must never count as configured (an empty token would "enable" the mirror
 *  and then fail every transfer). */
function envStr(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : (value.trim() || undefined);
}

function generateHousePassword(): string {
  return `ot-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Suggested bank username for a player: their name flattened ("Adam B" → "AdamB"). */
export function suggestBankUsername(name: string, playerId: number): string {
  const slug = name.replace(/[^A-Za-z0-9]/g, '').slice(0, USERNAME_MAX);
  if (slug.length < USERNAME_MIN) return `ot_${playerId}`;
  return slug;
}

export function validateBankUsername(username: string): string | null {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return `Bank username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`;
  }
  if (!/^[\w-]+$/.test(username)) return 'Bank username may only contain letters, numbers, _ and -';
  return null;
}

export function validateBankPassword(password: string): string | null {
  if (password.length < 4 || password.length > 30) return 'Bank password must be 4-30 characters';
  return null;
}

type Rest = {
  status: number;
  body: { error?: string; message?: string } & Record<string, unknown>;
};

// Circuit breaker: when the bank VM is down, stop hammering it — remember the
// outage for a couple of minutes and fail fast (still 'unreachable') until
// then. The next attempt after the cooldown reconnects automatically.
let downUntil = 0;
const OUTAGE_BACKOFF_MS = 30 * 1000;
export const alcesBankDownUntil = (): number => downUntil;

/** Let a user-initiated attempt bypass the outage backoff entirely. */
export function resetAlcesBreaker(): void {
  downUntil = 0;
}

async function alcesRequest(path: string, init?: RequestInit): Promise<Rest> {
  const { baseUrl } = alcesConfig();
  if (Date.now() < downUntil) {
    throw new AlcesBankError(`Alces bank is down right now (${baseUrl}) — retrying soon`, 'unreachable');
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    downUntil = Date.now() + OUTAGE_BACKOFF_MS;
    throw new AlcesBankError(`Alces bank unreachable at ${baseUrl}`, 'unreachable');
  }
  let body: Rest['body'] | null = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { body = JSON.parse(text); } catch { body = { message: text }; }
  }
  if (res.ok) return { status: res.status, body: body ?? {} };
  // The bank's own error envelope varies (the new VM has answered with an
  // object/absent 'error' field before) — never trust its shape.
  const rawErr = (body?.error as unknown) ?? 'SERVICE_ERROR';
  const errCode = typeof rawErr === 'string' && rawErr ? rawErr.toUpperCase() : 'SERVICE_ERROR';
  if (errCode === 'UNAUTHORISED') {
    throw new AlcesBankError(`Wrong bank username or password`, 'unauthorised');
  }
  if (errCode === 'CONFLICTING_RESOURCE') {
    throw new AlcesBankError(`That bank username is already taken`, 'already_taken');
  }
  if (errCode === 'NOT_FOUND') {
    throw new AlcesBankError(`That bank account does not exist`, 'not_found');
  }
  if (errCode === 'BAD_REQUEST' && /does not have enough/.test((body?.message as string) ?? '')) {
    throw new AlcesBankError((body?.message as string) ?? 'Not enough moose bucks', 'insufficient_funds');
  }
  const msg = typeof body?.message === 'string' && body.message
    ? body.message
    : `Alces bank request failed (HTTP ${res.status}${body ? `: ${JSON.stringify(body).slice(0, 200)}` : ''})`;
  throw new AlcesBankError(msg, errCode.toLowerCase() || 'service_error');
}

/** Register a new bank user (mints them 500 moose bucks). 204 on success. */
export async function registerAlcesUser(username: string, password: string): Promise<void> {
  await alcesRequest('/users', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/**
 * Credential handshake: prove username/password actually log in to the bank.
 * Used at link time so a wrong password can never quietly poison the sync
 * queue, and misdirected payouts can't be parked on someone else's account.
 * Throws AlcesBankError('unauthorised') on bad creds.
 */
export async function loginAlcesUser(username: string, password: string): Promise<void> {
  await alcesRequest('/users/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** All bank users with balances, following pagination. Hard page cap so a
 *  malformed/huge totalPages from the bank can never turn one call into an
 *  endless request loop against its API. */
const MAX_BALANCE_PAGES = 20; // 20 × 100 users
export async function listAlcesBalances(): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  let page = 1;
  for (;;) {
    const { body } = await alcesRequest(`/users?page=${page}&limit=100`);
    const data = body.data as { username: string; balance: string }[] | undefined;
    for (const u of data ?? []) balances.set(u.username, parseFloat(u.balance));
    const totalPagesRaw = body.totalPages;
    const totalPages = typeof totalPagesRaw === 'number' && Number.isInteger(totalPagesRaw) && totalPagesRaw > 0
      ? Math.min(totalPagesRaw, MAX_BALANCE_PAGES)
      : 1; // never trust the shape — a bad answer ends pagination after page 1
    if (!data?.length || page >= totalPages) break;
    page++;
  }
  return balances;
}

export async function alcesBalance(username: string): Promise<number | null> {
  const balances = await listAlcesBalances();
  return balances.get(username) ?? null;
}

/** Delete a bank user (cleanup of probe/test accounts; needs their password). */
export async function deleteAlcesUser(username: string, password: string): Promise<void> {
  await alcesRequest('/users', {
    method: 'DELETE',
    body: JSON.stringify({ username, password }),
  });
}

export interface ServiceTransferOpts {
  /** The player's bank account — BOTH legs authenticate as the player.
   *  (The pot has no credentials and is resolved from the service token.) */
  username: string;
  password: string;
  /** Positive transfer amount; the bank rejects < 1. */
  amount: number;
  /** Direction: 'loss' = the player pays the pot (stake/debit),
   *  'win' = the pot pays the player (payout/credit). */
  type: 'win' | 'loss';
}

/** One bookie transfer through our service pot: POST /services/transaction.
 *  204 on success; the money moves player↔pot under our service's ledger,
 *  and the pot's balance is readable via GET /services/{name}.
 *
 *  There is deliberately NO fallback to the plain endpoint on service errors:
 *  a service failure may mean "nothing moved" or "moved but the response was
 *  lost" — automatically re-sending on the plain path would double-send in
 *  the second case. Service-path failures instead fail the sync job, and the
 *  drain's balance-verified retry (drainBankSync) re-sends only after
 *  proving on the bank's balances that the first attempt never landed. If
 *  this fires repeatedly, check ALCES_SERVICE_TOKEN (an invalid token is a
 *  404 NOT_FOUND "No service with that token exists" on every transfer). */
export async function alcesServiceTransfer({ username, password, amount, type }: ServiceTransferOpts): Promise<void> {
  const { serviceToken } = alcesConfig();
  if (!serviceToken) {
    // Mirror shouldn't be enabled without a token, but stay honest if it flips off.
    throw new AlcesBankError('Bookie service token is not configured', 'no_service_token');
  }
  try {
    await alcesRequest('/services/transaction', {
      method: 'POST',
      body: JSON.stringify({ username, password, serviceToken, amount, type }),
    });
  } catch (e) {
    // Distinguish the two 404s this endpoint answers (probed): the TOKEN's
    // 404 reads "No service with that token exists", while a missing PLAYER
    // reads "No user with the username … exists". Only the first means every
    // transfer will fail; the second is one unregistered account — the sync
    // retries it once that account is registered on the bank.
    if (e instanceof AlcesBankError && e.code === 'not_found') {
      if (/No service/i.test(e.message)) {
        throw new AlcesBankError(
          'The bank does not recognise this site\'s service token — every transfer will fail. Fix ALCES_SERVICE_TOKEN (404 "No service with that token exists").',
          'bad_service_token',
        );
      }
      throw e;
    }
    throw e;
  }
}

/** Plain sender→recipient transfer: POST /users/transaction/{recipient}.
 *  Replaces the removed POST /transactions/{username}; used only as the
 *  tokenless fallback in the drain (the bank skims ~5% on this path). */
export async function alcesPlainTransfer(toUser: string, fromUser: string, fromPassword: string, amount: number): Promise<void> {
  await alcesRequest(`/users/transaction/${toUser}`, {
    method: 'POST',
    body: JSON.stringify({ username: fromUser, password: fromPassword, amount }),
  });
}

/** Our service pot's balance at the bank (GET /services/{name}) — the truth
 *  the payout legs settle against and drain payouts verify against.
 *  Resolves null when the bank is unreachable or the answer is malformed;
 *  callers must treat null as "cannot verify / do not send". */
export async function alcesServiceBalance(): Promise<number | null> {
  const { serviceName } = alcesConfig();
  try {
    const { body } = await alcesRequest(`/services/${serviceName}`);
    const balance = body?.balance as unknown;
    if (typeof balance === 'number' && Number.isFinite(balance)) return balance;
    if (typeof balance === 'string' && balance !== '' && Number.isFinite(parseFloat(balance))) return parseFloat(balance);
    return null;
  } catch {
    return null; // unreachable right now (or service vanished) — caller backs off
  }
}