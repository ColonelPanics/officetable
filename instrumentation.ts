/**
 * Next.js instrumentation: runs once per server start before the app serves
 * requests. Used to kick off background jobs that have no natural request
 * trigger — like the season-hype scheduler (no cron required).
 */
export async function register() {
  // The hype scheduler needs better-sqlite3, so only run on the Node.js
  // runtime (not Edge middleware, where it would fail to load).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { alcesMirrorEnabled } = await import('./lib/bank');
  if (!alcesMirrorEnabled()) {
    // Loud, every boot: in mock mode the site runs its OWN local mint
    // (players are seeded 1000 and nothing reaches the Alces Bookie). That
    // is fine for a distributed/dev copy, but it must never be mistaken
    // for the real bookie-backed economy.
    console.warn('!'.repeat(78));
    console.warn('[bank] MOCK MODE — no ALCES_SERVICE_TOKEN configured.');
    console.warn('[bank] This site is running its OWN LOCAL MINT (players seeded 1000 each)');
    console.warn('[bank] and NOTHING reaches the Alces Bookie central bank.');
    console.warn('[bank] Fine for dev/demos — MUST NOT serve real play in production.');
    console.warn('!'.repeat(78));
  }

  const { startSeasonHypeScheduler } = await import('./lib/seasonHype');
  startSeasonHypeScheduler();

  // One-off stabilised recalculation of achievements. The achievement engine
  // now ranks only the ladder as each match's own moment saw it (retired and
  // inactive players excluded, board values rebuilt from match history) and
  // stamps earned_at from the match timestamp — so this re-derives every
  // historical achievement deterministically (and pays nothing; payouts only
  // happen on live recording). Guarded by a settings flag so it runs once.
  try {
    const db = (await import('./lib/db')).default;
    const flag = 'achievements_roster_recalc_v1';
    const done = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(flag);
    if (!done) {
      const { recalculateAllAchievements } = await import('./lib/achievements');
      const results = recalculateAllAchievements();
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
        .run(flag, new Date().toISOString());
      const summary = results
        .map(r => `${r.game_name}: ${r.achievements_awarded} across ${r.matches_processed} matches`)
        .join(', ');
      console.log(`[achievements] one-off stabilised recalculation complete — ${summary}`);
    }
  } catch (e) {
    console.error('[achievements] one-off recalculation failed (will not block boot):', e);
  }
}