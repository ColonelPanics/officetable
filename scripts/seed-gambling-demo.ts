// Seed demo data for the gambling UI: a few players, bank accounts, and a
// handful of foosball 1v1 results so the Elo odds + head-to-head blending
// have something real to chew on. Idempotent — skips players/games that
// already exist. Safe to run any time: npm run seed-gambling (or
// npx tsx scripts/seed-gambling-demo.ts) from the project root.
import db from '../lib/db';
import { processMatch } from '../lib/elo';
import { getBank } from '../lib/bank';

const PLAYERS = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace'];

// [game_id, team0 players, team0 score, team1 players, team1 score]
const RESULTS: [number, number[], number, number[], number][] = [
  // Foosball (to 10) — Alice dominates Bob, Carol edges Dave, Eve mixed
  [1, [0], 7, [1], 3],
  [1, [0], 8, [1], 2],
  [1, [0], 6, [1], 4],
  [1, [2], 6, [3], 4],
  [1, [3], 7, [2], 3],
  [1, [2], 5, [1], 5],
  [1, [4], 9, [5], 1],
  [1, [5], 6, [4], 4],
  [1, [6], 4, [2], 6],
  // Table tennis (first to 11) for general Elo texture
  [2, [0], 11, [2], 7],
  [2, [3], 11, [4], 9],
];

function main() {
  const bank = getBank();
  const insPlayer = db.prepare(`INSERT INTO players (name, status) VALUES (?, 'active')`);

  const playerIds: number[] = [];
  for (const name of PLAYERS) {
    const existing = db.prepare(`SELECT id FROM players WHERE name = ?`).get(name) as { id: number } | undefined;
    const id = existing ? existing.id : (insPlayer.run(name).lastInsertRowid as number);
    playerIds.push(id);
    bank.ensureAccount(id);
  }

  const seeded = db.prepare(`SELECT COUNT(*) n FROM matches WHERE game_id = 1`).get() as { n: number };
  if (seeded.n >= RESULTS.filter(r => r[0] === 1).length) {
    console.log('Demo matches already present — skipping match seed.');
    console.log('Players:', playerIds.map((id, i) => `${PLAYERS[i]}=#${id}`).join(', '));
    return;
  }

  // Spread results over the last few days so timestamps look organic
  let minutesAgo = 60 * 24 * 5;
  for (const [gameId, p0, s0, p1, s1] of RESULTS) {
    const when = new Date(Date.now() - minutesAgo * 60_000);
    minutesAgo = Math.max(20, minutesAgo - 60 * 18);
    const teams = [
      { team: 0, player_ids: [playerIds[p0[0]]], score: s0 },
      { team: 1, player_ids: [playerIds[p1[0]]], score: s1 },
    ];
    try {
      processMatch({ game_id: gameId, teams, notes: 'demo seed' }, when);
    } catch (e) {
      console.warn(`skipped a demo match (${(e as Error).message})`);
    }
  }

  console.log('Seeded demo data:');
  console.log('  players:', playerIds.map((id, i) => `${PLAYERS[i]}=#${id}`).join(', '));
  console.log('  matches:', (db.prepare(`SELECT COUNT(*) n FROM matches`).get() as { n: number }).n);
  console.log('  balances:', playerIds.map(id => bank.getBalance(id)).join(', '));
}

main();