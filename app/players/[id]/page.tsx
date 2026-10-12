"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { PlayerHeader } from "./components/PlayerHeader";
import { CareerHighlights } from "./components/CareerHighlights";
import { GameTabBar } from "./components/GameTabBar";
import { GameSection } from "./components/GameSection";
import { GamblingSection } from "./components/GamblingSection";

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

interface AllAchievement {
  id: number;
  name: string;
  description: string;
  category: string;
  icon: string | null;
}

interface GameStat {
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
  achievements: Achievement[];
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

interface PlayerStats {
  player: {
    id: number;
    name: string;
    status: string;
    created_at: string;
    first_played_at: string | null;
    avatar_url?: string | null;
  };
  overallStats: {
    total_matches: number;
    total_wins: number;
    total_losses: number;
    total_draws: number;
    total_points_scored: number;
    total_points_conceded: number;
  };
  gameStats: GameStat[];
  recentMatches: RecentMatch[];
  allAchievements: AllAchievement[];
}

function formatGameName(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1).replace("-", " ");
}

export default function PlayerProfilePage() {
  const params = useParams();
  const router = useRouter();
  const playerId = params.id as string;
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  // season view: 'current' (default) | 'alltime' | a specific season id
  const [seasonView, setSeasonView] = useState<'current' | 'alltime' | number>('current');
  const [seasons, setSeasons] = useState<{ id: number; name: string; start_date: string; end_date: string | null; is_current: boolean }[]>([]);
  const [currentSeasonId, setCurrentSeasonId] = useState<number | null>(null);

  // Scope params for stats/head-to-head fetches
  const scopeParams = seasonView === 'alltime'
    ? '&scope=alltime'
    : seasonView !== 'current'
      ? `&season_id=${seasonView}`
      : '';
  const [headToHeadData, setHeadToHeadData] = useState<Map<number, HeadToHeadOpponent[]>>(new Map());
  const [headToHeadLoading, setHeadToHeadLoading] = useState<Set<number>>(new Set());
  const [expandedGames, setExpandedGames] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetch('/api/seasons')
      .then((res) => res.json())
      .then((data) => {
        setSeasons(data.seasons || []);
        setCurrentSeasonId(data.current_season_id ?? null);
      })
      .catch((err) => console.error('Failed to load seasons:', err));
  }, []);

  useEffect(() => {
    fetch(`/api/player-stats?player_id=${playerId}${scopeParams}`)
      .then((res) => {
        if (!res.ok) throw new Error("Player not found");
        return res.json();
      })
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [playerId, seasonView]);

  const loadHeadToHead = (gameId: number) => {
    if (headToHeadData.has(gameId) || headToHeadLoading.has(gameId)) return;

    setHeadToHeadLoading(prev => new Set(prev).add(gameId));
    fetch(`/api/head-to-head?player_id=${playerId}&game_id=${gameId}${scopeParams}`)
      .then(res => res.json())
      .then(data => {
        setHeadToHeadData(prev => {
          const next = new Map(prev);
          next.set(gameId, data.opponents || []);
          return next;
        });
      })
      .catch(err => console.error('Failed to load head-to-head:', err))
      .finally(() => {
        setHeadToHeadLoading(prev => {
          const next = new Set(prev);
          next.delete(gameId);
          return next;
        });
      });
  };

  // Load head-to-head data when a specific game tab is selected
  useEffect(() => {
    if (selectedGameId !== null) {
      loadHeadToHead(selectedGameId);
    }
  }, [selectedGameId, seasonView, scopeParams]);

  // Group matches by game
  const matchesByGame: Record<number, RecentMatch[]> = {};
  if (stats) {
    for (const match of stats.recentMatches) {
      if (!matchesByGame[match.game_id]) {
        matchesByGame[match.game_id] = [];
      }
      matchesByGame[match.game_id].push(match);
    }
  }

  // Compute overall achievement progress (distinct IDs earned across any game)
  const allAchievementIds = new Set(stats?.allAchievements.map(a => a.id) || []);
  const distinctUnlockedIds = new Set<number>();
  if (stats) {
    for (const game of stats.gameStats) {
      for (const a of game.achievements) {
        distinctUnlockedIds.add(a.achievement_id);
      }
    }
  }
  const achievementTotal = stats?.allAchievements.length || 0;
  const achievementUnlocked = distinctUnlockedIds.size;

  // Compute per-game achievement unlocked counts for the tab
  const gameAchievementCounts = new Map<number, number>();
  if (stats) {
    for (const game of stats.gameStats) {
      gameAchievementCounts.set(game.game_id, game.achievements.length);
    }
  }

  // For the header ring, when a specific game is selected, show that game's count
  const headerUnlocked = selectedGameId !== null && stats
    ? (stats.gameStats.find(g => g.game_id === selectedGameId)?.achievements.length || 0)
    : achievementUnlocked;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
          <div className="text-4xl mb-3">😕</div>
          <div className="text-red-700 font-semibold mb-2">{error || "Player not found"}</div>
          <button
            onClick={() => router.push("/players")}
            className="text-primary hover:underline font-medium"
          >
            ← Back to Players
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Back link */}
      <Link
        href="/players"
        className="inline-flex items-center gap-2 text-gray-500 hover:text-primary transition-colors mb-6"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Players
      </Link>

      {/* Player Header with Achievement Ring */}
      <PlayerHeader
        player={stats.player}
        achievementUnlocked={headerUnlocked}
        achievementTotal={achievementTotal}
        onStatusChange={(newStatus) => {
          setStats({ ...stats, player: { ...stats.player, status: newStatus } });
        }}
        onAvatarChange={(avatarUrl) => {
          setStats({ ...stats, player: { ...stats.player, avatar_url: avatarUrl } });
        }}
      />

      {/* Season scope picker: current season, any past season, or all time */}
      <div className="mb-6 flex items-center gap-3">
        <select
          value={seasonView === 'alltime' ? 'alltime' : seasonView === 'current' ? `current:${currentSeasonId}` : String(seasonView)}
          onChange={(e) => {
            const val = e.target.value;
            setHeadToHeadData(new Map());
            setHeadToHeadLoading(new Set());
            if (val === 'alltime') {
              setSeasonView('alltime');
            } else if (val.startsWith('current:') || val === String(currentSeasonId)) {
              setSeasonView('current');
            } else {
              setSeasonView(parseInt(val, 10));
            }
          }}
          className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-300 transition-colors text-sm font-medium"
        >
          <option value={`current:${currentSeasonId}`}>
            {seasons.find(s => s.id === currentSeasonId)?.name ?? 'Current Season'}
          </option>
          {seasons.filter(s => s.id !== currentSeasonId).map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          <option value="alltime">🏆 All Time</option>
        </select>
        {seasonView !== 'alltime' && (
          <span className="text-xs text-gray-400">
            {seasonView === 'current' ? 'season skill resets to 0 at each season start' : 'viewing a past season'}
          </span>
        )}
      </div>

      {/* Career Highlights */}
      <CareerHighlights
        gameStats={stats.gameStats}
        totalAchievementsUnlocked={achievementUnlocked}
        totalAchievementsPossible={achievementTotal}
      />

      {/* Game Tab Navigation */}
      {stats.gameStats.length > 0 && (
        <GameTabBar
          games={stats.gameStats.map(g => ({
            id: g.game_id,
            name: g.game_name,
            image_url: g.image_url || null,
            elo: g.elo,
          }))}
          selectedGameId={selectedGameId}
          onSelect={setSelectedGameId}
        />
      )}

      {/* Game Content */}
      {stats.gameStats.length === 0 ? (
        <div className="text-center py-16 bg-card rounded-2xl shadow-lg">
          <div className="text-6xl mb-4">🎮</div>
          <p className="text-gray-500 text-lg">No games played yet</p>
          <Link
            href="/matches/new"
            className="inline-block mt-4 px-6 py-3 bg-primary text-white rounded-xl font-semibold hover:bg-primary-hover transition-all shadow-lg hover:shadow-xl"
          >
            Record First Match
          </Link>
        </div>
      ) : selectedGameId !== null ? (
        /* Single game view */
        stats.gameStats.filter(g => g.game_id === selectedGameId).map((game) => (
          <GameSection
            key={game.game_id}
            game={game}
            playerId={parseInt(playerId)}
            recentMatches={matchesByGame[game.game_id] || []}
            headToHeadData={headToHeadData}
            headToHeadLoading={headToHeadLoading}
            allAchievements={stats.allAchievements}
          />
        ))
      ) : (
        /* All games view — collapsed summaries */
        <div className="space-y-3">
          {stats.gameStats.map((game) => {
            const isExpanded = expandedGames.has(game.game_id);
            const unlockedCount = game.achievements.length;
            const gameMatches = matchesByGame[game.game_id] || [];

            return (
              <div key={game.game_id} className="bg-card rounded-2xl shadow-lg overflow-hidden">
                {/* Game header - clickable */}
                <button
                  onClick={() => {
                    setExpandedGames(prev => {
                      const next = new Set(prev);
                      if (next.has(game.game_id)) {
                        next.delete(game.game_id);
                      } else {
                        next.add(game.game_id);
                        loadHeadToHead(game.game_id);
                      }
                      return next;
                    });
                  }}
                  className="w-full px-6 py-4 bg-gradient-to-r from-slate-100 to-slate-50 hover:from-slate-150 hover:to-slate-100 transition-colors flex items-center justify-between"
                >
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
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-amber-600 font-medium">🏅 {unlockedCount}/{achievementTotal}</span>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold font-mono text-primary">{game.elo.toFixed(3)}</div>
                      <div className="text-xs text-gray-500">Rating</div>
                    </div>
                    <svg
                      className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </button>

                {/* Expanded content - reuse GameSection content */}
                {isExpanded && (
                  <GameSection
                    game={game}
                    playerId={parseInt(playerId)}
                    recentMatches={gameMatches}
                    headToHeadData={headToHeadData}
                    headToHeadLoading={headToHeadLoading}
                    allAchievements={stats.allAchievements}
                    showHeader={false}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Gambling record — virtual-moose-bucks ledger for this player */}
      <GamblingSection playerId={parseInt(playerId)} />
    </div>
  );
}