"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { parsePointTimeline, computeTimelineStats, formatDuration, formatClock, type PointTimeline, type TimelineStats } from "@/lib/timeline";

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
  metadata?: Record<string, unknown>;
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
  game_image_url?: string | null;
  participants: {
    id: number;
    match_id: number;
    player_id: number;
    team: number;
    score: number;
    elo_before: number;
    elo_after: number;
    alltime_elo_before: number;
    alltime_elo_after: number;
    player_name: string;
    avatar_url?: string | null;
  }[];
  achievements?: MatchAchievement[];
  punditry?: PunditryFact[];
}

// Get icon for punditry type
function getPunditryIcon(type: string): string {
  const icons: Record<string, string> = {
    'streak': '🔥',
    'upset': '⚡',
    'domination': '👑',
    'milestone': '🎯',
    'rivalry': '⚔️',
    'comeback': '💫',
    'first': '🥇',
    'record': '📊',
    'trend': '📈',
    'defensive': '🛡️',
    'offensive': '🚀',
    'consistency': '💎',
  };
  return icons[type] || '💬';
}

// Get color scheme for punditry type
function getPunditryStyle(type: string): { bg: string; border: string; iconBg: string } {
  const styles: Record<string, { bg: string; border: string; iconBg: string }> = {
    'streak': { bg: 'from-orange-50 to-amber-50', border: 'border-orange-200', iconBg: 'bg-orange-100' },
    'upset': { bg: 'from-purple-50 to-violet-50', border: 'border-purple-200', iconBg: 'bg-purple-100' },
    'domination': { bg: 'from-yellow-50 to-amber-50', border: 'border-yellow-200', iconBg: 'bg-yellow-100' },
    'milestone': { bg: 'from-blue-50 to-cyan-50', border: 'border-blue-200', iconBg: 'bg-blue-100' },
    'rivalry': { bg: 'from-red-50 to-rose-50', border: 'border-red-200', iconBg: 'bg-red-100' },
    'comeback': { bg: 'from-green-50 to-emerald-50', border: 'border-green-200', iconBg: 'bg-green-100' },
    'first': { bg: 'from-amber-50 to-yellow-50', border: 'border-amber-200', iconBg: 'bg-amber-100' },
    'record': { bg: 'from-indigo-50 to-blue-50', border: 'border-indigo-200', iconBg: 'bg-indigo-100' },
    'trend': { bg: 'from-teal-50 to-cyan-50', border: 'border-teal-200', iconBg: 'bg-teal-100' },
    'defensive': { bg: 'from-slate-50 to-gray-50', border: 'border-slate-200', iconBg: 'bg-slate-100' },
    'offensive': { bg: 'from-pink-50 to-rose-50', border: 'border-pink-200', iconBg: 'bg-pink-100' },
    'consistency': { bg: 'from-emerald-50 to-teal-50', border: 'border-emerald-200', iconBg: 'bg-emerald-100' },
  };
  return styles[type] || { bg: 'from-gray-50 to-slate-50', border: 'border-gray-200', iconBg: 'bg-gray-100' };
}

// A match summary for live-tracked games: cumulative score over time
//(both teams), plus scoring stats and the ordered point list.
function TimelineCard({
  timeline,
  stats,
  teamNames,
}: {
  timeline: PointTimeline;
  stats: TimelineStats;
  teamNames: string[];
}) {
  const events = timeline.events;
  const teamCount = Math.max(teamNames.length, (stats.scores.size ?? 0));
  const W = 360;
  const H = 170;
  const padX = 34;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 26;
  const lastAt = events[events.length - 1]?.at ?? 1;
  const totalX = Math.max(stats.durationMs ?? 0, lastAt) || 1;
  const maxScore = Math.max(1, ...stats.teams.map((t) => t.score));
  const colors = ['#2563eb', '#dc2626', '#059669', '#7c3aed'];

  const x = (at: number) => padX + (at / totalX) * (W - padX - padRight);
  const y = (score: number) => H - padBottom - (score / maxScore) * (H - padTop - padBottom);

  // Piecewise-constant step series per team: (0,0) -> each point -> (end, final)
  const series = Array.from({ length: teamCount }, (_, t) => {
    let cum = 0;
    const pts: [number, number][] = [[x(0), y(0)]];
    for (const ev of events) {
      if (ev.team !== t) continue;
      cum++;
      pts.push([x(ev.at), y(cum)]);
    }
    if (cum === 0) return null;
    pts.push([x(totalX), y(cum)]);
    return { t, cum, pts };
  }).filter((s): s is { t: number; cum: number; pts: [number, number][] } => s !== null);

  const teamNameOf = (t: number) =>
    teamNames[t] ?? `Team ${t + 1}`;

  return (
    <div className="bg-card rounded-2xl shadow-lg overflow-hidden mb-6">
      <div className="px-6 py-4 bg-gradient-to-r from-slate-800 to-slate-900 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⏱️</span>
          <div>
            <div className="text-lg font-bold text-white">Match Timeline</div>
            <div className="text-sm text-slate-400">Live-tracked points as they were scored</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-slate-300 font-mono">
            {stats.durationMs ? formatDuration(stats.durationMs) : '—'}
          </div>
          <div className="text-xs text-slate-500">{stats.pointCount} points</div>
        </div>
      </div>

      <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap gap-2">
        {stats.firstScorer !== null && (
          <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
            First point: {teamNameOf(stats.firstScorer)}
          </span>
        )}
        {stats.leadChanges > 0 && (
          <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
            🔀 {stats.leadChanges} lead change{stats.leadChanges === 1 ? '' : 's'}
          </span>
        )}
        {stats.teams.filter((t) => t.maxDeficit >= 2).map((t) => (
          <span key={t.team} className="text-xs px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
            {teamNameOf(t.team)} were {t.maxDeficit} down at worst
          </span>
        ))}
        {stats.wireToWireWinners.length > 0 && (
          <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
            🛡️ Wire-to-wire: {stats.wireToWireWinners.map(teamNameOf).join(' & ')}
          </span>
        )}
      </div>

      {/* Cumulative score chart */}
      <div className="px-6 pt-5 pb-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative score over time">
          {/* score gridlines */}
          {Array.from({ length: maxScore }, (_, i) => i + 1).map((s) => (
            <g key={s}>
              <line x1={padX} y1={y(s)} x2={W - padRight} y2={y(s)} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3 4" />
              <text x={padX - 6} y={y(s) + 3.5} textAnchor="end" fontSize={10} fill="#9ca3af" fontFamily="monospace">
                {s}
              </text>
            </g>
          ))}
          {/* time axis */}
          <line x1={padX} y1={y(0)} x2={W - padRight} y2={y(0)} stroke="#d1d5db" strokeWidth={1} />
          <text x={padX} y={y(0) + 14} textAnchor="middle" fontSize={10} fill="#9ca3af" fontFamily="monospace">00:00</text>
          <text x={W - padRight} y={y(0) + 14} textAnchor="end" fontSize={10} fill="#9ca3af" fontFamily="monospace">
            {stats.durationMs ? formatClock(stats.durationMs) : formatClock(lastAt)}
          </text>
          {/* team series */}
          {series.map((s) => (
            <g key={s.t}>
              <polyline
                points={s.pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}
                fill="none"
                stroke={colors[s.t % colors.length]}
                strokeWidth={2.5}
                strokeLinejoin="round"
              />
              {s.pts.slice(1, -1).map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={2.5} fill={colors[s.t % colors.length]} opacity={0.55} />
              ))}
              <text x={W - padRight + 2} y={y(s.cum) + 3.5} fontSize={10} fill={colors[s.t % colors.length]} fontFamily="monospace">
                {s.cum}
              </text>
            </g>
          ))}
        </svg>
        <div className="flex justify-center gap-4 pb-2">
          {series.map((s) => (
            <span key={s.t} className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: colors[s.t % colors.length] }} />
                {teamNameOf(s.t)}
              </span>
          ))}
        </div>
      </div>

      {/* Point order */}
      <div className="border-t border-gray-100">
        <div className="px-6 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Scoring order
        </div>
        <div className="px-6 pb-5 max-h-64 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-2">
          {events.map((ev, i) => {
            const running = [0, 0];
            for (let j = 0; j <= i; j++) running[events[j].team]++;
            return (
              <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-2.5 py-1.5">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0 inline-block"
                    style={{ backgroundColor: colors[ev.team % colors.length] }}
                  />
                  <span className="text-[10px] text-gray-400 font-mono">{formatClock(ev.at)}</span>
                  <span className="text-xs font-medium truncate" style={{ color: colors[ev.team % colors.length] }}>
                    #{i + 1}
                  </span>
                </span>
                <span className="text-xs font-mono text-gray-500 tabular-nums shrink-0">
                  {running[0]}-{running[1]}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function MatchDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const matchId = params.id as string;
  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Season ledger deltas by default, with all-time ledger values available
  const [deltaView, setDeltaView] = useState<'season' | 'alltime'>('season');

  useEffect(() => {
    fetch(`/api/matches/${matchId}`)
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error("Match not found");
          }
          throw new Error("Failed to load match");
        }
        return res.json();
      })
      .then((data) => {
        setMatch(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [matchId]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatRatingChange = (before: number, after: number) => {
    const diff = after - before;
    const sign = diff >= 0 ? "+" : "";
    return `${sign}${diff.toFixed(3)}`;
  };

  const getTeamResult = (team: number) => {
    if (!match) return { result: "unknown" as const, score: 0 };

    const teamParticipants = match.participants.filter((p) => p.team === team);
    const otherTeamParticipants = match.participants.filter((p) => p.team !== team);

    if (otherTeamParticipants.length === 0) return { result: "unknown" as const, score: 0 };

    const teamScore = teamParticipants[0]?.score ?? 0;
    const otherScore = otherTeamParticipants[0]?.score;
    const isDraw = teamScore === otherScore;

    const maxScore = Math.max(teamScore, otherScore);

    if (isDraw) {
      return { result: "draw" as const, score: teamScore };
    } else if (teamScore === maxScore) {
      return { result: "win" as const, score: teamScore };
    } else {
      return { result: "loss" as const, score: teamScore };
    }
  };

  const getTeams = () => {
    if (!match) return [];
    const teamSet = new Set(match.participants.map((p) => p.team));
    return Array.from(teamSet).sort((a, b) => a - b);
  };

  // Live-scorer timeline + derived stats (matches recorded with the live
  // scorer only — see /matches/live). Team labels 0/1/... match the timeline
  // team indexes (the recorder stores team labels 0..n-1).
  const timeline = useMemo(() => parsePointTimeline(match?.points_timeline), [match]);
  const timelineStats = useMemo(() => {
    if (!timeline || !match) return null;
    const teamSet = new Set(match.participants.map((p) => p.team));
    const teamScores = Array.from(teamSet).sort((a, b) => a - b).map((team) =>
      match.participants.filter((p) => p.team === team).reduce((sum, p) => sum + p.score, 0)
    );
    return computeTimelineStats(timeline, teamScores);
  }, [timeline, match]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (error || !match) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
          <div className="text-4xl mb-3">😕</div>
          <div className="text-red-700 font-semibold mb-2">{error || "Match not found"}</div>
          <button
            onClick={() => router.push("/matches")}
            className="text-primary hover:underline font-medium"
          >
            ← Back to Match History
          </button>
        </div>
      </div>
    );
  }

  const teams = getTeams();
  const team1Result = getTeamResult(0);
  const team2Result = getTeamResult(1);

  return (
    <div>
      {/* Back link */}
      <Link
        href="/matches"
        className="inline-flex items-center gap-2 text-gray-500 hover:text-primary transition-colors mb-6"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Match History
      </Link>

      {/* Game Header */}
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl shadow-xl overflow-hidden mb-6">
        <div className="px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {match.game_image_url ? (
                <img
                  src={match.game_image_url}
                  alt={match.game_name}
                  className="w-12 h-12 rounded-xl object-cover shadow-lg"
                />
              ) : (
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-slate-400 to-slate-500 flex items-center justify-center text-2xl shadow-lg">
                  🎮
                </div>
              )}
              <div>
                <h1 className="text-2xl font-bold text-white">
                  {match.game_name.charAt(0).toUpperCase() + match.game_name.slice(1).replace("-", " ")}
                </h1>
                <div className="flex items-center gap-3 mt-1 text-slate-400 flex-wrap">
                  <span>{formatDate(match.played_at)}</span>
                  {timelineStats?.durationMs && (
                    <span className="text-xs px-2 py-0.5 bg-slate-700/60 text-slate-200 rounded-full border border-slate-600 font-mono">
                      ⏱ {formatDuration(timelineStats.durationMs)}
                    </span>
                  )}
                  {match.is_edited === 1 && (
                    <span className="text-xs px-2 py-0.5 bg-yellow-500/20 text-yellow-300 rounded-full border border-yellow-500/30">
                      Edited
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="text-slate-400 text-sm">
              Match #{match.id}
            </div>
          </div>
        </div>
      </div>

      {/* Score Display */}
      <div className="bg-card rounded-2xl shadow-lg overflow-hidden mb-6">
        <div className="grid grid-cols-2">
          {/* Team 1 */}
          <div className={`p-6 ${
            team1Result.result === 'win' ? 'bg-gradient-to-br from-blue-500 to-blue-600' :
            team1Result.result === 'loss' ? 'bg-gradient-to-br from-red-500 to-red-600' :
            'bg-gradient-to-br from-gray-400 to-gray-500 dark:from-[#3f4756] dark:to-[#333a46]'
          }`}>
            <div className="text-center mb-4">
              <div className={`text-sm font-semibold uppercase tracking-wide mb-1 ${
                team1Result.result === 'win' ? 'text-white/85' :
                team1Result.result === 'loss' ? 'text-white/85' : 'text-white'
              }`}>
                Team 1
              </div>
              <div className="text-6xl font-bold text-white">
                {team1Result.score}
              </div>
              <div className={`mt-2 inline-block px-3 py-1 rounded-full text-sm font-bold ${
                team1Result.result === 'win' ? 'bg-card/20 text-white' :
                team1Result.result === 'loss' ? 'bg-card/20 text-white' :
                'bg-card/20 text-white'
              }`}>
                {team1Result.result === 'win' ? '🏆 Winner' : team1Result.result === 'loss' ? 'Defeat' : '🤝 Draw'}
              </div>
            </div>
          </div>

          {/* VS Divider */}
          <div className="relative">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-transparent via-gray-300 to-transparent -translate-x-0.5" />

            {/* Team 2 */}
            <div className={`p-6 ${
              team2Result.result === 'win' ? 'bg-gradient-to-br from-blue-500 to-blue-600' :
              team2Result.result === 'loss' ? 'bg-gradient-to-br from-red-500 to-red-600' :
              'bg-gradient-to-br from-gray-400 to-gray-500 dark:from-[#3f4756] dark:to-[#333a46]'
            }`}>
              <div className="text-center mb-4">
                <div className={`text-sm font-semibold uppercase tracking-wide mb-1 ${
                  team2Result.result === 'win' ? 'text-white/85' :
                  team2Result.result === 'loss' ? 'text-white/85' : 'text-white'
                }`}>
                  Team 2
                </div>
                <div className="text-6xl font-bold text-white">
                  {team2Result.score}
                </div>
                <div className={`mt-2 inline-block px-3 py-1 rounded-full text-sm font-bold ${
                  team2Result.result === 'win' ? 'bg-card/20 text-white' :
                  team2Result.result === 'loss' ? 'bg-card/20 text-white' :
                  'bg-card/20 text-white'
                }`}>
                  {team2Result.result === 'win' ? '🏆 Winner' : team2Result.result === 'loss' ? 'Defeat' : '🤝 Draw'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Player Details */}
        <div className="border-t border-gray-100 px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Skill changes</span>
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setDeltaView('season')}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  deltaView === 'season' ? 'bg-card shadow text-gray-900 font-semibold' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Season
              </button>
              <button
                onClick={() => setDeltaView('alltime')}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  deltaView === 'alltime' ? 'bg-card shadow text-gray-900 font-semibold' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                All Time
              </button>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-gray-100">
          {teams.map((team) => {
            const teamParticipants = match.participants.filter((p) => p.team === team);
            const result = getTeamResult(team);

            return (
              <div key={team} className="p-6">
                <div className="space-y-3">
                  {teamParticipants.map((p) => {
                    const before = deltaView === 'season' ? p.elo_before : (p.alltime_elo_before ?? p.elo_before);
                    const after = deltaView === 'season' ? p.elo_after : (p.alltime_elo_after ?? p.elo_after);
                    const eloChange = after - before;

                    return (
                      <Link
                        key={p.player_id}
                        href={`/players/${p.player_id}`}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors group"
                      >
                        <div className="flex items-center gap-3">
                          <PlayerAvatar
                            name={p.player_name}
                            avatarUrl={p.avatar_url}
                            size={40}
                            roundedClass="rounded-lg"
                          />
                          <div>
                            <div className="font-semibold text-gray-900 group-hover:text-primary transition-colors">
                              {p.player_name}
                            </div>
                            <div className="text-xs text-gray-500 font-mono">
                              {before.toFixed(3)} → {after.toFixed(3)}
                            </div>
                          </div>
                        </div>
                        <div className={`font-mono text-lg font-bold ${
                          eloChange >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {formatRatingChange(before, after)}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Live Timeline (matches recorded with the live scorer) */}
      {timeline && timelineStats && timelineStats.pointCount > 0 && (
        <TimelineCard
          timeline={timeline}
          stats={timelineStats}
          teamNames={teams.map((team) => {
            const teamParticipants = match.participants.filter((p) => p.team === team);
            const names = teamParticipants.map((p) => p.player_name);
            return names.length === 1 ? names[0] : `${names[0]} & ${names.length - 1} more`;
          })}
        />
      )}

      {/* Notes */}
      {match.notes && (
        <div className="bg-gradient-to-r from-slate-50 to-gray-50 rounded-2xl shadow-lg overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-lg">📝</span>
              <span className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Match Notes</span>
            </div>
          </div>
          <div className="px-6 py-4">
            <p className="text-gray-700 text-lg italic">"{match.notes}"</p>
          </div>
        </div>
      )}

      {/* Achievements */}
      {match.achievements && match.achievements.length > 0 && (
        <div className="bg-gradient-to-r from-amber-50 to-yellow-50 rounded-2xl shadow-lg overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-amber-100">
            <div className="flex items-center gap-2">
              <span className="text-lg">🏆</span>
              <span className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Achievements Earned</span>
            </div>
          </div>
          <div className="px-6 py-4">
            <div className="flex flex-wrap gap-3">
              {match.achievements.map((achievement, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 bg-card border border-amber-200 rounded-xl px-4 py-3 hover:shadow-md transition-all cursor-default"
                  title={achievement.achievement_description}
                >
                  <span className="text-2xl">{achievement.achievement_icon || "🏅"}</span>
                  <div>
                    <div className="font-semibold text-amber-900">{achievement.player_name}</div>
                    <div className="text-sm text-amber-700">{achievement.achievement_name.replace(/_/g, " ")}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Punditry */}
      {match.punditry && match.punditry.length > 0 && (
        <div className="bg-card rounded-2xl shadow-lg overflow-hidden mb-6">
          <div className="px-6 py-4 bg-gradient-to-r from-slate-800 to-slate-900">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎙️</span>
              <div>
                <div className="text-lg font-bold text-white">Punditry</div>
                <div className="text-sm text-slate-400">Match insights and analysis</div>
              </div>
            </div>
          </div>
          <div className="p-6 space-y-4">
            {match.punditry.map((fact, idx) => {
              const icon = getPunditryIcon(fact.type);
              const style = getPunditryStyle(fact.type);

              return (
                <div
                  key={idx}
                  className={`flex items-start gap-4 p-4 rounded-xl bg-gradient-to-r ${style.bg} border ${style.border}`}
                >
                  <div className={`w-12 h-12 rounded-xl ${style.iconBg} flex items-center justify-center text-2xl shrink-0`}>
                    {icon}
                  </div>
                  <div className="flex-1">
                    {fact.player_name && (
                      <Link
                        href={`/players/${fact.player_id}`}
                        className="font-semibold text-primary hover:underline"
                      >
                        {fact.player_name}
                      </Link>
                    )}
                    <p className="text-gray-700 mt-1">
                      {fact.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}