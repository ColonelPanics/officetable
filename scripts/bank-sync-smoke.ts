// Smoke test for the unlinked-player bank rules (TODO #67):
//   - legs for unlinked players are never queued (they'd jam the drain),
//   - the drain SKIPS (drops as done-with-note) unlinked jobs instead of
//     failing and stopping the batch, so real legs behind them flow,
//   - achievement payouts to unlinked earners never move the pot at all.
//
// Run from a SCRATCH cwd so the DB it touches is that directory's
// officetable.db, never the real one. Mirror mode is FORCED ON in the
// scratch db with a dummy token, and the bank URL is pointed at a
// guaranteed-dead port so nothing can ever reach the real bookie:
//   mkdir -p /tmp/bank-sync-run && cd /tmp/bank-sync-run
//   npx --prefix /path/to/officetable tsx /path/to/officetable/scripts/bank-sync-smoke.ts

process.env.ALCES_BANK_URL = 'http://127.0.0.1:1'; // dead port — belt and braces

import db from '../lib/db';
import { encryptSecret } from '../lib/crypto';
import { getBank, drainBankSync, bankSyncBacklog } from '../lib/bank';
import { saveAchievements, ACHIEVEMENT_PAYOUT } from '../lib/achievements';

function assert(cond: boolean, label: string): void {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok: ${label}`);
}

// Force the mirror on in the SCRATCH db with a dummy token (the real bank URL
// is overridden to a dead port above; the tested paths never dial it).
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('alces_service_token', ?)`)
  .run(encryptSecret('dummy-smoke-token'));

const bank = getBank();

// Two players + a match row for achievement results; BOTH unlinked first.
db.exec(`INSERT OR IGNORE INTO games (id, name, score_type, score_value) VALUES (1, 'Foosball', 'best_of', 10)`);
const a = db.prepare('INSERT INTO players (name) VALUES (?)').run('SyncA').lastInsertRowid as number;
const b = db.prepare('INSERT INTO players (name) VALUES (?)').run('SyncB').lastInsertRowid as number;
const matchId = db.prepare('INSERT INTO matches (game_id) VALUES (1)').run().lastInsertRowid as number;
bank.ensureAccount(a);
bank.ensureAccount(b);

// Fat pot so achievement payouts have cash to skip
db.prepare(`INSERT INTO bank_house (id, balance) VALUES (1, 100000)
  ON CONFLICT(id) DO UPDATE SET balance = 100000`).run();

async function main(): Promise<void> {
  // --- 1. movement for an UNLINKED player: ledger row stays local, no queue ---
  {
    const before = bankSyncBacklog();
    bank.credit(a, 5, { type: 'achievement_payout', id: matchId, memo: 'unlinked credit' });
    const after = bankSyncBacklog();
    assert(after.pending === before.pending, 'unlinked movement queues NOTHING');
    assert(bank.getBalance(a) === 5, 'unlinked movement still books locally');
  }

  // --- 2. LINK the player: same movement now queues a leg ---
  {
    db.prepare(`UPDATE bank_accounts SET bank_username = 'SyncA', bank_password = ? WHERE player_id = ?`)
      .run(encryptSecret('pw'), a);
    const before = bankSyncBacklog();
    bank.credit(a, 5, { type: 'achievement_payout', id: matchId, memo: 'linked credit' });
    const after = bankSyncBacklog();
    assert(after.pending === before.pending + 1, 'linked movement queues a leg');
  }

  // --- 3. achievement payouts: unlinked earner skipped, pot untouched; linked earner pays ---
  {
    const potBefore = bank.getHouseBalance();
    // b is still unlinked
    const paid = saveAchievements([
      { achievementName: 'marathon', playerId: a, matchId },
      { achievementName: 'marathon', playerId: b, matchId },
    ], 1, 0, { payFromPot: true });
    assert(!paid.has(b), 'unlinked earner is not paid and not reported');
    assert(paid.get(a) === ACHIEVEMENT_PAYOUT, 'linked earner still paid');
    assert(
      bank.getHouseBalance() === potBefore - ACHIEVEMENT_PAYOUT,
      'the pot only ever loses the LINKED earner\'s payout',
    );
  }

  // --- 4. the drain: a job whose player has since UNLINKED is dropped as
  // done-with-note (never dialled, never failed) and the batch keeps flowing
  // on unlinked jobs — none of them may reach the dead-port bank (proven by·5) ---
  {
    // a is linked with queued legs (from §2/§3); queue one more, then unlink:
    // all of a's pending jobs become unsendable legacy rows.
    bank.credit(a, 5, { type: 'achievement_payout', id: matchId, memo: 'unlink later probe' });
    const pendingBefore = (db.prepare(`SELECT COUNT(*) as c FROM bank_sync WHERE status = 'pending'`).get() as { c: number }).c;
    assert(pendingBefore >= 3, `legacy unlinked jobs queued (${pendingBefore})`);

    db.prepare(`UPDATE bank_accounts SET bank_username = NULL, bank_password = NULL WHERE player_id = ?`).run(a);
    await drainBankSync();

    const states = db.prepare(`
      SELECT status, error FROM bank_sync
      WHERE transaction_id IN (SELECT id FROM bank_transactions WHERE player_id = ?)
    `).all(a) as { status: string; error: string | null }[];
    assert(states.length >= 3, 'all of a’s jobs observed');
    assert(
      states.every(s => s.status === 'done') && states.every(s => s.error?.includes('skipped')),
      'unlinked jobs dropped as done-with-note (never failed, never sent)',
    );
    // a's local ledger stays intact (the movement keeps its local row)
    assert(bank.getBalance(a) === 20, 'local bookkeeping for unlinked rows untouched by the skip');
  }

  // --- 5. attempts hygiene: skipped jobs don't burn MAX_SYNC_ATTEMPTS ---
  {
    const burnt = db.prepare(`SELECT COUNT(*) as c FROM bank_sync WHERE status = 'failed'`).get() as { c: number };
    assert(burnt.c === 0, 'no job ever entered the failed state (nothing dialled the dead port)');
  }

  console.log(process.exitCode ? 'BANK SYNC SMOKE FAILED' : 'BANK SYNC SMOKE OK');
}

main().catch(e => { console.error(e); process.exit(1); });