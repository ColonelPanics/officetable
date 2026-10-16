// Swappable bank for office gambling. All money is virtual moose bucks.
//
// Every mutation writes exactly one signed bank_transactions row inside the
// CALLER's better-sqlite3 transaction (lib/gamble.ts owns the transactions),
// so SUM(amount) per account always reconciles to the balance.
//
// The central bank is the Alces Bookie API (lib/alcesBank.ts) — "bank is the
// truth". The SQLite ledger remains the gambling engine's bookkeeping, and
// every PLAYER movement is mirrored out as a leg on our service pot
// (POST /services/transaction — lib/alcesBank.ts) via the bank_sync outbox.
// Legs are typed by intent, matching what the gambles do:
//   staked funds       → 'hold'    (the commitment when it is placed)
//   resolved holds     → 'return' + the real outcome leg ('loss' of the
//                        stake, 'win' of the profit — the bank manager's
//                        dance: release the hold, then book the outcome)
//   refunds            → 'return'  (a commitment handed back unspent)
//   other pot payments → 'win'     (achievement payouts, pot shares)
// Delivery is fire-and-forget: a leg either returns (great) or doesn't
// (fine — no per-attempt verification, like every other service on the
// bank). Displayed balances stay honest through the bank-truth resync
// (reconcileAlcesBalances), which turns any leg the bank never accepted
// into a ledgered balance delta instead of a stuck queue. A central-office
// bank API only needs to implement BankProvider — call sites in
// lib/gamble.ts and the routes don't change.

import db from './db';
import { decryptSecret, encryptSecret } from './crypto';
import {
  AlcesBankError,
  alcesBalance,
  alcesConfig,
  alcesMirrorEnabled,
  alcesServiceBalance,
  alcesServiceTransfer,
  listAlcesBalances,
  loginAlcesUser,
  registerAlcesUser,
} from './alcesBank';

export { alcesMirrorEnabled };

export class BankError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

/** Reference for a ledger row: what it was for, and which entity it belongs to. */
export interface BankRef {
  /** Ledger category, e.g. 'bet_stake', 'challenge_fee', 'gambler_payout'. */
  type: string;
  /** Bet id or gamble match id, where applicable. */
  id?: number | null;
  memo?: string;
}

export interface BankProvider {
  getBalance(playerId: number): number;
  getHouseBalance(): number;
  ensureAccount(playerId: number): void;
  /** Negative amount = debit. Caller owns the transaction. */
  credit(playerId: number | null, amount: number, ref: BankRef): void;
  /**
   * Debit (positive amount) without an over-balance check — caller has
   * already verified funds. Caller owns the transaction.
   */
  debit(playerId: number | null, amount: number, ref: BankRef): void;
  /** Debit with insufficient-funds guard. Throws BankError — caller owns the transaction. */
  debitChecked(playerId: number | null, amount: number, ref: BankRef): void;
  listTransactions(playerId: number | null, limit?: number): BankTransactionRow[];
}

export interface BankTransactionRow {
  id: number;
  ref_type: string;
  ref_id: number | null;
  player_id: number | null;
  amount: number;
  memo: string | null;
  created_at: string;
}

const selectBalance = db.prepare(`SELECT balance FROM bank_accounts WHERE player_id = ?`);
const selectHouseBalance = db.prepare(`SELECT balance FROM bank_house WHERE id = 1`);

/** Ledger ref types whose money reaches the bank THROUGH resolution legs
 *  rather than a row-derived mirror: settlement books 'gambler_payout' and
 *  'player_share' rows locally, but the bank sees those payouts via the
 *  release-and-settle dance of the held stake/fee (enqueueHoldResolution:
 *  release 'return', then the real 'win'/'loss'). Mirroring the rows too
 *  would pay every win twice. */
const SETTLE_RESOLVED_REFS = new Set(['gambler_payout', 'player_share']);

function writeLedger(playerId: number | null, amount: number, ref: BankRef): void {
  const result = db.prepare(`
    INSERT INTO bank_transactions (ref_type, ref_id, player_id, amount, memo)
    VALUES (?, ?, ?, ?, ?)
  `).run(ref.type, ref.id ?? null, playerId, amount, ref.memo ?? null);
  // Player movements mirror to the central bank as legs (outbox).
  // House-only rows (house_fee, pot_house_cut, house_loss) stay local — the
  // bank's pot implicitly keeps the fees and cuts as a residual.
  if (playerId !== null && alcesMirrorEnabled() && !SETTLE_RESOLVED_REFS.has(ref.type)) {
    db.prepare(`
      INSERT INTO bank_sync (transaction_id, status) VALUES (?, 'pending')
    `).run(result.lastInsertRowid);
  }
}

function adjustAccount(playerId: number, delta: number): void {
  const row = selectBalance.get(playerId) as { balance: number } | undefined;
  if (!row) {
    // Account created lazily with the default seed balance; delta applied on top.
    db.prepare(`
      INSERT INTO bank_accounts (player_id, balance) VALUES (?, ?)
      ON CONFLICT(player_id) DO UPDATE SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
    `).run(playerId, seedBalance() + delta, delta);
    return;
  }
  db.prepare(`
    UPDATE bank_accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE player_id = ?
  `).run(delta, playerId);
}

function adjustHouse(delta: number): void {
  db.prepare(`
    UPDATE bank_house SET balance = balance + ? WHERE id = 1
  `).run(delta);
}

/**
 * SQLite-backed BankProvider. player_id === null means the house account
 * (ledger rows store NULL player_id for house activity).
 */
/**
 * Mock (offline) mode mints each player 1000 locally — that IS the smoke-test
 * economy. With the central Alces bank no local mint exists: balances live on
 * the bank, so an unlinked/no-row account is simply zero.
 */
export function seedBalance(): number {
  return alcesMirrorEnabled() ? 0 : 1000;
}

const sqliteBank: BankProvider = {
  getBalance(playerId: number): number {
    const row = selectBalance.get(playerId) as { balance: number } | undefined;
    return row?.balance ?? seedBalance(); // default seed balance for unseen players
  },

  getHouseBalance(): number {
    const row = selectHouseBalance.get() as { balance: number } | undefined;
    return row?.balance ?? 0;
  },

  ensureAccount(playerId: number): void {
    db.prepare(`
      INSERT OR IGNORE INTO bank_accounts (player_id, balance) VALUES (?, ?)
    `).run(playerId, seedBalance());
  },

  credit(playerId: number | null, amount: number, ref: BankRef): void {
    if (amount <= 0) throw new BankError(`credit must be positive (got ${amount})`, 'bad_amount');
    writeLedger(playerId, amount, ref);
    if (playerId === null) adjustHouse(amount);
    else adjustAccount(playerId, amount);
  },

  debit(playerId: number | null, amount: number, ref: BankRef): void {
    if (amount <= 0) throw new BankError(`debit must be positive (got ${amount})`, 'bad_amount');
    writeLedger(playerId, -amount, ref);
    if (playerId === null) adjustHouse(-amount);
    else adjustAccount(playerId, -amount);
  },

  debitChecked(playerId: number | null, amount: number, ref: BankRef): void {
    const balance = playerId === null ? sqliteBank.getHouseBalance() : sqliteBank.getBalance(playerId);
    if (balance < amount) {
      throw new BankError(`insufficient funds: balance ${balance} < ${amount}`, 'insufficient_funds');
    }
    sqliteBank.debit(playerId, amount, ref);
  },

  listTransactions(playerId: number | null, limit = 50): BankTransactionRow[] {
    if (playerId === null) {
      return db.prepare(`
        SELECT id, ref_type, ref_id, player_id, amount, memo, created_at
        FROM bank_transactions
        WHERE player_id IS NULL
        ORDER BY id DESC LIMIT ?
      `).all(limit) as BankTransactionRow[];
    }
    return db.prepare(`
      SELECT id, ref_type, ref_id, player_id, amount, memo, created_at
      FROM bank_transactions
      WHERE player_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(playerId, limit) as BankTransactionRow[];
  },
};

export function getBank(): BankProvider {
  return sqliteBank;
}

// ============================================================
// Alces Bookie linking + outbox draining ("bank is the truth")
// ============================================================

export interface LinkedAccountInfo {
  player_id: number;
  bank_username: string | null;
  bank_linked_at: string | null;
  balance: number;
}

/** The player's central-bank account, WITHOUT the password (never leaves the server). */
export function getLinkedAccount(playerId: number): LinkedAccountInfo | null {
  const row = db.prepare(`
    SELECT player_id, bank_username, bank_linked_at, balance
    FROM bank_accounts WHERE player_id = ?
  `).get(playerId) as LinkedAccountInfo | undefined;
  return row ?? null;
}

/** Does this player hold a registered Alces Bookie account? */
export function isBankLinked(playerId: number): boolean {
  const row = db.prepare(`SELECT bank_username FROM bank_accounts WHERE player_id = ?`)
    .get(playerId) as { bank_username: string | null } | undefined;
  return !!row?.bank_username;
}

/** Guard for gambling actions that move money — callers translate the code. */
export function assertBankLinked(playerId: number): void {
  if (!alcesMirrorEnabled()) return; // offline/mock mode: local bank serves everyone
  if (!isBankLinked(playerId)) {
    throw new BankError(
      'You need to register your Alces Bookie account before betting moose bucks',
      'bank_not_linked',
    );
  }
}

/**
 * Register (action 'create') or connect (action 'link') a player's Alces
 * Bookie account and record their credentials for future transfers.
 * BOTH actions prove themselves with the bank's login handshake: a wrong
 * password is rejected here instead of poisoning the sync queue later (and
 * pot payouts can never be parked on an account that isn't the linker's).
 * Returns the account's real (bank-side) balance.
 */
export async function linkBankAccount(
  playerId: number,
  action: 'create' | 'link',
  username: string,
  password: string,
): Promise<{ balance: number }> {
  if (!alcesMirrorEnabled()) {
    throw new BankError('Central bank is not configured', 'bank_disabled');
  }
  await ensureAlcesHouse();

  if (action === 'create') {
    await registerAlcesUser(username, password); // 409 already_taken surfaces to the user
  }
  // Handshake before anything is stored: wrong creds surface right here as a
  // 401, never later as a failed transfer (or a payout into someone else's
  // account — the house pays the LINKED username).
  await loginAlcesUser(username, password);

  const balance = (await alcesBalance(username)) ?? 0;
  db.prepare(`
    INSERT INTO bank_accounts (player_id, balance, bank_username, bank_password, bank_linked_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET
      balance = excluded.balance, bank_username = excluded.bank_username,
      bank_password = excluded.bank_password, bank_linked_at = excluded.bank_linked_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(playerId, balance, username, encryptSecret(password));
  return { balance };
}

/** Disconnect the site player from their central-bank account (keeps the player). */
export function unlinkBankAccount(playerId: number): void {
  db.prepare(`
    UPDATE bank_accounts
    SET bank_username = NULL, bank_password = NULL, bank_linked_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE player_id = ?
  `).run(playerId);
}

/**
 * Boot-time bookie assets: register the site's house user on the central
 * bank if it doesn't exist (registration mints it 500 — that IS our reserve).
 */
let houseReady: Promise<void> | null = null;
export function ensureAlcesHouse(): Promise<void> {
  if (!houseReady) {
    houseReady = (async () => {
      if (!alcesMirrorEnabled()) return;
      // The house registers once-ever: the flag persists in settings so we
      // never re-POST the registration on later drains (the bank would only
      // 409 it, but each attempt is traffic the down/shared API shouldn't
      // see). Clear 'alces_house_registered' in settings to force a re-probe.
      const { houseUser, housePassword } = alcesConfig();
      if (!housePassword) throw new BankError('No house password available', 'bank_disabled');
      // The flag stores WHICH house user was registered/verified — it is
      // re-probed (idempotently) whenever ALCES_HOUSE_USER changes.
      const registeredFlag = db.prepare(`SELECT value FROM settings WHERE key = 'alces_house_registered'`)
        .get() as { value: string } | undefined;
      if (registeredFlag?.value === houseUser) return;
      try {
        await registerAlcesUser(houseUser, housePassword);
      } catch (e) {
        if (!(e instanceof AlcesBankError && e.code === 'already_taken')) throw e;
        // The bank already has this house username — but is it OURS? If its
        // password differs from this site's, every house→player payout will
        // 401 forever (silently, via the sync backlog). Prove the handshake
        // now so the site either runs or fails loudly with a fixable message.
        try {
          await loginAlcesUser(houseUser, housePassword);
        } catch {
          throw new BankError(
            `The central bank already has a house account "${houseUser}" but its password does not match this site's — every payout would fail. Set ALCES_HOUSE_PASSWORD to that account's real bank password (or point ALCES_HOUSE_USER at this site's own house account), then clear the 'alces_house_registered' setting to retry.`,
            'house_credentials_mismatch',
          );
        }
      }
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('alces_house_registered', ?)`)
        .run(houseUser);
    })().catch(e => {
      // Don't cache the failure: one bank outage must not poison every later
      // link/sync attempt until a server restart. Clear and let it retry.
      houseReady = null;
      throw e;
    });
  }
  return houseReady;
}

/** Ledger rows still waiting to reach (or that failed to reach) the central bank.
 *  'sending' rows count too: a crash can leave one mid-flight, and if nothing else
 *  is queued it must still trigger a drain (the drainer verifies before resending). */
export function bankSyncBacklog(): { pending: number; failed: number; unverified: number; sending: number } {
  const row = db.prepare(`
    SELECT SUM(status = 'pending') as pending, SUM(status = 'failed') as failed,
           SUM(status = 'unverified') as unverified, SUM(status = 'sending') as sending
    FROM bank_sync
  `).get() as { pending: number | null; failed: number | null; unverified: number | null; sending: number | null };
  return {
    pending: row.pending ?? 0,
    failed: row.failed ?? 0,
    unverified: row.unverified ?? 0,
    sending: row.sending ?? 0,
  };
}

interface SyncJob {
  id: number;
  transaction_id: number;
  legs: string | null;
}

/** One central-bank leg (a POSTed service transaction). */
export interface BankLeg {
  type: 'win' | 'loss' | 'hold' | 'return';
  amount: number;
}

const LEG_TYPES = new Set<string>(['win', 'loss', 'hold', 'return']);

/** Parse a job's stored leg plan; throws (a normal job failure) on malformed
 *  plans so the row burns out through the usual attempts instead of looping. */
function parseBankLegs(json: string): BankLeg[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BankError('bank_sync job carries a malformed leg plan', 'bad_leg_plan');
  }
  const error = new BankError('bank_sync job carries a malformed leg plan', 'bad_leg_plan');
  if (!Array.isArray(parsed) || !parsed.length) throw error;
  const legs: BankLeg[] = [];
  for (const item of parsed) {
    const { type, amount } = (item ?? {}) as Record<string, unknown>;
    if (typeof type !== 'string' || !LEG_TYPES.has(type)
      || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw error;
    legs.push({ type: type as BankLeg['type'], amount });
  }
  return legs;
}

export interface HoldResolutionOutcome {
  type: 'win' | 'loss';
  amount: number;
}

/** Queue the release-and-settle legs for a held commitment (a bet stake or
 *  an entry fee) that just RESOLVED — the bank manager's model: the hold
 *  sits on the player until the outcome is known, then it is released
 *  ('return') and the outcome books as a real 'loss' (the player pays) or
 *  'win' (the player is paid their profit on top of the release). Two jobs,
 *  one leg each, so a failure anywhere retries exactly that leg. Amounts
 *  ride on the jobs; the anchor ledger row (the commitment's own row) only
 *  ties the job to the ledger and the player's bank account. Callers are
 *  expected to be inside a db transaction so the legs land atomically with
 *  the ledger rows that describe them.
 *  Net effect under either reading of 'hold' (reservation or pot-bound
 *  transfer) is money-neutral to money-correct — see drainBankSync. */
export function enqueueHoldResolution(
  hold: { refType: string; refId: number; playerId: number; held: number },
  outcome: HoldResolutionOutcome | null,
): void {
  if (!alcesMirrorEnabled()) return; // offline/mock mode: nothing to resolve remotely
  const anchor = db.prepare(`
    SELECT id, player_id FROM bank_transactions
    WHERE ref_type = ? AND ref_id = ? AND player_id = ?
    ORDER BY id LIMIT 1
  `).get(hold.refType, hold.refId, hold.playerId) as { id: number; player_id: number } | undefined;
  if (!anchor) {
    // Anchor rows and their commitments are written in the same transaction,
    // so a missing anchor means local bookkeeping never happened either —
    // log it loudly and skip rather than break the caller's settle.
    console.error(`[bank] no ${hold.refType} row for ref ${hold.refId} player ${hold.playerId} — resolution legs skipped`);
    return;
  }
  const enqueue = db.prepare(`
    INSERT INTO bank_sync (transaction_id, status, legs) VALUES (?, 'pending', ?)
  `);
  enqueue.run(anchor.id, JSON.stringify([{ type: 'return', amount: hold.held }]));
  if (outcome && outcome.amount > 0) {
    enqueue.run(anchor.id, JSON.stringify([{ type: outcome.type, amount: outcome.amount }]));
  }
}

let draining = false;

/** A job is considered burnt after this many failed transfers; it stays
 *  'failed' for a manual/admin reset instead of hammering the bank forever. */
const MAX_SYNC_ATTEMPTS = 10;

/** Tolerance when comparing bank-side balances (they arrive as fractional
 *  strings and the bank itself is imprecise about rounding). */
const BALANCE_EPS = 0.005;

/** Map a ledger movement to its central-bank leg type:
 *   - every player DEBIT is committed stake money → 'hold' (bet stakes,
 *     gamble/entry fees) — refundable, so a refund leg can hand it back;
 *   - 'refund' credits hand committed funds back → 'return' (stake and
 *     entry-fee refunds on cancelled/voided gambles, pre-close refunds);
 *   - every other player credit is a payment from the pot → 'win'
 *     (gambler payouts, entry shares, pot winner/score shares, achievement
 *     payouts). House-only rows (player_id NULL) are never queued.
 *   - 'loss' (an instant, non-refundable player→pot charge — the verb the
 *     instant services ping) is unused here by design: a losing bet simply
 *     KEEPS its hold. The pot received the stake when it was held and the
 *     player already saw it leave their balance, so no leg describes a loss
 *     without double-charging. The win/lose status of a gamble is expressed
 *     by which legs it produced (wins for winners, bare holds for losers,
 *     returns for refunds) and every pot/player balance stays exactly in
 *     step with the local ledger.
 */
function bankLegType(refType: string, amount: number): 'win' | 'loss' | 'hold' | 'return' {
  if (amount < 0) return 'hold';
  return refType === 'refund' ? 'return' : 'win';
}

/** Push queued movements to the central bank as legs. Fire-and-forget: each
 *  row is POSTed to the bank once per drain; a 2xx marks it done, a failure
 *  marks it failed (retried on later kicks until it burns out after
 *  MAX_SYNC_ATTEMPTS). There is deliberately NO delivery verification
 *  between attempts — like every other service on the bank, we just ping
 *  the legs and trust the API; whatever never lands shows up afterwards as
 *  a balance delta in reconcileAlcesBalances ('resync' rows), not as a
 *  stuck queue. A crash leftover 'sending' row (or a legacy 'unverified'
 *  one) is simply sent again. If a leg keeps failing, check
 *  ALCES_SERVICE_TOKEN (an invalid token is a 404 NOT_FOUND "No service
 *  with that token exists" on every transfer). */
export async function drainBankSync(): Promise<void> {
  if (!alcesMirrorEnabled() || draining) return;
  draining = true;
  let progress = false;
  try {
    // Bookie legs NEVER touch the house user — the counterparty is our
    // service pot, resolved from the token. (ensureAlcesHouse stays in the
    // link path, where account registration actually needs it.)
    const jobs = db.prepare(`
      SELECT id, transaction_id, legs FROM bank_sync
      WHERE status IN ('pending', 'failed', 'sending', 'unverified')
        AND attempts < ${MAX_SYNC_ATTEMPTS}
      ORDER BY id LIMIT 25
    `).all() as SyncJob[];
    if (!jobs.length) return;
    const ledger = db.prepare(`
      SELECT ref_type, player_id, amount FROM bank_transactions WHERE id = ?
    `);
    const account = db.prepare(`
      SELECT bank_username, bank_password FROM bank_accounts WHERE player_id = ?
    `);
    const markDone = db.prepare(`
      UPDATE bank_sync SET status = 'done', error = NULL WHERE id = ?
    `);
    const markFailed = db.prepare(`
      UPDATE bank_sync SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?
    `);
    // Each job is tried AT MOST ONCE per drain; the first failure stops the
    // batch so a bad set of legs can't burn more attempts or hammer the
    // bank's API — the rest waits for the next kick.
    for (const job of jobs) {
      const tx = ledger.get(job.transaction_id) as
        { ref_type: string; player_id: number; amount: number } | undefined;
      const acct = tx
        ? (account.get(tx.player_id) as
            { bank_username: string | null; bank_password: string | null } | undefined)
        : undefined;
      try {
        if (!tx || !acct?.bank_username || !acct.bank_password) {
          throw new BankError('Player bank account unregistered', 'bank_not_linked');
        }
        // Credentials are encrypted at rest (lib/crypto.ts).
        const password = decryptSecret(acct.bank_password);
        if (!password) {
          throw new BankError('Player bank credentials cannot be decrypted', 'bank_not_linked');
        }
        // The job's leg plan: stored JSON when the legs were planned at
        // enqueue time (hold-resolution dances), else one leg derived from
        // the ledger row itself (stake → hold, refund → return, credit → win).
        const legs = job.legs
          ? parseBankLegs(job.legs)
          : [{ type: bankLegType(tx.ref_type, tx.amount), amount: Math.abs(tx.amount) }];
        for (const leg of legs) {
          if (leg.amount <= 0) continue; // a zero leg moves nothing — skip it
          const bankTxId = await alcesServiceTransfer({
            username: acct.bank_username, password,
            amount: leg.amount, type: leg.type,
          });
          if (bankTxId !== null) {
            console.log(`[bank] ledger #${job.transaction_id} mirrored as bank transaction ${bankTxId} (${leg.type} ${leg.amount})`);
          }
        }
        // Only marked done AFTER every leg of the plan went out; a failure
        // mid-plan retries the whole plan (each dance job is single-legged,
        // so plan-retries are ordinarily one leg wide anyway).
        markDone.run(job.id);
        progress = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        markFailed.run(msg, job.id);
        return;
      }
    }
  } finally {
    draining = false;
    // After a drain that moved rows, snap the projections onto the bank's
    // truth — this is the fire-and-forget safety net: whatever the bank
    // never accepted becomes a ledgered resync delta on the display, not a
    // stuck balance. (Formerly this reconcile ran INSIDE the drain, silenced
    // by this very `draining` re-entry guard — a dead call; it lives here.)
    if (progress) {
      void reconcileAlcesBalances().catch(e => console.error('post-drain resync:', e));
    }
  }
}

/** Fire-and-forget drainer kick. Nothing to move → no traffic at all. */
export function kickBankSync(): void {
  const backlog = bankSyncBacklog();
  if (backlog.pending === 0 && backlog.failed === 0 && backlog.unverified === 0 && backlog.sending === 0) return;
  void drainBankSync().catch(e => console.error('bank sync:', e));
}

/**
 * Net-over-time per OFFICIAL gamble — one that ran to settlement. Cancelled
 * gambles never count (their ledger washes to zero: fees and stakes refunded,
 * the house fee only exists at settlement) and never advance the numbering:
 * the first official gamble is gamble 1. A gamble's entry fees, stakes,
 * payouts, house cut and refunds all fold into its single net delta — no
 * jitter per individual pay. The series is prefixed with an arbitrary zero
 * point so the line visibly sets out from a net of 0.
 *
 * challenge_fee rows are tagged with the CHALLENGE id, so they map to their
 * gamble through gamble_matches.challenge_id before grouping. playerId null
 * = the house's own rows (its fees, cuts and covered losses).
 */
export function netHistory(playerId: number | null): { gamble: number | null; date: string | null; net: number }[] {
  const rows = (db.prepare(`
    SELECT bt.id, bt.amount, bt.created_at,
      CASE WHEN bt.ref_type = 'challenge_fee'
        THEN (SELECT gm.id FROM gamble_matches gm WHERE gm.challenge_id = bt.ref_id ORDER BY gm.id DESC LIMIT 1)
        ELSE bt.ref_id
      END as gamble_id
    FROM bank_transactions bt
    WHERE bt.player_id ${playerId === null ? 'IS NULL' : '= ?'}
      AND bt.ref_type NOT IN ('topup', 'seed', 'resync', 'achievement_payout')
    ORDER BY bt.id
  `).all(...(playerId === null ? [] : [playerId])) as unknown) as {
    id: number; amount: number; created_at: string; gamble_id: number | null;
  }[];

  // Only settled gambles are official — the numbering counts them alone.
  const official = new Set(
    (db.prepare(`SELECT id FROM gamble_matches WHERE status = 'settled'`).all() as { id: number }[])
      .map(r => r.id)
  );

  // First-movement order is chronological (rows themselves ordered by id)
  const order: number[] = [];
  const groups = new Map<number, { amount: number; date: string }>();
  for (const row of rows) {
    if (row.gamble_id == null || !official.has(row.gamble_id)) continue;
    let group = groups.get(row.gamble_id);
    if (!group) {
      group = { amount: 0, date: row.created_at };
      groups.set(row.gamble_id, group);
      order.push(row.gamble_id);
    }
    group.amount += row.amount;
    // a gamble's point sits at its last movement (the settlement, normally)
    if (row.created_at > group.date) group.date = row.created_at;
  }

  const history: { gamble: number | null; date: string | null; net: number }[] = [
    // the arbitrary 0 set: where the ledger starts, before any gamble
    { gamble: 0, date: null, net: 0 },
  ];
  let net = 0;
  order.forEach((id, i) => {
    net += groups.get(id)!.amount;
    history.push({ gamble: i + 1, date: groups.get(id)!.date, net });
  });
  return history;
}

/**
 * "Bank is the truth": once every movement has drained, snap the local
 * projections onto the real bank-side balances in BOTH DIRECTIONS. Other
 * apps (casino, horse races, ...) spend the same central-bank currency, so
 * the balance shown here is a bookie fact, never a site speculation — a
 * one-way (the old down-only) snap guarantees drift the moment anything
 * outside this site moves money. Every snap is ledgered as a 'resync' row
 * (excluded from gamble P&L like topup/seed) so the bank page explains its
 * own balance; sub-EPS dust snaps silently. The house pot (bank_house) is
 * engine bookkeeping — snapped both ways as before, also ledgered.
 */
export async function reconcileAlcesBalances(): Promise<void> {
  if (!alcesMirrorEnabled() || draining) return;
  const backlog = bankSyncBacklog();
  // Only block while rows are about to move (pending/sending) or parked for
  // re-arm (legacy 'unverified') — snapping while a leg is in flight would
  // tell half a story. Burnt 'failed' rows do NOT block: the bank's truth is
  // allowed to speak about legs it never accepted, and the resync delta on
  // the display documents it.
  if (backlog.pending > 0 || backlog.sending > 0 || backlog.unverified > 0) return;
  let balances: Map<string, number>;
  try {
    balances = await listAlcesBalances();
  } catch {
    return; // unreachable right now — try again on the next drain
  }
  // Also read our service pot's balance (the 2026-10 format's house truth —
  // see applyBalanceResync). A failed read just degrades to the legacy
  // house-user-only snap below.
  const potBalance = await alcesServiceBalance();
  applyBalanceResync(balances, potBalance);
}

/** Apply a bookie-truth balance snapshot to the local projections (players
 *  and house). Exported for tests; reconcileAlcesBalances is its only
 *  production caller. Every non-dust delta is ledgered as a 'resync' row
 *  (player_id NULL for the house), NOT queued to bank_sync — these rows
 *  describe movements that already exist centrally. `potBalance` is our
 *  service pot's balance (null = unreadable → house truth degrades to the
 *  legacy house-user balance alone). */
export function applyBalanceResync(balances: Map<string, number>, potBalance: number | null = null): void {
  const rows = db.prepare(`
    SELECT player_id, balance, bank_username FROM bank_accounts
    WHERE bank_username IS NOT NULL
  `).all() as { player_id: number; balance: number; bank_username: string }[];
  for (const row of rows) {
    const truth = balances.get(row.bank_username);
    if (truth === undefined) continue;
    const delta = Math.round((truth - row.balance) * 100) / 100;
    if (Math.abs(delta) < BALANCE_EPS) {
      if (delta !== 0) {
        // Dust — snap silently, no ledger row.
        db.prepare(`UPDATE bank_accounts SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE player_id = ?`)
          .run(truth, row.player_id);
      }
      continue;
    }
    db.transaction(() => {
      // Direct ledger write, deliberately NOT writeLedger: that would queue a
      // bank_sync row and the drainer would re-send this delta to the central
      // bank — but these rows only DESCRIBE movements that already happened
      // there (other apps, receipt skim, manual bookie true-ups).
      db.prepare(`
        INSERT INTO bank_transactions (ref_type, ref_id, player_id, amount, memo)
        VALUES ('resync', NULL, ?, ?, ?)
      `).run(row.player_id, delta, `resynced to bookie truth (δ ${delta > 0 ? '+' : ''}${delta.toFixed(2)}) — movements outside this site (other apps, receipt skim, manual bookie true-ups)`);
      db.prepare(`UPDATE bank_accounts SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE player_id = ?`)
        .run(truth, row.player_id);
    })();
  }
  // The house pot's central truth is the bookie SERVICE pot under the
  // 2026-10 format — stakes pay in and payouts pay out of the pot resolved
  // from our service token (GET /services/{name}). The legacy house user's
  // balance still counts alongside it: its mint and all pre-migration
  // mirrors are stranded there (nothing can move them into the pot), but
  // they remain house assets. Snap onto the combined truth so payout/bet
  // caps use the REAL bank holdings (a fresh reset otherwise shows a 0 pot
  // and blocks bets). Cheap secret-free reads throughout — resync never
  // needs to decrypt credentials (it only reads balances).
  const houseUserSetting = db.prepare(`SELECT value FROM settings WHERE key = 'alces_house_user'`).get() as { value: string } | undefined;
  const houseUser = process.env.ALCES_HOUSE_USER || houseUserSetting?.value || 'officetablehouse';
  const houseTruthRaw = balances.get(houseUser); // undefined unless the legacy house user still exists
  const houseTruth = potBalance === null
    ? houseTruthRaw // degraded legacy behaviour: house user alone
    : (houseTruthRaw ?? 0) + potBalance;
  if (houseTruth === undefined) return;
  const houseDelta = Math.round((houseTruth - sqliteBank.getHouseBalance()) * 100) / 100;
  if (Math.abs(houseDelta) < BALANCE_EPS) {
    if (houseDelta !== 0) {
      db.prepare(`UPDATE bank_house SET balance = ? WHERE id = 1`).run(houseTruth);
    }
    return;
  }
  db.transaction(() => {
    // Direct ledger write — no bank_sync (see the player-path note above).
    db.prepare(`
      INSERT INTO bank_transactions (ref_type, ref_id, player_id, amount, memo)
      VALUES ('resync', NULL, NULL, ?, ?)
    `).run(houseDelta, `house pot resynced to bookie truth (service pot${houseTruthRaw !== undefined ? ' + house user' : ''}, δ ${houseDelta > 0 ? '+' : ''}${houseDelta.toFixed(2)})`);
    db.prepare(`UPDATE bank_house SET balance = ? WHERE id = 1`).run(houseTruth);
  })();
}

/** In-memory throttle for read-path auto-reconcile (see autoReconcileBalances). */
let lastAutoReconcileAt = 0;

/** Fire-and-forget truth sync for read paths that DISPLAY balances (bank
 *  page, leaderboard). Money-moving paths reconcile immediately via the
 *  drain; reads only resync on a cooldown (settings key
 *  'balance_resync_minutes', default 5) so page views can't hammer the
 *  bookie's API. Errors are silently deferred to the next eligible call. */
export function autoReconcileBalances(): void {
  if (!alcesMirrorEnabled() || draining) return;
  const minutesStr = (db.prepare(`SELECT value FROM settings WHERE key = 'balance_resync_minutes'`).get() as { value: string } | undefined)?.value;
  const minutes = Number(minutesStr) || 5;
  const now = Date.now();
  if (now - lastAutoReconcileAt < minutes * 60_000) return;
  lastAutoReconcileAt = now;
  void reconcileAlcesBalances().catch(e => console.error('auto balance resync:', e));
}