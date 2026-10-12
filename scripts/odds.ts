/**
 * Extract win odds from Elo ratings for betting purposes.
 *
 * Usage:
 *   npx tsx scripts/odds.ts <game_id>                          # odds board for everyone
 *   npx tsx scripts/odds.ts <game_id> "Alice" "Bob,Carol"      # matchup (comma = teammates)
 *   npx tsx scripts/odds.ts <game_id> "Alice" "Bob" --price 1.85   # EV check vs offered price
 *   npx tsx scripts/odds.ts <game_id> "Alice" "Bob" --ledger alltime
 *
 * All math lives in lib/gambleOdds.ts — this is just the CLI wrapper.
 * Fair prices are quoted UK-style, snapped to the bookmakers' fraction ladder
 * (10/11, 4/6, 1/2, 11/8, ...).
 */

import db from '../lib/db';
import { resolveSeason } from '../lib/seasons';
import {
  expectedShare,
  shareToWinProb,
  decimalOddsOf,
  fractionalOdds,
  predictedLine,
} from '../lib/gambleOdds';

type Ledger = 'season' | 'alltime';

function getElo(playerName: string, gameId: number, seasonId: number, label: string): number {
  const row = db.prepare(`
    SELECT COALESCE(pr.elo, 0) as elo
    FROM players p
    LEFT JOIN player_ratings pr
      ON pr.player_id = p.id AND pr.game_id = ? AND pr.season_id = ?
    WHERE p.name = ?
  `).get(gameId, seasonId, playerName) as { elo: number } | undefined;

  if (!row) {
    throw new Error(`Unknown player: "${playerName}" (${label} ledger). Check the name.`);
  }
  return row.elo;
}

function listBoard(gameId: number, ledger: Ledger): void {
  const seasonId = ledger === 'season' ? resolveSeason(new Date()) : 0;

  const rows = db.prepare(`
    SELECT p.name, COALESCE(pr.elo, 0) as elo
    FROM players p
    LEFT JOIN player_ratings pr
      ON pr.player_id = p.id AND pr.game_id = ? AND pr.season_id = ?
    WHERE p.status = 'active'
    ORDER BY elo DESC
  `).all(gameId, seasonId) as { name: string; elo: number }[];

  console.log(`\nOdds board — ${ledger} ledger (game ${gameId}, season ${seasonId})`);
  console.log(`(win probs here treat the Elo share as a win probability; exact-score ladders live in the gambling UI)\n`);

  for (const top of rows) {
    const rest = rows.filter(r => r.name !== top.name);
    if (rest.length === 0) continue;
    // Average opponent rating as a rough baseline for pricing everyone else
    const avgOpp = rest.reduce((s, r) => s + r.elo, 0) / rest.length;
    const share = expectedShare(top.elo, avgOpp);
    const p = shareToWinProb(share, 0.7);
    const gap = top.elo - avgOpp;
    console.log(
      `${top.name.padEnd(20)} elo ${top.elo.toFixed(0).padStart(5)}   vs field: expect ${predictedLine(share)}, win ${(p * 100).toFixed(0)}%  (decimal ${decimalOddsOf(p).toFixed(2)}, UK ${fractionalOdds(p)})   [gap ${gap >= 0 ? '+' : ''}${gap.toFixed(0)}]`
    );
  }
}

function matchup(gameId: number, sideA: string[], sideB: string[], ledger: Ledger, price?: number): void {
  const seasonId = ledger === 'season' ? resolveSeason(new Date()) : 0;

  const sumElos = (names: string[]) => names.reduce((s, name) => s + getElo(name, gameId, seasonId, ledger), 0);
  const eloA = sumElos(sideA);
  const eloB = sumElos(sideB);

  const shareA = expectedShare(eloA, eloB);
  const pA = shareToWinProb(shareA, 0.7);
  const pB = 1 - pA;

  console.log(`\n${sideA.join(' + ')} vs ${sideB.join(' + ')}  (${ledger} ledger)\n`);
  console.log(`  team A elo: ${eloA.toFixed(1)}   team B elo: ${eloB.toFixed(1)}   gap: ${(eloA - eloB).toFixed(1)}`);
  console.log(``);

  const printSide = (name: string, share: number, p: number) => {
    console.log(`  ${name}:`);
    console.log(`    expected point share ${(share * 100).toFixed(0)}%  ->  predicted line ${predictedLine(share)}`);
    console.log(`    win prob ${(p * 100).toFixed(1)}%   fair decimal ${decimalOddsOf(p).toFixed(3)}   UK ${fractionalOdds(p)}`);
    console.log(``);
  };

  printSide(sideA.join(' + '), shareA, pA);
  printSide(sideB.join(' + '), 1 - shareA, pB);

  if (price !== undefined) {
    // --price is the decimal price being offered on side A
    const ev = pA * price - 1;
    console.log(`  EV on side A at offered price ${price}: ${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(1)}%  ${ev > 0 ? '→ +EV, worth betting' : '→ -EV, pass'}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const gameId = parseInt(args[0], 10);
  if (!gameId) {
    console.error('Usage: npx tsx scripts/odds.ts <game_id> ["NameA" "NameB,NameC"] [--ledger alltime] [--price <decimal odds on side A>]');
    process.exit(1);
  }

  let ledger: Ledger = 'season';
  let price: number | undefined;
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ledger') {
      const v = args[++i];
      if (v !== 'season' && v !== 'alltime') {
        console.error('--ledger must be "season" or "alltime"');
        process.exit(1);
      }
      ledger = v;
    } else if (args[i] === '--price') {
      price = parseFloat(args[++i]);
      if (!price || price < 1) {
        console.error('--price must be a decimal odds value ≥ 1.0 (e.g. 1.85)');
        process.exit(1);
      }
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0) {
    listBoard(gameId, ledger);
  } else if (positional.length === 2) {
    matchup(
      gameId,
      positional[0].split(',').map(s => s.trim()),
      positional[1].split(',').map(s => s.trim()),
      ledger,
      price
    );
  } else {
    console.error('Pass exactly two sides: "PlayerA" and "PlayerB" (comma-separate teammates)');
    process.exit(1);
  }
}

main();