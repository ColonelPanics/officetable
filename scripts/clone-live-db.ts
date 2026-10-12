/**
 * Clone the live site's database into a local officetable.db by walking the
 * public read API (no SSH needed):
 *   /api/games, /api/players, /api/matches (paginated, full participants).
 *
 * Matches are REPLAYED chronologically through processMatch, which recomputes
 * Elo, season ledgers and achievements with the app's own algorithm — same
 * numbers, fresh local match ids. Live player/game ids are preserved.
 *
 * Usage (from the officetable dir):
 *   npx tsx scripts/clone-live-db.ts [--wipe]
 *   CLONE_URL=https://table.concertim.com (default)
 *
 * The script refuses to run on a non-empty database unless --wipe is passed;
 * wipe truncates everything (incl. gambling tables) for a clean mirror:
 *   cp officetable.db officetable-backup.db   # before wiping!
 */
import db from '../lib/db';
import { processMatch } from '../lib/elo';
import type { Game, MatchWithParticipants, Player } from '../lib/types';

const BASE = (process.env.CLONE_URL ?? 'https://table.concertim.com').replace(/\/$/, '');
const LIMIT = 100;

// Base house pot after a clone — the bookie needs real reserves so the
// two-pot payout cap (bet pool + house pot − 1) can pay big winners.
// House reserve + player balances used to be seeded here; money now lives on
// the central Alces Bookie bank — players register/link accounts at /gambling/bank.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  console.log(`Cloning from ${BASE} → SQLite (${process.cwd()}/officetable.db)`);

  const playersCount = (db.prepare('SELECT COUNT(*) n FROM players').get() as { n: number }).n;
  const matchCount = (db.prepare('SELECT COUNT(*) n FROM matches').get() as { n: number }).n;
  if (playersCount > 0 || matchCount > 0) {
    if (process.argv.includes('--wipe')) {
      console.log(`Wiping local DB (${playersCount} players, ${matchCount} matches)...`);
      db.exec(`
        DELETE FROM bets;
        DELETE FROM challenge_terms;
        UPDATE challenges SET gamble_match_id = NULL;
        DELETE FROM gamble_matches;
        DELETE FROM challenges;
        DELETE FROM bank_transactions;
        DELETE FROM bank_accounts;
        UPDATE bank_house SET balance = 0 WHERE id = 1;
        DELETE FROM player_achievements;
        DELETE FROM match_participants;
        DELETE FROM matches;
        DELETE FROM player_ratings;
        DELETE FROM players;
        DELETE FROM games;
      `);
    } else {
      console.error(`\nLocal DB is not empty (${playersCount} players, ${matchCount} matches).`);
      console.error('A clone needs a fresh database. Back up first, then run with --wipe:');
      console.error('  cp officetable.db officetable-backup.db && npx tsx scripts/clone-live-db.ts --wipe');
      process.exit(1);
    }
  }

  // --- games (live ids preserved) ------------------------------------------
  const games = await getJson<Game[]>('/api/games');
  const insGame = db.prepare(`INSERT OR IGNORE INTO games (id, name, created_at, score_type, score_value, image_url)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const g of games) {
    insGame.run(g.id, g.name, g.created_at, g.score_type, g.score_value, g.image_url ?? null);
  }
  console.log(`games: ${games.length}`);
  const GAME_IDS = new Set(games.map(g => g.id));

  // --- players (live ids preserved, avatars included) -----------------------
  // status=all: the default endpoint filters out retired players, whose
  // historic matches would then be skipped
  const players = await getJson<Player[]>('/api/players?status=all');
  const insPlayer = db.prepare(`INSERT INTO players (id, name, status, created_at, avatar_url)
    VALUES (?, ?, ?, ?, ?)`);
  for (const p of players) {
    insPlayer.run(p.id, p.name, p.status, p.created_at, p.avatar_url ?? null);
    // No bank seed: moose bucks live on the central Alces Bookie bank now —
    // players link (or register) their bank account on /gambling/bank.
  }
  console.log(`players: ${players.length}`);
  const KNOWN = new Set(players.map(p => p.id));

  // --- matches: pull every page, then replay oldest-first -------------------
  const first = await getJson<{ matches: MatchWithParticipants[]; pagination: { total: number; totalPages: number } }>(
    `/api/matches?page=1&limit=${LIMIT}`);
  const all: MatchWithParticipants[] = [...first.matches];
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    await sleep(150); // be gentle with the live server
    const pageRes = await getJson<{ matches: MatchWithParticipants[] }>(`/api/matches?page=${page}&limit=${LIMIT}`);
    all.push(...pageRes.matches);
    if (page % 10 === 0) console.log(`  fetched ${all.length}/${first.pagination.total} matches…`);
  }
  all.sort((a, b) => (a.played_at === b.played_at ? a.id - b.id : a.played_at < b.played_at ? -1 : 1));

  // Live players may exist without having played (status covers them); match
  // participants must all be known or Elo replay would diverge — fail loudly.
  const skipped: number[] = [];
  let done = 0;
  for (const m of all) {
    if (!GAME_IDS.has(m.game_id) || m.participants.some(p => !KNOWN.has(p.player_id))) {
      skipped.push(m.id);
      continue;
    }
    const teams = [0, 1].map(team => {
      const on = m.participants.filter(p => p.team === team);
      return { team, player_ids: on.map(p => p.player_id), score: on.reduce((s, p) => s + p.score, 0) };
    });
    processMatch(
      { game_id: m.game_id, notes: m.notes ?? undefined, teams },
      new Date(m.played_at.replace(' ', 'T') + 'Z'),
    );
    done++;
  }
  console.log(`matches replayed: ${done}${skipped.length ? ` — SKIPPED ${skipped.length}: [${skipped.join(', ')}]` : ''}`);

  // --- calibrate Elo to the live site's published values --------------------
  // Replay recomputes Elo with today's algorithm; the live DB also carries
  // history from older deploys/edits, so per-player totals can drift a few
  // points. The leaderboards ARE the live site's truth — overwrite every
  // (player, game, season) rating with the live value.
  const seasons = await getJson<{ seasons: { id: number }[] }>('/api/seasons');
  const realSeasonIds = [...new Set(seasons.seasons.map(s => s.id))];
  const upsert = db.prepare(`
    INSERT INTO player_ratings (player_id, game_id, elo, season_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, game_id, season_id) DO UPDATE SET elo = excluded.elo
  `);
  let calibrated = 0;
  for (const g of games) {
    const scopes: { qs: string; seasonId: number }[] = [
      { qs: 'scope=alltime', seasonId: 0 },
      ...realSeasonIds.map(id => ({ qs: `scope=season&season_id=${id}`, seasonId: id })),
    ];
    for (const scope of scopes) {
      const rows = await getJson<{ player_id: number; elo: number }[]>(
        `/api/leaderboard?game_id=${g.id}&${scope.qs}&include_retired=true&include_inactive=true`);
      for (const row of rows) {
        if (!row.player_id || typeof row.elo !== 'number') continue;
        upsert.run(row.player_id, g.id, row.elo, scope.seasonId);
        calibrated++;
      }
    }
  }
  console.log(`Elo calibrated to live values: ${calibrated} (player, game, season) rows`);

  // No house-pot seed either: the house reserve is the 'officetablehouse'
  // bank user's own balance on the central bank (its 500 mint), and the pot
  // accumulates from fees/stakes as gambles run.

  // --- report: local should now mirror live --------------------------------
  const finalCount = (db.prepare('SELECT COUNT(*) n FROM matches').get() as { n: number }).n;
  const ach = (db.prepare('SELECT COUNT(*) n FROM player_achievements').get() as { n: number }).n;
  console.log(`\nClone complete: ${finalCount} matches, ${ach} achievements, ${players.length} players, ${games.length} games.`);
  if (skipped.length > 0) console.warn(`⚠️ ${skipped.length} matches skipped — ratings may drift for those players`);
}

main().catch(e => { console.error(e); process.exit(1); });