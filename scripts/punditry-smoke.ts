// Smoke test for dual-scope punditry. Run from a SCRATCH copies of the DB:
//   mkdir -p /tmp/punditry-run && cd /tmp/punditry-run
//   npx --prefix /path/to/officetable tsx /path/to/officetable/scripts/punditry-smoke.ts
import db from '../lib/db';
import { getPunditryForMatch, type PunditryFact } from '../lib/punditry';

function assert(cond: boolean, label: string): void {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok: ${label}`);
}

// Pick the most recent match
const firstMatch = db.prepare('SELECT id FROM matches ORDER BY played_at DESC LIMIT 1').get() as { id: number } | null;
if (!firstMatch) {
  console.error('No matches in DB — seed data first.');
  process.exit(1);
}

const facts: PunditryFact[] = getPunditryForMatch(firstMatch.id);

// Every fact carries a scope and a notable flag (post-pass guarantees it)
assert(facts.every(f => typeof f.scope === 'string' && f.scope.length > 0), 'every fact has a scope');
assert(facts.every(f => typeof f.notable === 'boolean'), 'every fact has a notable flag');

// Record facts (notable) always name their scope in prose too (gchat face)
const recordFacts = facts.filter(f => f.notable);
assert(recordFacts.every(f => /record\)/.test(f.description) || f.type.endsWith('_broken') || f.type === 'h2h_biggest_match'),
  'notable record lines carry "(... record)" or are break/h2h-biggest facts');

// Rollup: at most one run-family fact (record or broken, solo or h2h) per player
const RUN_TYPES = new Set(['longest_win_streak', 'longest_lose_streak', 'longest_unbeaten_streak',
  'h2h_longest_win_streak', 'h2h_longest_lose_streak', 'h2h_longest_unbeaten_streak',
  'win_streak_broken', 'lose_streak_broken', 'unbeaten_streak_broken',
  'h2h_win_streak_broken', 'h2h_lose_streak_broken', 'h2h_unbeaten_streak_broken']);
const runKeys = facts.filter(f => RUN_TYPES.has(f.type)).map(f => String(f.player_id));
assert(new Set(runKeys).size === runKeys.length, 'run facts rolled up to one story per player');

console.log(`\n${facts.length} facts on match ${firstMatch.id} (notable: ${recordFacts.length}):`);
for (const f of facts) console.log(` ${f.notable ? '★' : ' '} [${f.scope}] (${f.type}) ${f.description}`);
