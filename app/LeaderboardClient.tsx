"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSelectedGame } from "@/lib/hooks/useSelectedGame";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { SeasonalDecor } from "@/components/SeasonalDecor";
import { TrendSparkline } from "@/components/TrendSparkline";
import type { LeaderboardEntry } from "@/lib/types";
import type { SeasonalTheme } from "@/lib/seasonalTheme";
import { NO_SEASONAL_THEME } from "@/lib/seasonalTheme";
import { useSeasonalEffects } from "@/lib/hooks/useSeasonalEffects";
import type { GameStats, GameRecords } from "@/lib/data";

interface LeaderboardClientProps {
  initialLeaderboard: LeaderboardEntry[];
  initialStats: GameStats;
  initialRecords: GameRecords;
  currentSeasonId: number;
  seasonalTheme: SeasonalTheme;
}

/**
 * Small inline control next to the seasonal badge: lets people silence the
 * festive effects without a trip to Settings, or undo it if they have.
 */
function SeasonalInlineToggle({
  theme,
  enabled,
  onToggle,
}: {
  theme: SeasonalTheme;
  enabled: boolean;
  onToggle: () => void;
}) {
  if (enabled) {
    return (
      <button
        onClick={onToggle}
        title="Hide seasonal flair (your preference is saved per browser — re-enable any time in Settings)"
        className="text-xs text-gray-400 hover:text-gray-600 transition-colors ml-0.5"
      >
        ✕
      </button>
    );
  }
  return (
    <button
      onClick={onToggle}
      title="Seasonal flair is switched off for this browser — click to bring it back"
      className="text-xs text-gray-400 hover:text-gray-600 transition-colors underline decoration-dotted underline-offset-4"
    >
      {theme.titleEmoji} Seasonal flair hidden — show
    </button>
  );
}

interface SeasonInfo {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  is_current: boolean;
  is_queued?: boolean;
}

/** Parse a DB datetime string (UTC) for display/countdowns. */
function parseDbDate(dateStr: string): Date {
  return new Date(`${dateStr.replace(' ', 'T')}Z`);
}

function formatDbDate(dateStr: string): string {
  return parseDbDate(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Human countdown from now to a future date. */
function formatCountdown(target: Date, now: Date): string {
  const ms = Math.max(0, target.getTime() - now.getTime());
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

interface EmptyStateProps {
  seasonView: 'current' | 'alltime' | number;
  viewedSeason: SeasonInfo | null;
  selectedGameId: number | null;
  /** Matches played in the viewed season (0 for other scopes). */
  seasonMatchCount: number;
  /** Ticking clock from the parent (client-only; null at first paint). */
  now: Date | null;
}

/**
 * Empty leaderboard, with season-aware explanations:
 *  - an upcoming (queued, not-yet-started) season → big countdown;
 *  - the current season with no games yet → "be the first to play";
 *  - the current season with games but everyone inactive → nudge to filters;
 *  - anything else (all-time, closed season with no games) → generic.
 */
function LeaderboardEmptyState({
  seasonView,
  viewedSeason,
  selectedGameId,
  seasonMatchCount,
  now,
}: EmptyStateProps) {
  const recordingLink = selectedGameId !== null ? `/matches/new?game=${selectedGameId}` : '/matches/new';

  // Big countdown for a queued season that hasn't begun
  if (viewedSeason && now) {
    const startsAt = parseDbDate(viewedSeason.start_date).getTime();
    const nowMs = now.getTime();
    if (startsAt > nowMs) {
      const ms = startsAt - nowMs;
      const units = [
        { value: Math.floor(ms / 86400000), label: 'days' },
        { value: Math.floor((ms % 86400000) / 3600000), label: 'hours' },
        { value: Math.floor((ms % 3600000) / 60000), label: 'minutes' },
        { value: Math.floor((ms % 60000) / 1000), label: 'seconds' },
      ];

      return (
        <div className="bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl shadow-lg p-10 text-center text-white">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold mb-1">
            {viewedSeason.name} kicks off {formatDbDate(viewedSeason.start_date)}
          </h2>
          <p className="text-white/85 mb-8">Everyone starts from zero — a clean slate for glory.</p>
          <div className="flex justify-center gap-3">
            {units.map((unit) => (
              <div key={unit.label} className="bg-card/15 rounded-xl px-5 py-4 min-w-[80px]">
                <div className="text-4xl font-bold tabular-nums">{unit.value}</div>
                <div className="text-xs uppercase tracking-wide text-white/85 mt-1">{unit.label}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }
  }

  // Current season, live but empty: rally cry (or inactive nudge if games exist)
  if (viewedSeason?.is_current || seasonView === 'current') {
    if (seasonMatchCount > 0) {
      return (
        <div className="bg-card rounded-2xl shadow-lg p-10 text-center">
          <div className="text-6xl mb-4">💤</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Everyone&apos;s gone quiet...</h2>
          <p className="text-gray-500 mb-2">
            {seasonMatchCount.toLocaleString()} {seasonMatchCount === 1 ? 'match was' : 'matches were'} played in{' '}
            {viewedSeason?.name ?? 'this season'}, but no one has played within the last 60 days.
          </p>
          <p className="text-gray-400 text-sm mb-6">
            Tick “Show inactive players” above to bring them back — or better, get everyone playing again!
          </p>
          <Link
            href={recordingLink}
            className="inline-block bg-primary text-white px-6 py-3 rounded-xl font-semibold hover:bg-primary-hover transition-colors shadow-lg hover:shadow-xl"
          >
            ⚡ Record a Match
          </Link>
        </div>
      );
    }

    return (
      <div className="bg-card rounded-2xl shadow-lg p-10 text-center">
        <div className="text-6xl mb-4">🏁</div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {viewedSeason ? `${viewedSeason.name} is live!` : 'A new season is live!'}
        </h2>
        <p className="text-gray-500 mb-6">
          Zero games played — everyone&apos;s at zero skill. Be the first to add one!
        </p>
        <Link
          href={recordingLink}
          className="inline-block bg-primary text-white px-6 py-3 rounded-xl font-semibold hover:bg-primary-hover transition-colors shadow-lg hover:shadow-xl"
        >
          ⚡ Record the First Match
        </Link>
      </div>
    );
  }

  // All-time / closed season / nothing loaded yet
  const seasonName = seasonView === 'alltime' ? null : viewedSeason?.name ?? null;
  return (
    <div className="bg-card rounded-2xl shadow-lg p-10 text-center">
      <div className="text-6xl mb-4">🏏</div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Nothing on the board yet</h2>
      {seasonName ? (
        <p className="text-gray-500 mb-6">No games were played in {seasonName}.</p>
      ) : (
        <p className="text-gray-500 mb-6">
          No players on the leaderboard yet.{' '}
          <Link href="/players" className="text-primary hover:underline">
            Add players
          </Link>{' '}
          and record some matches!
        </p>
      )}
      <Link
        href={recordingLink}
        className="inline-block bg-primary text-white px-6 py-3 rounded-xl font-semibold hover:bg-primary-hover transition-colors shadow-lg hover:shadow-xl"
      >
        ⚡ Record a Match
      </Link>
    </div>
  );
}

export default function LeaderboardClient({
  initialLeaderboard,
  initialStats,
  initialRecords,
  currentSeasonId,
  seasonalTheme,
}: LeaderboardClientProps) {
  const { selectedGameId, selectedGame, games } = useSelectedGame();
  const { enabled: seasonalEnabled, setEnabled: setSeasonalEnabled } = useSeasonalEffects();
  // null = preference not loaded yet; treat as enabled so the hydration
  // render matches what the server produced
  const seasonalOn = seasonalEnabled !== false;
  // All render-time seasonal styling flows through this: it becomes the
  // plain/slate theme when the user has seasonal effects switched off
  const effectiveTheme = seasonalOn ? seasonalTheme : NO_SEASONAL_THEME;
  const [leaderboard, setLeaderboard] = useState(initialLeaderboard);
  const [gameStats, setGameStats] = useState(initialStats);
  const [gameRecords, setGameRecords] = useState(initialRecords);
  const [loading, setLoading] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  // 'current' = current season (default); number = a past season; 'alltime'
  const [seasonView, setSeasonView] = useState<'current' | 'alltime' | number>('current');
  // Ticking clock for the next-season countdown (client-only to avoid hydration issues)
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const loadSeasons = () =>
      fetch('/api/seasons')
        .then(res => res.json())
        .then(data => {
          setSeasons(data.seasons || []);
        })
        .catch(err => console.error('Failed to load seasons:', err));
    loadSeasons();

    // Tick every second for the countdown; refresh the season list (which
    // may have gained a queued next season) roughly every minute
    let lastSeasonsLoad = Date.now();
    const interval = setInterval(() => {
      setNow(new Date());
      if (Date.now() - lastSeasonsLoad > 60000) {
        lastSeasonsLoad = Date.now();
        loadSeasons();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch data when selected game or season scope changes
  useEffect(() => {
    if (selectedGameId === null) return;

    const scopeParams = seasonView === 'alltime'
      ? '&scope=alltime'
      : seasonView !== 'current'
        ? `&season_id=${seasonView}`
        : '';

    async function fetchData() {
      setLoading(true);
      try {
        const [leaderboardData, statsData, recordsData] = await Promise.all([
          fetch(`/api/leaderboard?game_id=${selectedGameId}&include_retired=${showRetired}&include_inactive=${showInactive}${scopeParams}`).then(res => res.json()),
          fetch(`/api/game-stats?game_id=${selectedGameId}${scopeParams}`).then(res => res.json()),
          fetch(`/api/game-records?game_id=${selectedGameId}${scopeParams}`).then(res => res.json())
        ]);
        setLeaderboard(leaderboardData);
        if (statsData && !statsData.error) setGameStats(statsData);
        setGameRecords(recordsData);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [selectedGameId, showRetired, showInactive, seasonView]);

  // Resolve the season being viewed + metadata for the banner
  const viewedSeasonId = seasonView === 'alltime'
    ? null
    : seasonView === 'current'
      ? currentSeasonId
      : seasonView;
  const viewedSeason = viewedSeasonId !== null
    ? seasons.find(s => s.id === viewedSeasonId) ?? null
    : null;
  // Queued (not-yet-started) season for the countdown
  const nextSeason = seasons.find(s => parseDbDate(s.start_date) > (now ?? new Date(0))) ?? null;
  // Don't double up the countdown banner when the big empty-state card covers it
  const countdownInView = !(viewedSeason && nextSeason && viewedSeason.id === nextSeason.id);

  return (
    <div>
      <SeasonalDecor theme={effectiveTheme} />

      {(viewedSeason || nextSeason) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {viewedSeason && (
            <div className="flex items-center gap-2 bg-card border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-600">
              <span>🗓️</span>
              <span className="font-semibold text-gray-800">{viewedSeason.name}</span>
              <span>
                {formatDbDate(viewedSeason.start_date)}
                {' — '}
                {viewedSeason.end_date
                  ? formatDbDate(viewedSeason.end_date)
                  : 'ongoing'}
              </span>
            </div>
          )}
          {nextSeason && now && countdownInView && (
            <div className="flex items-center gap-2 bg-gradient-to-r from-amber-400 to-orange-400 text-white rounded-lg px-3 py-1.5 text-sm font-semibold shadow">
              <span>⏳</span>
              <span>
                {nextSeason.name} starts in {formatCountdown(parseDbDate(nextSeason.start_date), now)}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <h1 className="text-3xl font-bold">
            {effectiveTheme.titleEmoji ? `${effectiveTheme.titleEmoji} ` : ''}
            Leaderboard
          </h1>
          {effectiveTheme.id !== 'none' && (
            <span
              className={`bg-gradient-to-r ${effectiveTheme.badgeGradient} text-white text-xs font-semibold px-2.5 py-1 rounded-full shadow hidden sm:inline-block`}
              title={`Seasonal flair — ${effectiveTheme.label}`}
            >
              {effectiveTheme.label}
            </span>
          )}
          {seasonalTheme.id !== 'none' && (
            <SeasonalInlineToggle
              theme={seasonalTheme}
              enabled={seasonalOn}
              onToggle={() => setSeasonalEnabled(!seasonalOn)}
            />
          )}
          {/* Season picker + all-time toggle */}
          <select
            value={seasonView === 'current' ? `current:${currentSeasonId}` : String(seasonView)}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'alltime') {
                setSeasonView('alltime');
              } else if (val === String(currentSeasonId) || val.startsWith('current:')) {
                setSeasonView('current');
              } else {
                setSeasonView(parseInt(val, 10));
              }
            }}
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-300 transition-colors"
          >
            <option value={`current:${currentSeasonId}`}>
              {seasons.find(s => s.id === currentSeasonId)?.name ?? 'Current Season'}
            </option>
            {seasons.filter(s => s.id !== currentSeasonId).map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="alltime">🏆 All Time</option>
          </select>
        </div>
        <div className="flex gap-3">
          <Link
            href="/matches"
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Match History
          </Link>
          <Link
            href={selectedGameId ? `/matches/new?game=${selectedGameId}` : "/matches/new"}
            className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-hover transition-colors"
          >
            Record Match
          </Link>
          <Link
            href="/settings"
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Settings
          </Link>
        </div>
      </div>

      {gameStats && (
        <div className="mb-8 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-5 text-white shadow-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">🎮</span>
              <span className="text-sm font-medium text-slate-200 uppercase tracking-wide">Matches</span>
            </div>
            <div className="text-3xl font-bold">{gameStats.total_matches.toLocaleString()}</div>
          </div>
          <div className="bg-gradient-to-br from-emerald-600 to-emerald-700 rounded-xl p-5 text-white shadow-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">👥</span>
              <span className="text-sm font-medium text-white/80 uppercase tracking-wide">Players</span>
            </div>
            <div className="text-3xl font-bold">{gameStats.active_players}</div>
            {gameStats.total_players > gameStats.active_players && (
              <div className="text-xs text-white/80 mt-1">{gameStats.total_players} total</div>
            )}
          </div>
          <div className="bg-gradient-to-br from-red-500 to-red-600 rounded-xl p-5 text-white shadow-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">🔴</span>
              <span className="text-sm font-medium text-white/80 uppercase tracking-wide">Team 1</span>
            </div>
            <div className="text-3xl font-bold">{gameStats.team0_points.toLocaleString()}</div>
          </div>
          <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl p-5 text-white shadow-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">🔵</span>
              <span className="text-sm font-medium text-white/80 uppercase tracking-wide">Team 2</span>
            </div>
            <div className="text-3xl font-bold">{gameStats.team1_points.toLocaleString()}</div>
          </div>
        </div>
      )}

      {gameRecords && (
        <div className="mb-8 bg-card rounded-xl shadow-lg overflow-hidden">
          <div className={`px-6 py-4 bg-gradient-to-r ${effectiveTheme.headerGradient} border-b border-black/20`}>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span>🏆</span> Game Records
            </h2>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              {gameRecords.peak_skill_ever && (
                <Link
                  href={`/players/${gameRecords.peak_skill_ever.player_id}`}
                  className="group bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-xl p-4 hover:shadow-lg hover:border-emerald-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">📈</span>
                    <span className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Peak Skill</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">
                    {gameRecords.peak_skill_ever.player_name}
                  </div>
                  <div className="text-2xl font-bold text-emerald-600 mt-1">
                    {(gameRecords.peak_skill_ever.value as number).toFixed(0)}
                  </div>
                </Link>
              )}
              {gameRecords.trough_skill_ever && (
                <Link
                  href={`/players/${gameRecords.trough_skill_ever.player_id}`}
                  className="group bg-gradient-to-br from-red-50 to-orange-50 border border-red-200 rounded-xl p-4 hover:shadow-lg hover:border-red-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">📉</span>
                    <span className="text-xs font-semibold text-red-700 uppercase tracking-wide">Lowest Skill</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-red-700 transition-colors">
                    {gameRecords.trough_skill_ever.player_name}
                  </div>
                  <div className="text-2xl font-bold text-red-600 mt-1">
                    {(gameRecords.trough_skill_ever.value as number).toFixed(0)}
                  </div>
                </Link>
              )}
              {gameRecords.most_games && (
                <Link
                  href={`/players/${gameRecords.most_games.player_id}`}
                  className="group bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4 hover:shadow-lg hover:border-blue-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">🎮</span>
                    <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Most Games</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-blue-700 transition-colors">
                    {gameRecords.most_games.player_name}
                  </div>
                  <div className="text-2xl font-bold text-blue-600 mt-1">
                    {gameRecords.most_games.value}
                  </div>
                </Link>
              )}
              {gameRecords.highest_win_rate && (
                <Link
                  href={`/players/${gameRecords.highest_win_rate.player_id}`}
                  className="group bg-gradient-to-br from-amber-50 to-yellow-50 border border-amber-200 rounded-xl p-4 hover:shadow-lg hover:border-amber-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">👑</span>
                    <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Best Win %</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-amber-700 transition-colors">
                    {gameRecords.highest_win_rate.player_name}
                  </div>
                  <div className="text-2xl font-bold text-amber-600 mt-1">
                    {(gameRecords.highest_win_rate.value as number).toFixed(0)}%
                  </div>
                </Link>
              )}
              {gameRecords.longest_win_streak && (
                <Link
                  href={`/players/${gameRecords.longest_win_streak.player_id}`}
                  className="group bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-xl p-4 hover:shadow-lg hover:border-green-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">🔥</span>
                    <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">Win Streak</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-green-700 transition-colors">
                    {gameRecords.longest_win_streak.player_name}
                  </div>
                  <div className="text-2xl font-bold text-green-600 mt-1">
                    {gameRecords.longest_win_streak.value}
                  </div>
                </Link>
              )}
              {gameRecords.longest_lose_streak && (
                <Link
                  href={`/players/${gameRecords.longest_lose_streak.player_id}`}
                  className="group bg-gradient-to-br from-rose-50 to-pink-50 border border-rose-200 rounded-xl p-4 hover:shadow-lg hover:border-rose-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">💔</span>
                    <span className="text-xs font-semibold text-rose-700 uppercase tracking-wide">Lose Streak</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-rose-700 transition-colors">
                    {gameRecords.longest_lose_streak.player_name}
                  </div>
                  <div className="text-2xl font-bold text-rose-600 mt-1">
                    {gameRecords.longest_lose_streak.value}
                  </div>
                </Link>
              )}
              {gameRecords.longest_unbeaten_streak && (
                <Link
                  href={`/players/${gameRecords.longest_unbeaten_streak.player_id}`}
                  className="group bg-gradient-to-br from-cyan-50 to-teal-50 border border-cyan-200 rounded-xl p-4 hover:shadow-lg hover:border-cyan-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">🛡️</span>
                    <span className="text-xs font-semibold text-cyan-700 uppercase tracking-wide">Unbeaten</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-cyan-700 transition-colors">
                    {gameRecords.longest_unbeaten_streak.player_name}
                  </div>
                  <div className="text-2xl font-bold text-cyan-600 mt-1">
                    {gameRecords.longest_unbeaten_streak.value}
                  </div>
                </Link>
              )}
              {gameRecords.biggest_skill_gain && (
                <Link
                  href={`/players/${gameRecords.biggest_skill_gain.player_id}`}
                  className="group bg-gradient-to-br from-lime-50 to-green-50 border border-lime-200 rounded-xl p-4 hover:shadow-lg hover:border-lime-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">🚀</span>
                    <span className="text-xs font-semibold text-lime-700 uppercase tracking-wide">Biggest Gain</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-lime-700 transition-colors">
                    {gameRecords.biggest_skill_gain.player_name}
                  </div>
                  <div className="text-2xl font-bold text-lime-600 mt-1">
                    +{(gameRecords.biggest_skill_gain.value as number).toFixed(0)}
                  </div>
                </Link>
              )}
              {gameRecords.biggest_skill_loss && (
                <Link
                  href={`/players/${gameRecords.biggest_skill_loss.player_id}`}
                  className="group bg-gradient-to-br from-orange-50 to-red-50 border border-orange-200 rounded-xl p-4 hover:shadow-lg hover:border-orange-300 transition-all duration-200"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">💫</span>
                    <span className="text-xs font-semibold text-orange-700 uppercase tracking-wide">Biggest Loss</span>
                  </div>
                  <div className="font-bold text-gray-900 group-hover:text-orange-700 transition-colors">
                    {gameRecords.biggest_skill_loss.player_name}
                  </div>
                  <div className="text-2xl font-bold text-orange-600 mt-1">
                    -{(gameRecords.biggest_skill_loss.value as number).toFixed(0)}
                  </div>
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
            className="rounded border-border text-primary focus:ring-primary"
          />
          Show retired players
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-border text-primary focus:ring-primary"
          />
          Show inactive players
        </label>
      </div>

      {loading ? (
        <div className="text-gray-500">Loading...</div>
      ) : leaderboard.length === 0 ? (
        <LeaderboardEmptyState
          seasonView={seasonView}
          viewedSeason={viewedSeason}
          selectedGameId={selectedGameId}
          seasonMatchCount={seasonView === 'current' || viewedSeason?.is_current ? gameStats?.total_matches ?? 0 : 0}
          now={now}
        />
      ) : (
        <div className="bg-card rounded-xl shadow-lg overflow-hidden">
          <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr className={`bg-gradient-to-r ${effectiveTheme.headerGradient} border-b border-black/20`}>
                {["Rank", "Player", "Rating", "Trend", "W/L/D", "Win Rate"].map((heading) => (
                  <th
                    key={heading}
                    className={`px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider ${
                      effectiveTheme.id === 'none' ? 'text-gray-500' : 'text-white/80'
                    }`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leaderboard.map((entry, index) => {
                const totalGames = entry.wins + entry.losses + entry.draws;
                const winRate = totalGames > 0 ? ((entry.wins / totalGames) * 100).toFixed(0) : "0";
                const isRetired = entry.status === 'retired';
                const isInactive = entry.is_inactive ?? false;
                const rank = index + 1;

                // Calculate days since last match
                const daysSinceLastMatch = entry.last_match_at
                  ? Math.floor((Date.now() - new Date(entry.last_match_at).getTime()) / (1000 * 60 * 60 * 24))
                  : null;

                // Rank badge component
                const rankBadge = () => {
                  if (rank === 1) return <span className="text-2xl">🥇</span>;
                  if (rank === 2) return <span className="text-2xl">🥈</span>;
                  if (rank === 3) return <span className="text-2xl">🥉</span>;
                  return <span className="text-sm font-bold text-gray-400">#{rank}</span>;
                };

                // Row background for top 3
                const rowBg = rank === 1 ? 'bg-gradient-to-r from-amber-50 to-yellow-50' :
                              rank === 2 ? 'bg-gradient-to-r from-slate-50 to-gray-50' :
                              rank === 3 ? 'bg-gradient-to-r from-orange-50 to-amber-50' :
                              isRetired ? 'bg-gray-50' :
                              isInactive ? 'bg-gray-50' : 'bg-card';

                return (
                  <tr
                    key={entry.player_id}
                    className={`${rowBg} hover:brightness-95 transition-all duration-150`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      {rankBadge()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Link
                        href={`/players/${entry.player_id}`}
                        className={`group flex items-center gap-3 ${isRetired || isInactive ? 'opacity-60' : ''}`}
                      >
                        <PlayerAvatar
                          name={entry.player_name}
                          avatarUrl={entry.avatar_url}
                          size={40}
                          ringClass="shadow-md"
                          fallbackClassName={
                            rank === 1 ? 'bg-gradient-to-br from-amber-400 to-yellow-500 text-white' :
                            rank === 2 ? 'bg-gradient-to-br from-slate-300 to-slate-400 text-white' :
                            rank === 3 ? 'bg-gradient-to-br from-orange-400 to-amber-500 text-white' :
                            'bg-gray-200 text-gray-600'
                          }
                        />
                        <div>
                          <span className={`font-semibold text-gray-900 group-hover:text-primary transition-colors ${isRetired ? 'line-through' : ''}`}>
                            {entry.player_name}
                          </span>
                          {isRetired && (
                            <span className="ml-2 text-xs bg-gray-200 text-gray-500 px-2 py-0.5 rounded-full">
                              Retired
                            </span>
                          )}
                          {isInactive && !isRetired && (
                            <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                              Inactive{daysSinceLastMatch !== null ? ` (${daysSinceLastMatch}d)` : ''}
                            </span>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-bold text-gray-900">
                          {entry.elo < 0 ? '-' : ''}{Math.abs(Math.trunc(entry.elo))}
                        </span>
                        <span className="text-xs text-gray-400 font-mono">
                          .{Math.abs(entry.elo - Math.trunc(entry.elo)).toFixed(3).slice(2)}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <TrendSparkline deltas={entry.trend} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="text-green-600 font-semibold">{entry.wins}</span>
                        <span className="text-gray-300">/</span>
                        <span className="text-red-500 font-semibold">{entry.losses}</span>
                        <span className="text-gray-300">/</span>
                        <span className="text-gray-500">{entry.draws}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full"
                            style={{ width: `${winRate}%` }}
                          />
                        </div>
                        <span className="text-sm font-semibold text-gray-700">{winRate}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}