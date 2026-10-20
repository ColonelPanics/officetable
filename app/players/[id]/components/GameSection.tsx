import { RivalsSection } from './RivalsSection';
import { EloChart } from './EloChart';
import { RecentMatches } from './RecentMatches';
import { CategoryProgressBars, buildCategoryProgress } from './CategoryProgressBars';
import { AchievementChecklist } from './AchievementChecklist';

interface EloHistoryPoint {
  elo: number;
  date: string;
}

interface SkillGainRecord {
  gain: number;
  date: string;
  score: number;
  opponent_score: number;
  opponents: string[];
  teammates: string[];
}

interface SkillLossRecord {
  loss: number;
  date: string;
  score: number;
  opponent_score: number;
  opponents: string[];
  teammates: string[];
}

interface GameRecords {
  highest_elo: number;
  highest_elo_date: string | null;
  lowest_elo: number;
  lowest_elo_date: string | null;
  longest_win_streak: number;
  longest_win_streak_start: string | null;
  longest_win_streak_end: string | null;
  longest_lose_streak: number;
  longest_lose_streak_start: string | null;
  longest_lose_streak_end: string | null;
  longest_unbeaten_streak: number;
  longest_unbeaten_streak_start: string | null;
  longest_unbeaten_streak_end: string | null;
  biggest_gain: SkillGainRecord | null;
  biggest_loss: SkillLossRecord | null;
}

interface Achievement {
  achievement_id: number;
  achievement_name: string;
  achievement_description: string;
  achievement_category: string;
  achievement_icon: string | null;
  count: number;
  first_earned_at: string;
}

interface Opponent {
  player_name: string;
  score: number;
  team: number;
}

interface RecentMatch {
  id: number;
  game_id: number;
  played_at: string;
  notes: string | null;
  game_name: string;
  team: number;
  score: number;
  elo_before: number;
  elo_after: number;
  opponents: Opponent[];
  teammates: string[];
  opponent_score: number;
  result: 'win' | 'loss' | 'draw';
}

interface HeadToHeadOpponent {
  opponent_id: number;
  opponent_name: string;
  game_id: number;
  game_name: string;
  wins: number;
  losses: number;
  draws: number;
  total_matches: number;
  net_skill: number;
  current_streak: string;
  last_played: string;
}

interface AllAchievement {
  id: number;
  name: string;
  description: string;
  category: string;
  icon: string | null;
}

interface GameSectionProps {
  game: {
    game_id: number;
    game_name: string;
    score_type: string;
    score_value: number;
    image_url?: string | null;
    elo: number;
    total_matches: number;
    wins: number;
    losses: number;
    draws: number;
    points_scored: number;
    points_conceded: number;
    records: GameRecords;
    elo_history: EloHistoryPoint[];
    /** Current streak in the house 'W5'/'L2'/'D1' form ('' = no matches). */
    current_streak: string;
    achievements: Achievement[];
  };
  playerId: number;
  recentMatches: RecentMatch[];
  headToHeadData: Map<number, HeadToHeadOpponent[]>;
  headToHeadLoading: Set<number>;
  allAchievements: AllAchievement[];
  defaultExpanded?: boolean;
  showHeader?: boolean;
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatGameName(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1).replace("-", " ");
}

export function GameSection({
  game,
  playerId,
  recentMatches,
  headToHeadData,
  headToHeadLoading,
  allAchievements,
  defaultExpanded = true,
  showHeader = true,
}: GameSectionProps) {
  const totalGames = game.wins + game.losses + game.draws;
  const winRate = totalGames > 0 ? ((game.wins / totalGames) * 100).toFixed(1) : "0.0";
  const pointRatio = game.points_conceded > 0 ? game.points_scored / game.points_conceded : game.points_scored > 0 ? 999 : 0;

  // Achievement data for this game
  const unlockedIds = new Set(game.achievements.map(a => a.achievement_id));
  const unlockedDetails = new Map(game.achievements.map(a => [a.achievement_id, { count: a.count, first_earned_at: a.first_earned_at }]));
  const categoryProgress = buildCategoryProgress(allAchievements, unlockedIds);

  const rivalsOpponents = headToHeadData.get(game.game_id) || [];

  return (
    <div className={showHeader ? "bg-card rounded-2xl shadow-lg overflow-hidden" : ""}>
      {/* Game header */}
      {showHeader && (
      <div className="px-6 py-4 bg-gradient-to-r from-slate-100 to-slate-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {game.image_url ? (
            <img
              src={game.image_url}
              alt={game.game_name}
              className="w-8 h-8 rounded-lg object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-400 to-slate-500 flex items-center justify-center text-white text-sm">
              🎮
            </div>
          )}
          <h2 className="text-xl font-bold text-gray-900">
            {formatGameName(game.game_name)}
          </h2>
          <span className="text-sm text-gray-500">
            {game.score_type === 'best_of' ? `Best of ${game.score_value}` : `First to ${game.score_value}`}
          </span>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold font-mono text-primary">{game.elo.toFixed(3)}</div>
          <div className="text-xs text-gray-500">Rating</div>
        </div>
      </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-gray-100">
        <div className="bg-card p-4 text-center">
          <div className="text-2xl font-bold font-mono text-primary">{game.elo.toFixed(3)}</div>
          <div className="text-xs text-gray-500 mt-1">Rating</div>
        </div>
        <div className="bg-card p-4 text-center">
          <div className="text-2xl font-bold">{game.total_matches}</div>
          <div className="text-xs text-gray-500 mt-1">Matches</div>
        </div>
        <div className="bg-card p-4 text-center">
          <div className="text-2xl font-bold">
            <span className="text-green-600">{game.wins}</span>
            <span className="text-gray-300">/</span>
            <span className="text-red-600">{game.losses}</span>
            <span className="text-gray-300">/</span>
            <span className="text-gray-500">{game.draws}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">W/L/D</div>
        </div>
        <div className="bg-card p-4 text-center">
          <div className="text-2xl font-bold">{winRate}%</div>
          <div className="text-xs text-gray-500 mt-1">Win Rate</div>
        </div>
        <div className="bg-card p-4 text-center">
          <div className="text-2xl font-bold">
            <span className="text-green-600">{game.points_scored}</span>
            <span className="text-gray-300">-</span>
            <span className="text-red-600">{game.points_conceded}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">Points</div>
        </div>
        <div className="bg-card p-4 text-center">
          <div className={`text-2xl font-bold ${pointRatio >= 1 ? "text-green-600" : "text-red-600"}`}>
            {pointRatio >= 999 ? '∞' : pointRatio.toFixed(3)}
          </div>
          <div className="text-xs text-gray-500 mt-1">Point Ratio</div>
        </div>
      </div>

      {/* Records */}
      <div className="px-6 py-4 bg-gradient-to-r from-amber-50 to-orange-50 border-t border-amber-100">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🏆</span>
          <span className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Records</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Current form — the streak as of RIGHT NOW (W5/L2/D1, house convention) */}
          <div className="bg-card rounded-xl p-3 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">Current Form</div>
            <div className={`font-bold text-lg ${
              game.current_streak?.startsWith('W') ? 'text-green-700' :
              game.current_streak?.startsWith('L') ? 'text-red-700' :
              game.current_streak?.startsWith('D') ? 'text-blue-700' : 'text-gray-400'
            }`}>
              {game.current_streak?.startsWith('W') ? '🔥 ' :
               game.current_streak?.startsWith('L') ? '❄️ ' :
               game.current_streak?.startsWith('D') ? '🤝 ' : ''}
              {game.current_streak || '—'}
            </div>
            <div className="text-xs text-gray-400">streaks end with a result change</div>
          </div>
          <div className="bg-card rounded-xl p-3 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">Peak Rating</div>
            <div className="font-bold font-mono text-green-700 text-lg">{game.records.highest_elo.toFixed(3)}</div>
            {game.records.highest_elo_date && (
              <div className="text-xs text-gray-400">{formatDate(game.records.highest_elo_date)}</div>
            )}
          </div>
          <div className="bg-card rounded-xl p-3 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">Lowest Rating</div>
            <div className="font-bold font-mono text-red-700 text-lg">{game.records.lowest_elo.toFixed(3)}</div>
            {game.records.lowest_elo_date && (
              <div className="text-xs text-gray-400">{formatDate(game.records.lowest_elo_date)}</div>
            )}
          </div>
          <div className="bg-card rounded-xl p-3 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">Best Win Streak</div>
            <div className="font-bold text-green-700 text-lg">{game.records.longest_win_streak} 🔥</div>
            {game.records.longest_win_streak_start && game.records.longest_win_streak_end && (
              <div className="text-xs text-gray-400">
                {formatDate(game.records.longest_win_streak_start)}
                {game.records.longest_win_streak_start !== game.records.longest_win_streak_end && (
                  <> - {formatDate(game.records.longest_win_streak_end)}</>
                )}
              </div>
            )}
          </div>
          <div className="bg-card rounded-xl p-3 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">Worst Lose Streak</div>
            <div className="font-bold text-red-700 text-lg">{game.records.longest_lose_streak} 😢</div>
            {game.records.longest_lose_streak_start && game.records.longest_lose_streak_end && (
              <div className="text-xs text-gray-400">
                {formatDate(game.records.longest_lose_streak_start)}
                {game.records.longest_lose_streak_start !== game.records.longest_lose_streak_end && (
                  <> - {formatDate(game.records.longest_lose_streak_end)}</>
                )}
              </div>
            )}
          </div>
          <div className="bg-card rounded-xl p-3 shadow-sm">
            <div className="text-xs text-gray-500 mb-1">Unbeaten Run</div>
            <div className="font-bold text-blue-700 text-lg">{game.records.longest_unbeaten_streak} 💪</div>
            {game.records.longest_unbeaten_streak_start && game.records.longest_unbeaten_streak_end && (
              <div className="text-xs text-gray-400">
                {formatDate(game.records.longest_unbeaten_streak_start)}
                {game.records.longest_unbeaten_streak_start !== game.records.longest_unbeaten_streak_end && (
                  <> - {formatDate(game.records.longest_unbeaten_streak_end)}</>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Notable Matches */}
      {(game.records.biggest_gain || game.records.biggest_loss) && (
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">⚡</span>
            <span className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Notable Matches</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {game.records.biggest_gain && (
              <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-green-800">Biggest Gain</span>
                  <span className="font-mono text-lg font-bold text-green-600">+{game.records.biggest_gain.gain.toFixed(3)}</span>
                </div>
                <div className="text-sm text-gray-600">
                  {game.records.biggest_gain.teammates && game.records.biggest_gain.teammates.length > 0 && (
                    <>
                      <span className="text-gray-500">with </span>
                      <span className="font-medium">{game.records.biggest_gain.teammates.join(", ")}</span>
                      <span className="text-gray-400 mx-1">vs</span>
                    </>
                  )}
                  {(!game.records.biggest_gain.teammates || game.records.biggest_gain.teammates.length === 0) && (
                    <span className="text-gray-400">vs </span>
                  )}
                  {game.records.biggest_gain.opponents.join(", ")}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="font-bold text-lg">
                    <span className="text-green-600">{game.records.biggest_gain.score}</span>
                    <span className="text-gray-400 mx-1">-</span>
                    <span>{game.records.biggest_gain.opponent_score}</span>
                  </span>
                  <span className="text-xs text-gray-400">{formatDate(game.records.biggest_gain.date)}</span>
                </div>
              </div>
            )}
            {game.records.biggest_loss && (
              <div className="bg-gradient-to-br from-red-50 to-rose-50 border border-red-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-red-800">Biggest Loss</span>
                  <span className="font-mono text-lg font-bold text-red-600">{game.records.biggest_loss.loss.toFixed(3)}</span>
                </div>
                <div className="text-sm text-gray-600">
                  {game.records.biggest_loss.teammates && game.records.biggest_loss.teammates.length > 0 && (
                    <>
                      <span className="text-gray-500">with </span>
                      <span className="font-medium">{game.records.biggest_loss.teammates.join(", ")}</span>
                      <span className="text-gray-400 mx-1">vs</span>
                    </>
                  )}
                  {(!game.records.biggest_loss.teammates || game.records.biggest_loss.teammates.length === 0) && (
                    <span className="text-gray-400">vs </span>
                  )}
                  {game.records.biggest_loss.opponents.join(", ")}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="font-bold text-lg">
                    <span>{game.records.biggest_loss.score}</span>
                    <span className="text-gray-400 mx-1">-</span>
                    <span className="text-red-600">{game.records.biggest_loss.opponent_score}</span>
                  </span>
                  <span className="text-xs text-gray-400">{formatDate(game.records.biggest_loss.date)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Category Progress Bars */}
      <CategoryProgressBars
        categories={categoryProgress}
        totalUnlocked={unlockedIds.size}
        totalPossible={allAchievements.length}
      />

      {/* Full Achievement Checklist */}
      <AchievementChecklist
        allAchievements={allAchievements}
        unlockedIds={unlockedIds}
        unlockedDetails={unlockedDetails}
      />

      {/* Head to Head - Rivals Section */}
      <RivalsSection
        gameId={game.game_id}
        gameName={game.game_name}
        playerId={playerId}
        opponents={rivalsOpponents}
        isLoading={headToHeadLoading.has(game.game_id)}
      />

      {/* Elo History Chart */}
      <EloChart eloHistory={game.elo_history} />

      {/* Recent matches */}
      <RecentMatches matches={recentMatches} />
    </div>
  );
}