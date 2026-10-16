"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useSelectedGame } from "@/lib/hooks/useSelectedGame";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { parsePointTimeline, computeTimelineStats, formatDuration } from "@/lib/timeline";

interface Game {
  id: number;
  name: string;
}

interface Player {
  id: number;
  name: string;
}

interface MatchAchievement {
  achievement_id: number;
  achievement_name: string;
  achievement_description: string;
  achievement_icon: string | null;
  player_id: number;
  player_name: string;
}

interface PunditryFact {
  type: string;
  player_id: number;
  player_name: string;
  description: string;
}

interface Match {
  id: number;
  game_id: number;
  played_at: string;
  notes: string | null;
  is_edited?: number;
  edited_at?: string | null;
  points_timeline?: string | null;
  game_name: string;
  participants: {
    id: number;
    match_id: number;
    player_id: number;
    team: number;
    score: number;
    elo_before: number;
    elo_after: number;
    player_name: string;
    avatar_url?: string | null;
  }[];
  achievements?: MatchAchievement[];
  punditry?: PunditryFact[];
}

/** Estimated duration of a live-tracked match (null when not live-tracked). */
function liveDurationMs(match: Match): number | null {
  const tl = parsePointTimeline(match.points_timeline);
  if (!tl || tl.events.length === 0) return null;
  const teamSet = new Set(match.participants.map((p) => p.team));
  const teamScores = Array.from(teamSet).sort((a, b) => a - b).map((team) =>
    match.participants.filter((p) => p.team === team).reduce((sum, p) => sum + p.score, 0)
  );
  return computeTimelineStats(tl, teamScores).durationMs;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function MatchesPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { selectedGameId } = useSelectedGame();

  // Get initial values from URL params
  const initialPage = parseInt(searchParams.get('page') || '1', 10);
  const initialLimit = parseInt(searchParams.get('limit') || '20', 10);
  const initialDateFrom = searchParams.get('date_from') || '';
  const initialDateTo = searchParams.get('date_to') || '';
  const initialPlayerIds = searchParams.get('player_ids')?.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id)) || [];
  const initialPlayerCount = searchParams.get('player_count') || '';
  const initialHasAchievements = searchParams.get('has_achievements') === 'true';
  const initialMinSkillChange = searchParams.get('min_skill_change') || '';

  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [editScores, setEditScores] = useState<{ [team: number]: string }>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination state (separate from API response)
  const [page, setPage] = useState(initialPage);
  const [limit, setLimit] = useState(initialLimit);
  const totalPages = Math.ceil(totalMatches / limit);

  // Filter state
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>(initialPlayerIds);
  const [playerCount, setPlayerCount] = useState(initialPlayerCount);
  const [hasAchievements, setHasAchievements] = useState(initialHasAchievements);
  const [minSkillChange, setMinSkillChange] = useState(initialMinSkillChange);
  const [showFilters, setShowFilters] = useState(false);
  // Season scoping: 'current' (default) | 'alltime' | a season id. The Elo
  // deltas shown per match depend on the ledger in view.
  const [seasonView, setSeasonView] = useState<'current' | 'alltime' | number>('current');
  const [seasons, setSeasons] = useState<{ id: number; name: string; start_date: string; end_date: string | null; is_current: boolean }[]>([]);
  const [currentSeasonId, setCurrentSeasonId] = useState<number | null>(null);

  // Build URL params for API call and navigation
  const buildQueryParams = (pageArg?: number, limitArg?: number) => {
    const params = new URLSearchParams();
    if (selectedGameId) params.set('game_id', selectedGameId.toString());
    params.set('page', (pageArg ?? page).toString());
    params.set('limit', (limitArg ?? limit).toString());
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (selectedPlayerIds.length > 0) params.set('player_ids', selectedPlayerIds.join(','));
    if (playerCount) params.set('player_count', playerCount);
    if (hasAchievements) params.set('has_achievements', 'true');
    if (minSkillChange) params.set('min_skill_change', minSkillChange);
    if (seasonView === 'alltime') params.set('scope', 'alltime');
    if (seasonView !== 'alltime' && seasonView !== 'current') params.set('season_id', String(seasonView));
    return params;
  };

  // Update URL without triggering fetch
  const updateUrl = (pageArg?: number, limitArg?: number) => {
    const params = buildQueryParams(pageArg, limitArg);
    router.push(`/matches?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    fetch("/api/players")
      .then((res) => res.json())
      .then((data: Player[]) => setPlayers(data));
    fetch("/api/seasons")
      .then((res) => res.json())
      .then((data) => {
        setSeasons(data.seasons || []);
        setCurrentSeasonId(data.current_season_id ?? null);
      });
  }, []);

  useEffect(() => {
    if (selectedGameId) {
      setLoading(true);
      const params = buildQueryParams();
      fetch(`/api/matches?${params.toString()}`)
        .then((res) => res.json())
        .then((data) => {
          setMatches(data.matches);
          setTotalMatches(data.pagination.total);
          setLoading(false);
        });
    }
  }, [selectedGameId, page, limit, dateFrom, dateTo, JSON.stringify(selectedPlayerIds), playerCount, hasAchievements, minSkillChange, seasonView]);

  const selectSeasonView = (view: 'current' | 'alltime' | number) => {
    setSeasonView(view);
    setPage(1);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatRatingChange = (before: number, after: number) => {
    const diff = after - before;
    const sign = diff >= 0 ? "+" : "";
    return `${sign}${diff.toFixed(3)}`;
  };

  const getTeamResult = (match: Match, team: number) => {
    const teamParticipants = match.participants.filter((p) => p.team === team);
    const otherTeam = match.participants.find((p) => p.team !== team);
    if (!otherTeam) return { result: "unknown", score: 0 };

    const teamScore = teamParticipants[0]?.score ?? 0;
    const otherScore = otherTeam.score;
    const isDraw = teamScore === otherScore;

    // Find the max score to determine winner
    const allScores = match.participants.map((p) => p.score);
    const maxScore = Math.max(...allScores);

    if (isDraw) {
      return { result: "draw" as const, score: teamScore };
    } else if (teamScore === maxScore) {
      return { result: "win" as const, score: teamScore };
    } else {
      return { result: "loss" as const, score: teamScore };
    }
  };

  const getTeams = (match: Match) => {
    const teamSet = new Set(match.participants.map((p) => p.team));
    return Array.from(teamSet).sort((a, b) => a - b);
  };

  const isWithinEditWindow = (playedAt: string) => {
    const matchTime = new Date(playedAt.replace(" ", "T"));
    const now = new Date();
    const hoursSince = (now.getTime() - matchTime.getTime()) / (1000 * 60 * 60);
    return hoursSince <= 24;
  };

  const canEdit = (match: Match) => {
    return isWithinEditWindow(match.played_at);
  };

  const startEdit = (match: Match) => {
    const teams = getTeams(match);
    const scores: { [team: number]: string } = {};
    for (const team of teams) {
      const teamParticipants = match.participants.filter((p) => p.team === team);
      scores[team] = String(teamParticipants[0]?.score ?? 0);
    }
    setEditScores(scores);
    setEditingMatch(match);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingMatch(null);
    setEditScores({});
    setError(null);
  };

  const saveEdit = async (match: Match) => {
    setSaving(true);
    setError(null);

    const teams = getTeams(match);
    const teamsData = teams.map((team) => {
      const teamParticipants = match.participants.filter((p) => p.team === team);
      return {
        team,
        player_ids: teamParticipants.map((p) => p.player_id),
        score: parseInt(editScores[team] || "0", 10),
      };
    });

    try {
      const res = await fetch(`/api/matches/${match.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teams: teamsData }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update match");
      }

      // Refresh matches
      const params = buildQueryParams();
      const matchesRes = await fetch(`/api/matches?${params.toString()}`);
      const matchesData = await matchesRes.json();
      setMatches(matchesData.matches);
      setTotalMatches(matchesData.pagination.total);
      setEditingMatch(null);
      setEditScores({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update match");
    } finally {
      setSaving(false);
    }
  };

  const deleteMatch = async (match: Match) => {
    if (!confirm("Are you sure you want to delete this match? This cannot be undone.")) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/matches/${match.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete match");
      }

      // Refresh matches
      const params = buildQueryParams();
      const matchesRes = await fetch(`/api/matches?${params.toString()}`);
      const matchesData = await matchesRes.json();
      setMatches(matchesData.matches);
      setTotalMatches(matchesData.pagination.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete match");
    } finally {
      setSaving(false);
    }
  };

  const goToPage = (newPage: number) => {
    const clampedPage = Math.max(1, Math.min(newPage, totalPages || 1));
    setPage(clampedPage);
    updateUrl(clampedPage);
  };

  const changeLimit = (newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
    updateUrl(1, newLimit);
  };

  const clearFilters = () => {
    setDateFrom('');
    setDateTo('');
    setSelectedPlayerIds([]);
    setPlayerCount('');
    setHasAchievements(false);
    setMinSkillChange('');
    setPage(1);
  };

  const hasActiveFilters = dateFrom || dateTo || selectedPlayerIds.length > 0 || playerCount || hasAchievements || minSkillChange;

  const togglePlayer = (playerId: number) => {
    setSelectedPlayerIds(prev =>
      prev.includes(playerId)
        ? prev.filter(id => id !== playerId)
        : [...prev, playerId]
    );
    setPage(1);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Match History</h1>
        <div className="flex items-center gap-3">
          {/* Season scope: Elo swings per match are ledger-specific */}
          <select
            value={seasonView === 'current' ? `current:${currentSeasonId}` : String(seasonView)}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'alltime') selectSeasonView('alltime');
              else if (val.startsWith('current:') || val === String(currentSeasonId)) selectSeasonView('current');
              else selectSeasonView(parseInt(val, 10));
            }}
            className="bg-card border border-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors font-medium"
          >
            {currentSeasonId === null ? (
              <option value="current:0">Loading seasons…</option>
            ) : (
              <option value={`current:${currentSeasonId}`}>
                {seasons.find(s => s.id === currentSeasonId)?.name ?? 'Current Season'}
              </option>
            )}
            {seasons.filter(s => s.id !== currentSeasonId).map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="alltime">🏆 All Time</option>
          </select>
          <Link
          href={selectedGameId ? `/matches/new?game=${selectedGameId}` : "/matches/new"}
          className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-hover transition-all shadow-sm hover:shadow-md font-medium"
        >
          + Record Match
        </Link>
        </div>
      </div>

      <div className="mb-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-4 py-2 rounded-lg font-medium transition-all ${
              showFilters
                ? 'bg-slate-800 text-white'
                : hasActiveFilters
                ? 'bg-primary text-white'
                : 'bg-card border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {showFilters ? '✕ Hide Filters' : hasActiveFilters ? '🔍 Filters (active)' : '🔍 Filters'}
          </button>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-sm text-red-600 hover:text-red-800 font-medium"
            >
              Clear all
            </button>
          )}
        </div>

        {showFilters && (
          <div className="bg-card rounded-xl shadow-lg p-5 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Date From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Date To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Player Count</label>
                <input
                  type="number"
                  min="2"
                  max="20"
                  value={playerCount}
                  onChange={(e) => { setPlayerCount(e.target.value); setPage(1); }}
                  placeholder="Any"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Min Skill Change</label>
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={minSkillChange}
                  onChange={(e) => { setMinSkillChange(e.target.value); setPage(1); }}
                  placeholder="Any"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Players (must include all selected)</label>
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-3 bg-gray-50 rounded-lg">
                {players.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => togglePlayer(player.id)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-full transition-all ${
                      selectedPlayerIds.includes(player.id)
                        ? 'bg-primary text-white shadow-sm'
                        : 'bg-card border border-gray-300 text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    {player.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasAchievements}
                  onChange={(e) => { setHasAchievements(e.target.checked); setPage(1); }}
                  className="w-5 h-5 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <span className="text-sm text-gray-700 font-medium">Only matches with achievements 🏆</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500">Loading...</div>
      ) : matches.length === 0 ? (
        <div className="text-gray-500">
          No matches recorded yet.{" "}
          <Link href={selectedGameId ? `/matches/new?game=${selectedGameId}` : "/matches/new"} className="text-primary hover:underline">
            Record your first match
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {matches.map((match) => {
            const teams = getTeams(match);
            const team0Result = getTeamResult(match, teams[0]);
            const team1Result = getTeamResult(match, teams[1]);
            const isEditing = editingMatch?.id === match.id;
            const editable = canEdit(match);

            return (
              <div key={match.id} className="bg-card rounded-xl shadow-lg overflow-hidden hover:shadow-xl transition-shadow">
                {/* Match Header */}
                <div className="flex justify-between items-center px-5 py-3 bg-gray-50 border-b border-gray-100">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">{formatDate(match.played_at)}</span>
                    {liveDurationMs(match) !== null && (
                      <span
                        className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full font-mono"
                        title="Live-tracked duration"
                      >
                        ⏱ {formatDuration(liveDurationMs(match)!)}
                      </span>
                    )}
                    {match.is_edited === 1 && (
                      <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full font-medium">
                        ✏️ Edited
                      </span>
                    )}
                    {match.punditry && match.punditry.length > 0 && (
                      <span className="text-sm" title="This match has punditry">
                        🎙️
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {match.notes && (
                      <div className="text-sm text-gray-500 italic">"{match.notes}"</div>
                    )}
                    <Link
                      href={`/matches/${match.id}`}
                      className="text-sm text-gray-500 hover:text-primary transition-colors"
                    >
                      View →
                    </Link>
                    {editable && !isEditing && (
                      <button
                        onClick={() => startEdit(match)}
                        className="text-sm text-gray-500 hover:text-primary transition-colors"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>

                {/* VS Layout */}
                <div className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    {/* Team 1 */}
                    <div className={`flex-1 rounded-xl p-4 ${
                      team0Result.result === "win"
                        ? "bg-gradient-to-br from-blue-500 to-blue-600 text-white"
                        : team0Result.result === "loss"
                        ? "bg-gray-100 text-gray-700"
                        : "bg-gray-100 text-gray-700"
                    }`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className={`text-xs font-semibold uppercase tracking-wide ${
                          team0Result.result === "win" ? "text-white/80" : "text-gray-500"
                        }`}>
                          {team0Result.result === "win" ? "🏆 Winner" : "Team 1"}
                        </span>
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            value={editScores[teams[0]] ?? "0"}
                            onChange={(e) => setEditScores({ ...editScores, [teams[0]]: e.target.value })}
                            className="w-16 px-2 py-1 text-2xl font-bold text-center border border-gray-300 rounded text-gray-900"
                          />
                        ) : (
                          <span className="text-4xl font-bold">{team0Result.score}</span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {match.participants.filter(p => p.team === teams[0]).map((p) => (
                          <div key={p.player_id} className="flex items-center justify-between gap-2">
                            <Link
                              href={`/players/${p.player_id}`}
                              className={`flex items-center gap-2 min-w-0 font-medium hover:underline ${team0Result.result === "win" ? "text-white" : "text-gray-900"}`}
                            >
                              <PlayerAvatar name={p.player_name} avatarUrl={p.avatar_url} size={28} roundedClass="rounded-lg" />
                              <span className="truncate">{p.player_name}</span>
                            </Link>
                            {!isEditing && (
                              <span className={`text-sm font-mono ${
                                p.elo_after > p.elo_before
                                  ? team0Result.result === "win" ? "text-white/80" : "text-green-600"
                                  : p.elo_after < p.elo_before
                                  ? team0Result.result === "win" ? "text-white/80" : "text-red-500"
                                  : team0Result.result === "win" ? "text-white/80" : "text-gray-400"
                              }`}>
                                {formatRatingChange(p.elo_before, p.elo_after)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* VS */}
                    <div className="flex-shrink-0 flex flex-col items-center">
                      <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold text-sm">
                        VS
                      </div>
                    </div>

                    {/* Team 2 */}
                    <div className={`flex-1 rounded-xl p-4 ${
                      team1Result.result === "win"
                        ? "bg-gradient-to-br from-red-500 to-red-600 text-white"
                        : team1Result.result === "loss"
                        ? "bg-gray-100 text-gray-700"
                        : "bg-gray-100 text-gray-700"
                    }`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className={`text-xs font-semibold uppercase tracking-wide ${
                          team1Result.result === "win" ? "text-white/80" : "text-gray-500"
                        }`}>
                          {team1Result.result === "win" ? "🏆 Winner" : "Team 2"}
                        </span>
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            value={editScores[teams[1]] ?? "0"}
                            onChange={(e) => setEditScores({ ...editScores, [teams[1]]: e.target.value })}
                            className="w-16 px-2 py-1 text-2xl font-bold text-center border border-gray-300 rounded text-gray-900"
                          />
                        ) : (
                          <span className="text-4xl font-bold">{team1Result.score}</span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {match.participants.filter(p => p.team === teams[1]).map((p) => (
                          <div key={p.player_id} className="flex items-center justify-between gap-2">
                            <Link
                              href={`/players/${p.player_id}`}
                              className={`flex items-center gap-2 min-w-0 font-medium hover:underline ${team1Result.result === "win" ? "text-white" : "text-gray-900"}`}
                            >
                              <PlayerAvatar name={p.player_name} avatarUrl={p.avatar_url} size={28} roundedClass="rounded-lg" />
                              <span className="truncate">{p.player_name}</span>
                            </Link>
                            {!isEditing && (
                              <span className={`text-sm font-mono ${
                                p.elo_after > p.elo_before
                                  ? team1Result.result === "win" ? "text-white/80" : "text-green-600"
                                  : p.elo_after < p.elo_before
                                  ? team1Result.result === "win" ? "text-white/80" : "text-red-500"
                                  : team1Result.result === "win" ? "text-white/80" : "text-gray-400"
                              }`}>
                                {formatRatingChange(p.elo_before, p.elo_after)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Achievements */}
                {match.achievements && match.achievements.length > 0 && (
                  <div className="px-5 py-3 bg-gradient-to-r from-amber-50 to-yellow-50 border-t border-amber-200">
                    <div className="flex flex-wrap gap-2">
                      {match.achievements.map((achievement, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1.5 text-xs bg-card text-amber-900 border border-amber-200 rounded-full px-3 py-1.5 shadow-sm hover:shadow transition-shadow"
                          title={achievement.achievement_description}
                        >
                          <span className="text-base">{achievement.achievement_icon || '🏅'}</span>
                          <span className="font-semibold">{achievement.player_name}</span>
                          <span className="text-amber-600">{achievement.achievement_name.replace(/_/g, ' ')}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Edit Controls */}
                {isEditing && (
                  <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex gap-3">
                    <button
                      onClick={() => saveEdit(match)}
                      disabled={saving}
                      className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 font-medium"
                    >
                      {saving ? "Saving..." : "Save Changes"}
                    </button>
                    <button
                      onClick={cancelEdit}
                      disabled={saving}
                      className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-300 transition-colors font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => deleteMatch(match)}
                      disabled={saving}
                      className="ml-auto bg-red-100 text-red-700 px-4 py-2 rounded-lg hover:bg-red-200 transition-colors font-medium"
                    >
                      Delete Match
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalMatches > 0 && (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 bg-card rounded-xl shadow-lg p-5">
          <div className="text-sm text-gray-600">
            Showing <span className="font-semibold text-gray-900">{((page - 1) * limit) + 1}</span>
            {' '}-{' '}
            <span className="font-semibold text-gray-900">{Math.min(page * limit, totalMatches)}</span>
            {' '}of{' '}
            <span className="font-semibold text-gray-900">{totalMatches}</span> matches
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              ← Previous
            </button>

            <div className="flex items-center gap-1">
              {page > 2 && (
                <>
                  <button
                    onClick={() => goToPage(1)}
                    className="w-9 h-9 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    1
                  </button>
                  {page > 3 && <span className="px-1 text-gray-400">...</span>}
                </>
              )}

              {page > 1 && (
                <button
                  onClick={() => goToPage(page - 1)}
                  className="w-9 h-9 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {page - 1}
                </button>
              )}

              <span className="w-9 h-9 flex items-center justify-center text-sm font-bold bg-primary text-white rounded-lg">
                {page}
              </span>

              {page < totalPages && (
                <button
                  onClick={() => goToPage(page + 1)}
                  className="w-9 h-9 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {page + 1}
                </button>
              )}

              {page < totalPages - 1 && (
                <>
                  {page < totalPages - 2 && <span className="px-1 text-gray-400">...</span>}
                  <button
                    onClick={() => goToPage(totalPages)}
                    className="w-9 h-9 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    {totalPages}
                  </button>
                </>
              )}
            </div>

            <button
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>

            <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-200">
              <span className="text-sm text-gray-600">Per page:</span>
              <select
                value={limit}
                onChange={(e) => changeLimit(Number(e.target.value))}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-medium"
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MatchesPage() {
  return (
    <Suspense fallback={<div className="text-gray-500">Loading...</div>}>
      <MatchesPageContent />
    </Suspense>
  );
}