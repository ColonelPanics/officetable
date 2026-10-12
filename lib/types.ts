export interface Player {
  id: number;
  name: string;
  status: 'active' | 'retired';
  created_at: string;
  avatar_url?: string | null;
}

export interface Game {
  id: number;
  name: string;
  score_type: 'best_of' | 'first_to';
  score_value: number;
  image_url?: string | null;
  created_at: string;
}

export interface PlayerRating {
  id: number;
  player_id: number;
  game_id: number;
  elo: number;
  /** Ledger: 0 = all-time (never resets); real season id = that season. */
  season_id: number;
  player_name?: string;
}

export interface Match {
  id: number;
  game_id: number;
  played_at: string;
  notes: string | null;
  /** Season the match belongs to (resolved from played_at). */
  season_id: number;
  is_edited?: number;
  edited_at?: string | null;
}

export interface MatchParticipant {
  id: number;
  match_id: number;
  player_id: number;
  team: number;
  score: number;
  /** Season-ledger delta (the match's own season). */
  elo_before: number;
  elo_after: number;
  /** All-time-ledger delta (never resets). */
  alltime_elo_before?: number;
  alltime_elo_after?: number;
}

export interface MatchWithParticipants extends Match {
  participants: (MatchParticipant & { player_name: string })[];
  game_name: string;
  achievements?: MatchAchievement[];
}

export interface LeaderboardEntry {
  player_id: number;
  player_name: string;
  avatar_url?: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  status?: 'active' | 'retired';
  is_inactive?: boolean;
  last_match_at?: string;
  trend: number[];
}

export interface CreateMatchInput {
  game_id: number;
  notes?: string;
  teams: {
    team: number;
    player_ids: number[];
    score: number;
  }[];
}

export interface GameStats {
  game_id: number;
  total_matches: number;
  team0_points: number;
  team1_points: number;
  active_players: number;
  total_players: number;
}

export interface Achievement {
  id: number;
  name: string;
  description: string;
  category: string;
  icon?: string | null;
}

export interface PlayerAchievement {
  id: number;
  player_id: number;
  game_id: number;
  achievement_id: number;
  match_id: number | null;
  earned_at: string;
  /** Season earned in (re-earnable each season). */
  season_id: number;
  metadata?: string | null;
}

export interface AchievementWithCount {
  id: number;
  name: string;
  description: string;
  category: string;
  icon?: string | null;
  count: number;
  first_earned_at: string;
}

export interface MatchAchievement {
  achievement_id: number;
  achievement_name: string;
  achievement_description: string;
  achievement_icon: string | null;
  player_id: number;
  player_name: string;
}

export interface MatchFilters {
  game_id?: number;
  date_from?: string;
  date_to?: string;
  player_ids?: number[];
  player_count?: number;
  has_achievements?: boolean;
  min_skill_change?: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedMatchesResponse {
  matches: MatchWithParticipants[];
  pagination: PaginationMeta;
}
// ============================================================
// Gambling (office virtual money)
// ============================================================

export type ChallengeStatus = 'pending' | 'countered' | 'accepted' | 'declined' | 'cancelled' | 'expired';
export type BetSide = 'red' | 'blue';
/**
 * The challenge's agreed "even" line for the players' entry payout: the
 * scoreline that pays both players exactly half of the entry pool instead of
 * by score share.
 *   true_even = a literal draw (5-5)          — the default
 *   elo_even  = the bookie's frozen predicted line
 *   'R-B'     = a custom line, e.g. '7-3' (R+B = the game total, both 1-9)
 */
export type PayoutLine = 'true_even' | 'elo_even' | string;
export type GambleMatchStatus = 'open' | 'awaiting_score' | 'settled' | 'cancelled';

export interface Challenge {
  id: number;
  game_id: number;
  game_name?: string;
  challenger_id: number;
  challenger_name?: string;
  /** NULL on broadcast challenges (anyone may accept). */
  opponent_id: number | null;
  opponent_name?: string;
  entry_fee: number;
  scheduled_at: string;
  /** NULL while the broadcast challenger takes blue (red joins on accept). */
  red_player_id: number | null;
  /** The challenger's chosen side — broadcast challenges resolve their red on accept. */
  challenger_side: 'red' | 'blue';
  /** 1 = broadcast: no fixed opponent, first non-challenger to accept takes the other side. */
  broadcast: number;
  /** The scoreline whose result treats the entry payout as even (see PayoutLine). */
  payout_line: PayoutLine;
  /** Free-text house rules written by the players, shown to gamblers. */
  special_rules: string | null;
  status: ChallengeStatus;
  terms_by: number;
  terms_by_name?: string;
  gamble_match_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChallengeTerm {
  id: number;
  challenge_id: number;
  entry_fee: number;
  scheduled_at: string;
  red_player_id: number | null;
  proposed_by: number;
  proposed_by_name?: string;
  payout_line?: PayoutLine;
  special_rules?: string | null;
  created_at: string;
}

export interface ScoreOutcome {
  redScore: number;
  blueScore: number;
  prob: number;
  decimalOdds: number;
  fractional: string;
}

export interface OddsLadder {
  total: number;
  eloRed: number;
  eloBlue: number;
  expectedShare: number;
  blendedShare: number;
  calibrationW: number;
  calibrationN: number;
  predictedLine: string;
  outcomes: ScoreOutcome[];
}

/** gamble_matches row (odds_json is exposed parsed as OddsLadder). */
export interface GambleMatch {
  id: number;
  challenge_id: number;
  game_id: number;
  game_name?: string;
  red_player_id: number;
  red_player_name?: string;
  blue_player_id: number;
  blue_player_name?: string;
  scheduled_at: string;
  bet_close_at: string;
  entry_fee: number;
  outcome_total: number;
  odds_json: string;
  /** Frozen evens line from the challenge (see PayoutLine). */
  payout_line: PayoutLine;
  /** Free-text rules copied from the challenge — display only. */
  special_rules: string | null;
  odds?: OddsLadder;
  status: GambleMatchStatus;
  match_id?: number | null;
  settled_at?: string | null;
  created_at: string;
}

export interface Bet {
  id: number;
  gamble_match_id: number;
  bettor_id: number;
  bettor_name?: string;
  red_score: number;
  blue_score: number;
  stake: number;
  decimal_odds: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout?: number | null;
  created_at: string;
}

/** Settlement result — also sent back by the settle API endpoint. */
export interface SettleSummary {
  gambleMatchId: number;
  matchId: number;
  finalScore: { red: number; blue: number };
  pool: number;
  returns: number;
  /** Payout cap = bet pool + house pot − 1: the two pots together, with the
   *  casino always keeping at least 1 moose buck. */
  payoutCap: number;
  /** True when the full odds line bust the cap and payouts were scaled down. */
  returnsCapped: boolean;
  /** The match's evens line and whether the final score landed on it. */
  payoutLine: PayoutLine;
  entryEvenHit: boolean;
  leftover: number;
  betPayments: {
    bettor_id: number;
    bettor_name: string;
    pick: string;
    stake: number;
    status: 'won' | 'lost';
    payout: number;
  }[];
  pot: {
    positive: boolean;
    house: number;
    /** 10% house fee taken off the combined entry before the score split. */
    houseFee: number;
    winnerPlayerId: number | null;
    winnerShare: number;
    scoreShares: { playerId: number; amount: number }[];
    houseLoss: number;
  };
  playerEntry: { playerId: number; fee: number; returned: number }[];
}

export interface BankTransaction {
  id: number;
  ref_type: string;
  ref_id?: number | null;
  player_id?: number | null;
  player_name?: string | null;
  amount: number;
  memo?: string | null;
  created_at: string;
}
