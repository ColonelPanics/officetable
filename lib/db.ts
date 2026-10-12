import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'officetable.db');
const db = new Database(dbPath);

// Initialize schema
db.exec(`
  -- Players table
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Games table (game types)
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Player ratings per game (separate skill tracking)
  CREATE TABLE IF NOT EXISTS player_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    elo REAL DEFAULT 0,
    UNIQUE(player_id, game_id),
    FOREIGN KEY (player_id) REFERENCES players(id),
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  -- Matches table
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  -- Match participants (supports teams)
  CREATE TABLE IF NOT EXISTS match_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    team INTEGER NOT NULL,
    score INTEGER NOT NULL,
    elo_before REAL NOT NULL,
    elo_after REAL NOT NULL,
    FOREIGN KEY (match_id) REFERENCES matches(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );
`);

// Migration: Add status column to players table if it doesn't exist
try {
  db.exec(`ALTER TABLE players ADD COLUMN status TEXT DEFAULT 'active'`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Player avatar as an external image URL. A URL (like the game images)
// is the single source of truth: it works in-app everywhere and embeds in Google
// Chat notifications, which can only fetch publicly-reachable URLs.
try {
  db.exec(`ALTER TABLE players ADD COLUMN avatar_url TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Cleanup: drop the old blob-based avatar columns (avatars are URL-only now)
try {
  db.exec(`ALTER TABLE players DROP COLUMN avatar`);
} catch (e) {
  // Column doesn't exist, ignore
}
try {
  db.exec(`ALTER TABLE players DROP COLUMN avatar_mime`);
} catch (e) {
  // Column doesn't exist, ignore
}
try {
  db.exec(`ALTER TABLE players DROP COLUMN avatar_updated_at`);
} catch (e) {
  // Column doesn't exist, ignore
}

// Migration: Add edit tracking columns to matches table
try {
  db.exec(`ALTER TABLE matches ADD COLUMN is_edited INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}
try {
  db.exec(`ALTER TABLE matches ADD COLUMN edited_at DATETIME`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add score_type and score_value columns to games table if they don't exist
try {
  db.exec(`ALTER TABLE games ADD COLUMN score_type TEXT DEFAULT 'first_to'`);
} catch (e) {
  // Column already exists, ignore
}
try {
  db.exec(`ALTER TABLE games ADD COLUMN score_value INTEGER DEFAULT 10`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add image_url column to games table for notification icons
try {
  db.exec(`ALTER TABLE games ADD COLUMN image_url TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add elo column to player_ratings if it doesn't exist (old schema had mu/sigma)
try {
  db.exec(`ALTER TABLE player_ratings ADD COLUMN elo REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add elo_before/elo_after to match_participants if they don't exist
try {
  db.exec(`ALTER TABLE match_participants ADD COLUMN elo_before REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}
try {
  db.exec(`ALTER TABLE match_participants ADD COLUMN elo_after REAL DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Convert existing mu values to elo (if mu exists and elo is null/default)
try {
  // Check if mu column exists (old schema)
  const tableInfo = db.prepare(`PRAGMA table_info(player_ratings)`).all() as { name: string }[];
  const hasMu = tableInfo.some(col => col.name === 'mu');

  if (hasMu) {
    // Convert mu to elo: scale from ~25 centered to 0 centered
    // mu values typically range 0-50, so multiply by 40 to get to 0-2000 range, then subtract 1000
    db.exec(`UPDATE player_ratings SET elo = ROUND(mu * 40 - 1000) WHERE elo IS NULL OR elo = 0`);
  }
} catch (e) {
  // Migration failed or already done, ignore
}

// Migration: Convert existing mu_before/mu_after in match_participants to elo
try {
  const tableInfo = db.prepare(`PRAGMA table_info(match_participants)`).all() as { name: string }[];
  const hasMuBefore = tableInfo.some(col => col.name === 'mu_before');

  if (hasMuBefore) {
    db.exec(`UPDATE match_participants SET elo_before = ROUND(mu_before * 40 - 1000) WHERE elo_before IS NULL OR elo_before = 0`);
    db.exec(`UPDATE match_participants SET elo_after = ROUND(mu_after * 40 - 1000) WHERE elo_after IS NULL OR elo_after = 0`);
  }
} catch (e) {
  // Migration failed or already done, ignore
}

// Migration: Shift all existing elo values from 1000-centered to 0-centered
// This only runs once when transitioning from the old 1000-default system
try {
  // Check if we need to migrate (elo values around 1000 indicate old system)
  const sampleRating = db.prepare(`SELECT elo FROM player_ratings WHERE elo IS NOT NULL LIMIT 1`).get() as { elo: number } | undefined;

  // If no ratings yet, nothing to migrate
  // If elo is around 1000 (old default), we need to shift all values by -1000
  // The mu migration already handles conversion to 0-centered, so we only shift if needed
  if (sampleRating && sampleRating.elo >= 500) {
    // Values are from the old 1000-centered system, shift them
    db.exec(`UPDATE player_ratings SET elo = elo - 1000 WHERE elo IS NOT NULL`);
    db.exec(`UPDATE match_participants SET elo_before = elo_before - 1000 WHERE elo_before IS NOT NULL`);
    db.exec(`UPDATE match_participants SET elo_after = elo_after - 1000 WHERE elo_after IS NOT NULL`);
  }
} catch (e) {
  // Migration failed or already done, ignore
}

// Records which season-hype milestones have been sent (see lib/seasonHype.ts)
db.exec(`
  CREATE TABLE IF NOT EXISTS season_hype (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    milestone TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(season_id, milestone)
  )
`);

// Settings table for app configuration (branding, theming, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Seed default settings if not exists
const seedSettings = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('company_name', 'Office Games'),
    ('logo_url', ''),
    ('primary_color', '#2563eb'),
    ('accent_color', '#dc2626'),
    ('inactive_threshold_days', '60')
`);
seedSettings.run();

// Seed games with scoring configuration if not exists
const seedGames = db.prepare(`
  INSERT OR IGNORE INTO games (name, score_type, score_value) VALUES
    ('foosball', 'best_of', 10),
    ('table-tennis', 'first_to', 11),
    ('pool', 'first_to', 7)
`);
seedGames.run();

// Achievements table - defines all possible achievements
db.exec(`
  CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    icon TEXT
  )
`);

// Player achievements - tracks achievements earned by players (can earn multiple times)
db.exec(`
  CREATE TABLE IF NOT EXISTS player_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    achievement_id INTEGER NOT NULL,
    match_id INTEGER,
    earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT,
    FOREIGN KEY (player_id) REFERENCES players(id),
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (achievement_id) REFERENCES achievements(id),
    FOREIGN KEY (match_id) REFERENCES matches(id)
  )
`);

// Indexes for efficient queries
db.exec(`CREATE INDEX IF NOT EXISTS idx_player_achievements_player_game ON player_achievements(player_id, game_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_player_achievements_match ON player_achievements(match_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_player_achievements_achievement ON player_achievements(achievement_id)`);

// Critical performance indexes for match queries
db.exec(`CREATE INDEX IF NOT EXISTS idx_match_participants_player ON match_participants(player_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_match_participants_match ON match_participants(match_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_match_participants_match_player ON match_participants(match_id, player_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_game_id ON matches(game_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_player_ratings_game ON player_ratings(game_id)`);

// Seed achievements if not exists
const seedAchievements = db.prepare(`
  INSERT OR IGNORE INTO achievements (name, description, category, icon) VALUES
    ('fresh_blood', 'Claim points from a new player on their first game', 'special', '🩸'),
    ('flawless_victory', 'Beat an opponent without conceding a point', 'special', '💀'),
    ('mostly_harmless', 'Play 100 games', 'milestone', '🥉'),
    ('committed', 'Play 500 games', 'milestone', '🥈'),
    ('dangerous', 'Play 1,000 games', 'milestone', '🥇'),
    ('resident', 'Play 2,000 games', 'milestone', '🏅'),
    ('elite', 'Play 10,000 games', 'milestone', '👑'),
    ('against_the_odds', 'Beat a player 50 or more skillpoints higher than you', 'special', '⚡'),
    ('against_all_odds', 'Beat a player 100 or more skillpoints higher than you', 'special', '💫'),
    ('the_best', 'Go first in the rankings', 'ranking', '🏆'),
    ('the_worst', 'Go last in the rankings', 'ranking', '🔻'),
    ('improver', 'Gain 100 skill points from your lowest point', 'milestone', '📈'),
    ('unstable', 'See-saw 5 or more skill points in consecutive games', 'streak', '🎢'),
    ('comrades', 'Play 100 games against the same opponent', 'milestone', '🤝'),
    ('festive_cheer', 'Play a game on 25th December', 'time_based', '🎄'),
    ('night_owl', 'Play a game between 0000 and 0300 hours', 'time_based', '🦉'),
    ('dedication', 'Play a game at least once every 60 days for a year', 'streak', '🔥'),
    ('early_bird', 'Play and win the first game of the day', 'special', '🌅'),
    ('the_dominator', 'Defeat a player in 10 consecutive games', 'streak', '💪'),
    ('nothing_if_not_consistent', 'Finish 5 consecutive games with the same score', 'streak', '🎯'),
    ('boss_fight', 'Defeat the #1 ranked player in the ladder', 'special', '⚔️')
`);
seedAchievements.run();

// ============================================================
// Seasons + dual-ledger Elo migration
//
// - `seasons` rows hold half-open [start_date, end_date) intervals.
// - `season_id = 0` is the reserved ALL-TIME ledger sentinel (never a real
//   season row; SQLite treats NULL as non-unique in UNIQUE indexes, hence
//   a numeric sentinel instead of NULL).
// - Every ledger lives in the existing tables, keyed by season_id:
//   player_ratings gets one row per (player, game, season) — one per real
//   season plus one all-time row that never resets.
// ============================================================

// Canonical DB datetime helpers (kept local to avoid a circular import with
// lib/seasons.ts, which imports this module). 'YYYY-MM-DD HH:MM:SS' UTC.
function seasonsToDbDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
function seasonsNormaliseDbDate(input: string): string {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed} 00:00:00`;
  }
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return seasonsToDbDate(parsed).substring(0, 19);
}

// Create seasons table
db.exec(`
  CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT
  )
`);

// Add season_id / all-time ledger columns (try/catch ALTER style)
try {
  db.exec(`ALTER TABLE matches ADD COLUMN season_id INTEGER NOT NULL DEFAULT 0`);
} catch (e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE match_participants ADD COLUMN alltime_elo_before REAL`);
} catch (e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE match_participants ADD COLUMN alltime_elo_after REAL`);
} catch (e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE player_ratings ADD COLUMN season_id INTEGER NOT NULL DEFAULT 0`);
} catch (e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE player_achievements ADD COLUMN season_id INTEGER NOT NULL DEFAULT 0`);
} catch (e) { /* already exists */ }

// Rebuild player_ratings so its unique constraint becomes
// UNIQUE(player_id, game_id, season_id). SQLite can't alter constraints,
// so detect the new autoindex and rebuild once.
try {
  const ratingIndexes = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'player_ratings'`
  ).all() as { name: string; sql: string | null }[];
  const hasSeasonUnique = ratingIndexes.some(idx => (idx.sql ?? '').includes('season_id'));
  if (!hasSeasonUnique && ratingIndexes.length > 0) {
    db.exec(`
      CREATE TABLE player_ratings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        game_id INTEGER NOT NULL,
        elo REAL DEFAULT 0,
        season_id INTEGER NOT NULL DEFAULT 0,
        UNIQUE(player_id, game_id, season_id),
        FOREIGN KEY (player_id) REFERENCES players(id),
        FOREIGN KEY (game_id) REFERENCES games(id)
      );
      INSERT INTO player_ratings_new (id, player_id, game_id, elo, season_id)
        SELECT id, player_id, game_id, elo, season_id FROM player_ratings;
      DROP TABLE player_ratings;
      ALTER TABLE player_ratings_new RENAME TO player_ratings;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_player_ratings_game ON player_ratings(game_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_player_ratings_season ON player_ratings(game_id, season_id)`);
  }
} catch (e) {
  console.error('player_ratings season rebuild failed:', e);
}

// Seed the initial seasons (once): Season 0 covers everything from the
// earliest match up to the Season 1 boundary; Season 1 is the open season.
// The boundary date is configurable: settings key 'season_1_start' >
// env SEASON_1_START_DATE > a date 28 days out from first migration.
try {
  const seasonsCount = (db.prepare(`SELECT COUNT(*) as c FROM seasons`).get() as { c: number }).c;
  if (seasonsCount === 0) {
    const earliestRow = db.prepare(`SELECT MIN(played_at) as earliest FROM matches`).get() as { earliest: string | null };
    let season0Start = earliestRow.earliest ?? '1970-01-01 00:00:00';

    const boundarySetting = db.prepare(`SELECT value FROM settings WHERE key = 'season_1_start'`).get() as { value: string } | undefined;
    const boundaryRaw = boundarySetting?.value ?? process.env.SEASON_1_START_DATE;
    let season1Start: string;
    if (boundaryRaw) {
      season1Start = seasonsNormaliseDbDate(boundaryRaw);
    } else {
      // Default: 00:00 UTC, 28 days out
      season1Start = seasonsToDbDate(new Date(Date.now() + 28 * 24 * 60 * 60 * 1000)).substring(0, 10) + ' 00:00:00';
    }

    // Season 0's interval [start, boundary) must be valid, even if the
    // configured boundary precedes the earliest match.
    if (season1Start <= season0Start) {
      season0Start = '1970-01-01 00:00:00';
    }

    db.prepare(`INSERT INTO seasons (name, start_date, end_date) VALUES (?, ?, ?)`)
      .run('Season 0', season0Start, season1Start);
    db.prepare(`INSERT INTO seasons (name, start_date, end_date) VALUES (?, ?, ?)`)
      .run('Season 1', season1Start, null);
  }
} catch (e) {
  console.error('Season seeding failed:', e);
}

// Backfills (idempotent by data state)
try {
  const season0 = db
    .prepare(`SELECT id FROM seasons ORDER BY start_date ASC, id ASC LIMIT 1`)
    .get() as { id: number } | undefined;
  const season0Id = season0?.id ?? 0;

  // Existing matches belong to Season 0 (their ledger was the only one).
  db.prepare(`UPDATE matches SET season_id = ? WHERE season_id = 0`).run(season0Id);

  // Match-linked achievements resolve season via their match; any stragglers
  // (NULL match) go to Season 0.
  db.prepare(
    `UPDATE player_achievements SET season_id = COALESCE(
       (SELECT m.season_id FROM matches m WHERE m.id = player_achievements.match_id), ?
     ) WHERE season_id = 0`
  ).run(season0Id);

  // All-time participant deltas mirror the original (single-ledger) values.
  db.exec(
    `UPDATE match_participants
     SET alltime_elo_before = elo_before, alltime_elo_after = elo_after
     WHERE alltime_elo_before IS NULL OR alltime_elo_after IS NULL`
  );

  // Ratings: existing rows become the Season 0 ledger, then duplicated as
  // all-time (season_id = 0) rows. Current values are already correct for
  // both ledgers — no replay required. Guarded by "no Season 0 ratings row
  // exists yet" so it only ever runs once.
  const hadAnyRatings = ((db.prepare(`SELECT COUNT(*) as c FROM player_ratings`).get() as { c: number }).c) > 0;
  const hadSeasonRatings = ((db.prepare(`SELECT COUNT(*) as c FROM player_ratings WHERE season_id = ?`).get(season0Id) as { c: number }).c) > 0;
  if (hadAnyRatings && !hadSeasonRatings) {
    db.prepare(`UPDATE player_ratings SET season_id = ? WHERE season_id = 0`).run(season0Id);
    db.prepare(
      `INSERT INTO player_ratings (player_id, game_id, elo, season_id)
       SELECT player_id, game_id, elo, 0 FROM player_ratings WHERE season_id = ?`
    ).run(season0Id);
  }

  // Performance indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_season ON matches(season_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_matches_game_season_played ON matches(game_id, season_id, played_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_player_ratings_season ON player_ratings(game_id, season_id)`
  );
} catch (e) {
  console.error('Season backfill failed:', e);
}

// Update icons for existing achievements (migration)
const updateAchievementIcons = db.prepare(`
  UPDATE achievements SET icon = CASE name
    WHEN 'fresh_blood' THEN '🩸'
    WHEN 'flawless_victory' THEN '💀'
    WHEN 'mostly_harmless' THEN '🥉'
    WHEN 'committed' THEN '🥈'
    WHEN 'dangerous' THEN '🥇'
    WHEN 'resident' THEN '🏅'
    WHEN 'elite' THEN '👑'
    WHEN 'against_the_odds' THEN '⚡'
    WHEN 'against_all_odds' THEN '💫'
    WHEN 'the_best' THEN '🏆'
    WHEN 'the_worst' THEN '🔻'
    WHEN 'improver' THEN '📈'
    WHEN 'unstable' THEN '🎢'
    WHEN 'comrades' THEN '🤝'
    WHEN 'festive_cheer' THEN '🎄'
    WHEN 'night_owl' THEN '🦉'
    WHEN 'dedication' THEN '🔥'
    WHEN 'early_bird' THEN '🌅'
    WHEN 'the_dominator' THEN '💪'
    WHEN 'nothing_if_not_consistent' THEN '🎯'
    WHEN 'boss_fight' THEN '⚔️'
    ELSE icon
  END
  WHERE icon IS NULL OR icon = ''
`);
updateAchievementIcons.run();

// ============================================================
// Gambling (office virtual money — see the flowchart + written spec)
//
// Challenges hold the negotiable terms (fee / time / side). Counters
// update the row and append an offer to challenge_terms; accept freezes
// the terms into a gamble_match with an odds snapshot. All money flows
// through the bank tables — every movement writes one signed bank_transactions
// row, so SUM(amount) per account always equals the balance.
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id),
    challenger_id INTEGER NOT NULL REFERENCES players(id),
    opponent_id INTEGER REFERENCES players(id),   -- NULL on broadcast challenges
    entry_fee INTEGER NOT NULL,
    scheduled_at TEXT NOT NULL,
    red_player_id INTEGER,                        -- NULL while a broadcast challenger takes blue
    challenger_side TEXT NOT NULL DEFAULT 'red',
    status TEXT NOT NULL DEFAULT 'pending',
    terms_by INTEGER NOT NULL,
    broadcast INTEGER NOT NULL DEFAULT 0,
    payout_line TEXT NOT NULL DEFAULT 'true_even',
    special_rules TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS challenge_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    entry_fee INTEGER NOT NULL,
    scheduled_at TEXT NOT NULL,
    red_player_id INTEGER,
    proposed_by INTEGER NOT NULL,
    payout_line TEXT NOT NULL DEFAULT 'true_even',
    special_rules TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS gamble_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    game_id INTEGER NOT NULL REFERENCES games(id),
    red_player_id INTEGER NOT NULL REFERENCES players(id),
    blue_player_id INTEGER NOT NULL REFERENCES players(id),
    scheduled_at TEXT NOT NULL,
    bet_close_at TEXT NOT NULL,
    entry_fee INTEGER NOT NULL,
    outcome_total INTEGER NOT NULL,
    odds_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    payout_line TEXT NOT NULL DEFAULT 'true_even',
    special_rules TEXT,
    match_id INTEGER,
    settled_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gamble_match_id INTEGER NOT NULL REFERENCES gamble_matches(id),
    bettor_id INTEGER NOT NULL REFERENCES players(id),
    red_score INTEGER NOT NULL,
    blue_score INTEGER NOT NULL,
    stake INTEGER NOT NULL,
    decimal_odds REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    payout INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bank_accounts (
    player_id INTEGER PRIMARY KEY REFERENCES players(id),
    balance INTEGER NOT NULL DEFAULT 1000,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bank_house (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_type TEXT NOT NULL,
    ref_id INTEGER,
    player_id INTEGER,
    amount INTEGER NOT NULL,
    memo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_gamble_matches_status ON gamble_matches(status);
  CREATE INDEX IF NOT EXISTS idx_gamble_matches_game_sched ON gamble_matches(game_id, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_gamble_matches_players ON gamble_matches(red_player_id, blue_player_id);
  CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(gamble_match_id);
  CREATE INDEX IF NOT EXISTS idx_bets_bettor ON bets(bettor_id);
  CREATE INDEX IF NOT EXISTS idx_bank_transactions_player ON bank_transactions(player_id);
`);

db.prepare(`INSERT OR IGNORE INTO bank_house (id, balance) VALUES (1, 0)`).run();

// Migration: Alces Bookie central-bank linking. Balances now REALLY live on
// the shared office bank (http://10.151.0.132:3000 — "bank is the truth"), so
// bankAccounts gain the player's own registered credentials (registration is
// manual — the site has no mint of its own), and bank_sync is the outbox of
// ledger rows still waiting to be pushed out as real transfers.
try {
  db.exec(`ALTER TABLE bank_accounts ADD COLUMN bank_username TEXT`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE bank_accounts ADD COLUMN bank_password TEXT`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE bank_accounts ADD COLUMN bank_linked_at TEXT`);
} catch (e) { /* column already exists */ }
// Enforced as an index, not an inline UNIQUE — SQLite cannot ALTER in a
// UNIQUE column once rows exist (that failure previously disappeared into
// the catches above), leaving accounts without the linking column at all.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_accounts_username ON bank_accounts(bank_username)`);
db.exec(`
  CREATE TABLE IF NOT EXISTS bank_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id),
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | sending | done | failed | unverified
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bank_sync_status ON bank_sync(status, id);
`);

// Migration: delivery-verification for retried bank transfers. The bank has
// no idempotency keys, so a retry after a lost response would double-send.
// The drainer records the sender's real bank-side balance immediately before
// each attempt; any later uncertain retry compares the fresh balance against
// that snapshot (pre_balance) before deciding to re-send. Rows keep their
// snapshot after completing so even a manual re-arm of a 'done' row verifies
// instead of blind-resending.
try {
  db.exec(`ALTER TABLE bank_sync ADD COLUMN pre_balance REAL`);
} catch (e) { /* column already exists */ }

// One-time secret migration: anything stored as plaintext (pre-encryption
// bank passwords, house password, service token) is re-encrypted at rest.
// Harmless when already encrypted. ESM import keeps db.ts free of crypto
// imports while running the migration once this module is loaded.
import('./crypto').then(({ migratePlaintextSecrets }) => migratePlaintextSecrets());

// Migration: challenges gain a link to the gamble match opened on accept
// (added after the table shipped, so existing DBs need the ALTER).
try {
  db.exec(`ALTER TABLE challenges ADD COLUMN gamble_match_id INTEGER REFERENCES gamble_matches(id)`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: broadcast challenges make the opponent optional and the
// challenger's red/blue pick explicit, and the payout line + special rules
// join the negotiable terms. Old challenges tables (opponent_id NOT NULL)
// need a table rebuild — SQLite cannot relax a NOT NULL by ALTER.
try {
  const cols = db.prepare(`PRAGMA table_info(challenges)`).all() as { name: string; notnull: number }[];
  if (cols.find(c => c.name === 'opponent_id')?.notnull) {
    db.pragma('foreign_keys = OFF'); // children (gamble_matches) keep their live references across the rebuild
    try {
      db.exec(`
        CREATE TABLE challenges_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL REFERENCES games(id),
          challenger_id INTEGER NOT NULL REFERENCES players(id),
          opponent_id INTEGER REFERENCES players(id),
          entry_fee INTEGER NOT NULL,
          scheduled_at TEXT NOT NULL,
          red_player_id INTEGER,
          challenger_side TEXT NOT NULL DEFAULT 'red',
          status TEXT NOT NULL DEFAULT 'pending',
          terms_by INTEGER NOT NULL,
          broadcast INTEGER NOT NULL DEFAULT 0,
          payout_line TEXT NOT NULL DEFAULT 'true_even',
          special_rules TEXT,
          gamble_match_id INTEGER REFERENCES gamble_matches(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO challenges_v2 (id, game_id, challenger_id, opponent_id, entry_fee, scheduled_at, red_player_id, status, terms_by, gamble_match_id, created_at, updated_at)
          SELECT id, game_id, challenger_id, opponent_id, entry_fee, scheduled_at, red_player_id, status, terms_by, gamble_match_id, created_at, updated_at FROM challenges;
        DROP TABLE challenges;
        ALTER TABLE challenges_v2 RENAME TO challenges;
      `);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
} catch (e) {
  console.error('challenges broadcast rebuild failed:', e);
}

// Migration: broadcast challenges leave a term's red side undetermined until
// acceptance, so challenge_terms.red_player_id must be nullable too — same
// table-rebuild requirement as challenges above.
try {
  const cols = db.prepare(`PRAGMA table_info(challenge_terms)`).all() as { name: string; notnull: number }[];
  if (cols.find(c => c.name === 'red_player_id')?.notnull) {
    db.pragma('foreign_keys = OFF'); // challenges rows keep their references across the rebuild
    try {
      db.exec(`
        CREATE TABLE challenge_terms_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          challenge_id INTEGER NOT NULL REFERENCES challenges(id),
          entry_fee INTEGER NOT NULL,
          scheduled_at TEXT NOT NULL,
          red_player_id INTEGER,
          proposed_by INTEGER NOT NULL,
          payout_line TEXT NOT NULL DEFAULT 'true_even',
          special_rules TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO challenge_terms_v2 (id, challenge_id, entry_fee, scheduled_at, red_player_id, proposed_by, payout_line, special_rules, created_at)
          SELECT id, challenge_id, entry_fee, scheduled_at, red_player_id, proposed_by, payout_line, special_rules, created_at FROM challenge_terms;
        DROP TABLE challenge_terms;
        ALTER TABLE challenge_terms_v2 RENAME TO challenge_terms;
      `);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
} catch (e) {
  console.error('challenge_terms nullable-red rebuild failed:', e);
}

// Simpler column adds for DBs whose challenges table was created before
// broadcast/payout terms existed (fresh tables already have all of them).
for (const stmt of [
  `ALTER TABLE challenges ADD COLUMN challenger_side TEXT NOT NULL DEFAULT 'red'`,
  `ALTER TABLE challenges ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE challenges ADD COLUMN payout_line TEXT NOT NULL DEFAULT 'true_even'`,
  `ALTER TABLE challenges ADD COLUMN special_rules TEXT`,
  `ALTER TABLE challenge_terms ADD COLUMN payout_line TEXT NOT NULL DEFAULT 'true_even'`,
  `ALTER TABLE challenge_terms ADD COLUMN special_rules TEXT`,
  `ALTER TABLE gamble_matches ADD COLUMN payout_line TEXT NOT NULL DEFAULT 'true_even'`,
  `ALTER TABLE gamble_matches ADD COLUMN special_rules TEXT`,
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
}

// Seed an account for every existing player (new players get accounted via
// lib/bank.ensureAccount — same INSERT OR IGNORE, so repeated calls are free).
// Mock/offline mode mints 1000 each; when the central Alces bank is wired,
// nobody locally mints — unlinked players hold zero until they register.
const mirrorOn = !!(
  process.env.ALCES_SERVICE_TOKEN
  ?? (db.prepare(`SELECT value FROM settings WHERE key = 'alces_service_token'`).get() as
    | { value: string } | undefined)?.value
);
db.prepare(`INSERT OR IGNORE INTO bank_accounts (player_id, balance) SELECT id, ? FROM players`)
  .run(mirrorOn ? 0 : 1000);

export default db;
