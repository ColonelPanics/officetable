"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSelectedGame } from "@/lib/hooks/useSelectedGame";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { TrendSparkline } from "@/components/TrendSparkline";
import type { LadderSnapshot, LadderSnapshotEntry, LadderTimelinePoint } from "@/lib/ladderHistory";

/** Parse a DB datetime string (UTC). */
function parseDbDate(dateStr: string): Date {
  return new Date(`${dateStr.replace(' ', 'T')}Z`);
}

function formatDbDate(dateStr: string): string {
  return parseDbDate(dateStr).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDbTime(dateStr: string): string {
  return parseDbDate(dateStr).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatGameName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface SnapshotResponse extends LadderSnapshot {
  timeline?: LadderTimelinePoint[];
}

export default function LadderHistoryPage() {
  const { selectedGameId, selectedGame } = useSelectedGame();
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [timeline, setTimeline] = useState<LadderTimelinePoint[]>([]);
  const [loading, setLoading] = useState(false);
  // Timeline cursor: 0..timeline.length-1 = the state right after that match;
  // timeline.length = "right now".
  const [cursor, setCursor] = useState<number | null>(null);

  const load = useCallback(async (gameId: number, atOrUndefined?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ game_id: String(gameId), include_timeline: 'true' });
      if (atOrUndefined) params.set('at', atOrUndefined);
      const res = await fetch(`/api/ladder-history?${params}`);
      const data: SnapshotResponse = await res.json();
      if (data && !('error' in (data as object))) {
        setSnapshot(data);
        if (data.timeline) setTimeline(data.timeline);
      }
    } catch (err) {
      console.error('Failed to load ladder snapshot:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // New game → start at "right now"
  useEffect(() => {
    if (selectedGameId === null) return;
    setTimeline([]);
    setCursor(null); // "now" position
    // timeline is unknown for the new game yet — fetch with no `at` (defaults
    // to now) and pick up the fresh timeline from the reply.
    load(selectedGameId);
  }, [selectedGameId, load]);

  const isNow = cursor === null || cursor >= timeline.length;
  const selectedPoint = cursor !== null && !isNow ? timeline[cursor] : null;

  // Move the cursor and refetch. `at` = the selected match's OWN timestamp =
  // the state right AFTER that match (snapshot is taken after matches with
  // played_at <= at).
  const goTo = (newCursor: number) => {
    const clamped = Math.max(0, Math.min(newCursor, timeline.length));
    setCursor(clamped);
    if (clamped >= timeline.length) {
      load(selectedGameId!); // now
    } else {
      load(selectedGameId!, timeline[clamped].played_at);
    }
  };

  const step = (delta: number) => {
    if (timeline.length === 0) return;
    goTo(isNow ? timeline.length - 1 : (cursor ?? timeline.length) + delta);
  };

  const entries: LadderSnapshotEntry[] = snapshot?.entries ?? [];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-3xl font-bold">🕰️ Ladder Time Machine</h1>
          <p className="text-gray-500 mt-1">
            Step through {(selectedGame ? formatGameName(selectedGame.name) : 'the')}&apos;s ladder history —
            every point shows the board exactly as it stood then (inactive and retired players excluded, just like the live ladder).
          </p>
        </div>
        <Link href="/" className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 transition-colors">
          ← Live ladder
        </Link>
      </div>

      {!selectedGameId || timeline.length === 0 ? (
        <div className="mt-8 bg-card rounded-2xl shadow-lg p-10 text-center">
          <div className="text-6xl mb-4">🕰️</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No history yet</h2>
          <p className="text-gray-500">
            {selectedGameId
              ? 'This ladder has no matches to travel through yet.'
              : 'Pick a game from the menu above to travel its ladder.'}
          </p>
        </div>
      ) : (
        <>
          {/* Timeline control */}
          <div className="bg-card rounded-xl shadow-lg p-6 mb-6">
            <div className="flex items-center gap-3">
              <button
                onClick={() => step(-1)}
                disabled={loading || (!isNow && (cursor ?? 0) === 0)}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Back one match"
              >
                ← Prev
              </button>

              <div className="flex-1 relative">
                <input
                  type="range"
                  min={0}
                  max={timeline.length}
                  value={isNow ? timeline.length : (cursor ?? 0)}
                  onChange={(e) => goTo(parseInt(e.target.value, 10))}
                  className="w-full accent-primary"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>{formatDbDate(timeline[0].played_at)}</span>
                  <span>{timeline.length.toLocaleString()} matches</span>
                  <span>now</span>
                </div>
              </div>

              <button
                onClick={() => goNextOrNow()}
                disabled={loading || isNow}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                title={nextStepIsNow() ? 'Jump to now' : 'Forward one match'}
              >
                {nextStepIsNow() ? 'Now →' : 'Next →'}
              </button>
              <button
                onClick={() => goTo(timeline.length)}
                disabled={loading || isNow}
                className="px-3 py-2 bg-primary text-white rounded-lg text-sm font-semibold hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ⏭ Now
              </button>
            </div>

            <div className="mt-3 text-sm">
              {loading ? (
                <span className="text-gray-400">Rewinding…</span>
              ) : isNow ? (
                <span className="text-gray-600">
                  <span className="font-semibold text-gray-800">Right now</span>
                  {' — '}the ladder as it stands today.
                </span>
              ) : selectedPoint ? (
                <span className="text-gray-600">
                  <span className="font-semibold text-gray-800">{formatDbDate(selectedPoint.played_at)} {formatDbTime(selectedPoint.played_at)}</span>
                  {' — '}straight after match{' '}
                  <Link href={`/matches/${selectedPoint.id}`} className="text-primary hover:underline">#{selectedPoint.id}</Link>
                  {' · '}
                  {snapshot?.season ? snapshot.season.name : 'pre-season ladder'}
                  {' · '}
                  {snapshot?.total_matches.toLocaleString()} matches played so far
                </span>
              ) : null}
            </div>
          </div>

          {/* Snapshot board */}
          <div className="bg-card rounded-xl shadow-lg overflow-hidden">
            <table className="min-w-full">
              <thead>
                <tr className="bg-gradient-to-r from-slate-800 to-slate-900 border-b border-black/20">
                  {["Rank", "Player", "Rating", "Trend", "W/L/D", "Last Played"].map((heading) => (
                    <th key={heading} className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-gray-500">
                      Nothing on the board at this moment — nobody was on the ladder yet.
                    </td>
                  </tr>
                ) : entries.map((entry) => {
                  const rank = entry.rank;
                  const rankBadge = () => {
                    if (rank === 1) return <span className="text-2xl">🥇</span>;
                    if (rank === 2) return <span className="text-2xl">🥈</span>;
                    if (rank === 3) return <span className="text-2xl">🥉</span>;
                    return <span className="text-sm font-bold text-gray-400">#{rank}</span>;
                  };
                  const rowBg = rank === 1 ? 'bg-gradient-to-r from-amber-50 to-yellow-50' :
                                rank === 2 ? 'bg-gradient-to-r from-slate-50 to-gray-50' :
                                rank === 3 ? 'bg-gradient-to-r from-orange-50 to-amber-50' : 'bg-card';
                  return (
                    <tr key={entry.player_id} className={`${rowBg} hover:brightness-95 transition-all duration-150`}>
                      <td className="px-6 py-4 whitespace-nowrap">{rankBadge()}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Link href={`/players/${entry.player_id}`} className="group flex items-center gap-3">
                          <PlayerAvatar name={entry.player_name} avatarUrl={entry.avatar_url} size={40} ringClass="shadow-md" />
                          <span className="font-semibold text-gray-900 group-hover:text-primary transition-colors">
                            {entry.player_name}
                          </span>
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
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {entry.last_match_at ? `${formatDbDate(entry.last_match_at)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );

  function nextStepIsNow(): boolean {
    return (cursor ?? timeline.length) >= timeline.length - 1;
  }
  function goNextOrNow() {
    goTo(nextStepIsNow() ? timeline.length : (cursor ?? timeline.length) + 1);
  }
}