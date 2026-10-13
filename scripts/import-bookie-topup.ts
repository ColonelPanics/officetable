/**
 * Import a bookie true-up into the site's projection of a player's balance.
 *
 * Usage:
 *   npx tsx scripts/import-bookie-topup.ts <player_name> <bookie_central_balance> [--dry-run] [--memo "..."]
 *   npx tsx scripts/import-bookie-topup.ts stuts 380
 *
 * Why this exists: "bank is the truth" and the running app now resyncs its
 * balance projections BOTH ways with the central bookie automatically
 * (applyBalanceResync — fired after every drain and from balance-display
 * reads on a cooldown, ledgered as 'resync' rows). So on the live server
 * this script is usually redundant — the truth imports itself on the next
 * drain or throttled read-path resync. It remains useful for hand-copied
 * databases and for a labelled one-off import row. It writes a 'topup'
 * ledger row (excluded from P&L like topup/seed/resync) and does NOT queue
 * a bank_sync row: the movement already exists at the bookie — re-pushing
 * it would double-send.
 *
 * Negative gaps: no ledger row — the downward part of the reconcile snap
 * absorbs them automatically on the next drain (book the clawback with the
 * bookie out-of-band, then let the snap pull the projection down).
 *
 * Get <bookie_central_balance> from the Alces Bookie admin (the player's
 * real bank-side balance).
 */
import db from '../lib/db';

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  let playerArg: string | undefined;
  let truthStr: string | undefined;
  let memo = 'bookie out-of-band true-up';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--memo') memo = args[++i] ?? memo;
    else if (args[i] === '--dry-run') { /* flag */ }
    else if (playerArg === undefined) playerArg = args[i];
    else truthStr ??= args[i];
  }
  const truth = Number.parseFloat(truthStr ?? '');
  // Cheap mirror-mode check that never decrypts anything: the token via env,
  // or merely the EXISTENCE of the settings row (this script touches no bank
  // credentials — mirror matters here only to guard mock mode).
  const mirror = !!process.env.ALCES_SERVICE_TOKEN
    || !!db.prepare(`SELECT 1 as x FROM settings WHERE key = 'alces_service_token'`).get();

  if (!playerArg || !Number.isFinite(truth)) {
    console.error('Usage: npx tsx scripts/import-bookie-topup.ts <player_name> <bookie_central_balance> [--dry-run] [--memo "..."]');
    console.error('       (bookie_central_balance = the player\'s REAL Alces Bookie balance)');
    process.exit(1);
  }

  if (!mirror) {
    console.error('Central Alces bank is not configured (mock mode) — the local ledger IS the truth; nothing to import.');
    process.exit(1);
  }

  const player = db.prepare(`SELECT id, name FROM players WHERE name = ?`).get(playerArg) as { id: number; name: string } | undefined;
  if (!player) {
    console.error(`Unknown player "${playerArg}". Names:`,
      (db.prepare(`SELECT name FROM players ORDER BY name`).all() as { name: string }[]).map(p => p.name).join(', '));
    process.exit(1);
  }

  const account = db.prepare(`SELECT balance FROM bank_accounts WHERE player_id = ?`).get(player.id) as { balance: number } | undefined;
  const local = account?.balance ?? 0;
  const delta = Math.round((truth - local) * 100) / 100;

  console.log(`${player.name}: site projection ${local.toFixed(2)} vs bookie central ${truth.toFixed(2)}`);

  if (delta <= 0) {
    // Downward-only reconcile already pulls the projection down to the
    // bookie's number on the next drain — nothing to ledger here.
    console.log(`Delta ${delta.toFixed(2)} — no import needed: the site's downward-only reconcile snap pulls the projection down to the bookie's number automatically.`);
    if (!account) {
      console.log('(No local account row exists for this player — they will appear on the gambling table once they register/link their Alces account.)');
    }
    process.exit(0);
  }

  console.log(`Importing topup row: +${delta.toFixed(2)} → balance ${truth.toFixed(2)} (ledgered, NOT re-pushed to the bank, excluded from P&L).`);
  if (dryRun) {
    console.log('--dry-run: nothing written.');
    process.exit(0);
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO bank_transactions (ref_type, ref_id, player_id, amount, memo)
      VALUES ('topup', NULL, ?, ?, ?)
    `).run(player.id, delta, memo);
    // Direct projection adjust — deliberately NOT writeLedger (that would
    // queue a bank_sync row and re-send money that is already at the bank).
    db.prepare(`
      UPDATE bank_accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE player_id = ?
    `).run(delta, player.id);
  })();

  console.log(`Done: ${player.name} now at ${truth.toFixed(2)} on the site — matching the bookie.`);
}

main();
