"use client";

import { useState, useEffect, useMemo, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSelectedGame } from "@/lib/hooks/useSelectedGame";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import {
  computeTimelineStats,
  formatClock,
  formatDuration,
  type PointTimeline,
  type PointTimelineEvent,
} from "@/lib/timeline";

interface Game {
  id: number;
  name: string;
  score_type: 'best_of' | 'first_to';
  score_value: number;
}

interface Player {
  id: number;
  name: string;
  avatar_url?: string | null;
}

interface PlayerRating {
  player_id: number;
  player_name: string;
  elo: number;
}

/** Draft persisted to localStorage so a refresh / lock screen doesn't lose
 *  the recorded points. `at` values are ms offsets from startedAt. */
interface LiveDraft {
  version: 1;
  gameId: number;
  team1Players: number[];
  team2Players: number[];
  startedAt: string;
  finishedAt: string | null;
  events: PointTimelineEvent[];
}

const DRAFT_KEY = 'liveMatchDraft.v1';

type Phase = 'setup' | 'scoring' | 'review';

function LiveMatchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selectedGameId, games, setSelectedGameId } = useSelectedGame();
  const selectedGameData = games.find(g => g.id === selectedGameId);
  const [players, setPlayers] = useState<Player[]>([]);
  const [ratings, setRatings] = useState<PlayerRating[]>([]);
  const [team1Players, setTeam1Players] = useState<number[]>([]);
  const [team2Players, setTeam2Players] = useState<number[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [events, setEvents] = useState<PointTimelineEvent[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  // Ticks to recompute the elapsed clock every second while scoring.
  const [tick, setTick] = useState(0);
  const [resumed, setResumed] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  // Open gamble matches for the selected game (rosters exposed so the
  // banner can match any team shape, either side order).
  const [openGambles, setOpenGambles] = useState<{
    id: number;
    red_player_id: number;
    blue_player_id: number;
    participants?: { team: number; player_id: number }[];
  }[]>([]);

  // Honour ?game= pre-selection (same as the normal record page)
  useEffect(() => {
    const gameParam = searchParams.get("game");
    if (gameParam) {
      const gameIdFromParam = parseInt(gameParam, 10);
      if (games.some((g: Game) => g.id === gameIdFromParam)) {
        setSelectedGameId(gameIdFromParam);
      }
    }
  }, [searchParams, games, setSelectedGameId]);

  useEffect(() => {
    fetch("/api/players")
      .then((res) => res.json())
      .then((data: Player[]) => setPlayers(data));
  }, []);

  useEffect(() => {
    if (selectedGameId) {
      fetch(`/api/leaderboard?game_id=${selectedGameId}`)
        .then((res) => res.json())
        .then((data) => setRatings(data));
      fetch(`/api/gambling/lobby?game_id=${selectedGameId}`)
        .then((res) => res.json())
        .then((data) => setOpenGambles(data.live ?? []))
        .catch(() => setOpenGambles([]));
    }
  }, [selectedGameId]);

  // Restore an in-progress match from localStorage (phone refreshed, screen
  // locked, browser closed mid-match — the points survive). The draft's own
  // game overrides the nav-selected one — the teams/scores belong to it.
  useEffect(() => {
    const restore = async () => {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const draft = JSON.parse(raw) as LiveDraft;
          if (draft.version === 1 && draft.startedAt && Array.isArray(draft.events)) {
            if (draft.gameId) setSelectedGameId(draft.gameId);
            setTeam1Players(draft.team1Players ?? []);
            setTeam2Players(draft.team2Players ?? []);
            setStartedAt(draft.startedAt);
            setFinishedAt(draft.finishedAt ?? null);
            setEvents(draft.events);
            setPhase(draft.finishedAt ? 'review' : 'scoring');
            setResumed(true);
          }
        }
      } catch {
        // Corrupt draft — ignore it
      }
      setDraftLoaded(true);
    };
    void restore();
  }, [setSelectedGameId]);

  // Persist the draft on every change while a match is live
  useEffect(() => {
    if (!draftLoaded || !startedAt) return;
    const draft: LiveDraft = {
      version: 1,
      gameId: selectedGameId ?? 0,
      team1Players,
      team2Players,
      startedAt,
      finishedAt,
      events,
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Storage full / unavailable — live tracking still works in memory
    }
  }, [draftLoaded, startedAt, finishedAt, events, team1Players, team2Players, selectedGameId]);

  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt, finishedAt]);

  function togglePlayer(team: 1 | 2, playerId: number) {
    setResumed(false);
    if (team === 1) {
      setTeam1Players((prev) =>
        prev.includes(playerId)
          ? prev.filter((id) => id !== playerId)
          : [...prev, playerId]
      );
      setTeam2Players((prev) => prev.filter((id) => id !== playerId));
    } else {
      setTeam2Players((prev) =>
        prev.includes(playerId)
          ? prev.filter((id) => id !== playerId)
          : [...prev, playerId]
      );
      setTeam1Players((prev) => prev.filter((id) => id !== playerId));
    }
  }

  const startMatch = useCallback(() => {
    setEvents([]);
    setFinishedAt(null);
    setStartedAt(new Date().toISOString());
    setResumed(false);
    setPhase('scoring');
  }, []);

  const discard = useCallback(() => {
    if (!confirm('Discard this live match? The scored points will be lost.')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    setEvents([]);
    setStartedAt(null);
    setFinishedAt(null);
    setNotes("");
    setResumed(false);
    setPhase('setup');
  }, []);

  /** Record a point for team index (0 | 1) at the CURRENT moment. */
  const recordPoint = useCallback((teamIndex: 0 | 1) => {
    if (!startedAt || finishedAt) return;
    const at = Math.max(0, Date.now() - new Date(startedAt).getTime());
    setEvents((prev) => [...prev, { team: teamIndex, at }]);
  }, [startedAt, finishedAt]);

  const undoLast = useCallback(() => {
    setEvents((prev) => prev.slice(0, -1));
  }, []);

  const removeEvent = useCallback((index: number) => {
    if (!confirm('Remove this point from the record?')) return;
    setEvents((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const endMatch = useCallback(() => {
    setFinishedAt(new Date().toISOString());
    setPhase('review');
  }, []);

  // Scores derived FROM the events — always in sync with the point order
  const score1 = useMemo(() => events.filter(e => e.team === 0).length, [events]);
  const score2 = useMemo(() => events.filter(e => e.team === 1).length, [events]);

  // The match is over at the last scored point: once the score target is
  // reached, everything (clock, live stats, submitted timeline) uses this end
  // — resuming/re-entering review can't inflate runtime into paid-achievement
  // territory (Marathon ⏱ pays on 15+ minutes). End match pressed within
  // 2 minutes of the last point still wins (it's the natural match end);
  // a gap larger than that is a detour (review, login, resume) — clamp to
  // the last point instead.
  const endedAt = useMemo(() => {
    if (!startedAt) return null;
    const target = selectedGameData?.score_value ?? Infinity;
    if (score1 + score2 < target || events.length === 0) return null; // still live
    const lastAt = events[events.length - 1].at;
    const trueEndMs = new Date(startedAt).getTime() + Math.max(0, lastAt);
    if (finishedAt && new Date(finishedAt).getTime() - trueEndMs <= 2 * 60_000) return finishedAt;
    return new Date(trueEndMs).toISOString();
  }, [startedAt, finishedAt, events, score1, score2, selectedGameData]);

  const liveStats = useMemo(() => {
    if (!startedAt) return null;
    const timeline: PointTimeline = { start: startedAt, end: endedAt, events };
    return computeTimelineStats(timeline, [score1, score2]);
  }, [startedAt, endedAt, events, score1, score2]);

  // `tick` is a dependency on purpose: it forces the clock to recompute
  // (and the header to re-render) once a second while the match is live.
  const elapsedMs = useMemo(() => {
    if (!startedAt) return 0;
    const end = endedAt ? new Date(endedAt).getTime() : Date.now();
    return end - new Date(startedAt).getTime();
  }, [startedAt, endedAt, tick]);

  const availablePlayers = players.filter(
    (p) => !team1Players.includes(p.id) && !team2Players.includes(p.id)
  );

  // When the picked players exactly cover a rostered side pair (RED and BLUE
  // seats compared as sets — A & B vs B & A on Team 1 are the same lineup),
  // an open/awaiting gamble settles the moment the match is recorded —
  // surface that BEFORE they start. Works for team gambles too (1v2, 2v2…).
  const attachableGambles = useMemo(() => {
    if (team1Players.length === 0 || team2Players.length === 0) return [];
    const sideA = [...new Set(team1Players)].sort((x, y) => x - y);
    const sideB = [...new Set(team2Players)].sort((x, y) => x - y);
    const sameSeats = (a: number[], b: number[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    return openGambles.filter(g => {
      const roster = g.participants?.length
        ? g.participants.map(p => ({ team: p.team as number, player_id: p.player_id as number }))
        : (Number.isInteger(g.red_player_id) && Number.isInteger(g.blue_player_id))
          ? [{ team: 0 as number, player_id: g.red_player_id }, { team: 1 as number, player_id: g.blue_player_id }]
          : [];
      const seat0 = [...new Set(roster.filter(r => r.team === 0).map(r => r.player_id))].sort((x, y) => x - y);
      const seat1 = [...new Set(roster.filter(r => r.team === 1).map(r => r.player_id))].sort((x, y) => x - y);
      return (sameSeats(sideA, seat0) && sameSeats(sideB, seat1)) || (sameSeats(sideA, seat1) && sameSeats(sideB, seat0));
    });
  }, [openGambles, team1Players, team2Players]);

  async function handleSubmit() {
    if (!startedAt || !selectedGameId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: selectedGameId,
          notes: notes || null,
          teams: [
            { team: 0, player_ids: team1Players, score: score1 },
            { team: 1, player_ids: team2Players, score: score2 },
          ],
          timeline: {
            start: startedAt,
            end: endedAt, // clamped to the last point — see `endedAt`
            events,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to record match");
      }
      const data = await res.json();

      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      // Straight to the match report — duration, point order, gamble settle
      // summary and punditry are already there.
      router.push(data.match_id ? `/matches/${data.match_id}` : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record match");
      setSubmitting(false);
    }
  }

  const gameName = (id: string) =>
    id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const targetHint = selectedGameData
    ? selectedGameData.score_type === 'best_of'
      ? `Best of ${selectedGameData.score_value} games`
      : `First to ${selectedGameData.score_value} points`
    : null;

  const team1Name = team1Players.length === 1 ? (players.find(p => p.id === team1Players[0])?.name ?? 'Team 1') : `Team 1 (${team1Players.length})`;
  const team2Name = team2Players.length === 1 ? (players.find(p => p.id === team2Players[0])?.name ?? 'Team 2') : `Team 2 (${team2Players.length})`;

  // ============ SETUP ============
  if (phase === 'setup') {
    return (
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold mb-2"><span className="inline-block align-middle mr-1">🔴</span> Live Match</h1>
          <p className="text-gray-500 text-sm">
            Record points as they happen — get the scoring order, match duration and comeback stories in the match report.
          </p>
        </div>

        {targetHint && (
          <div className="text-center text-sm text-gray-500 mb-4">
            {selectedGameData && (
              <span className="inline-flex items-center gap-2 px-3 py-1 bg-gray-100 rounded-full">
                🎮 {gameName(selectedGameData.name)} · {targetHint}
              </span>
            )}
          </div>
        )}

        {/* Teams */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[1, 2].map((teamNum) => {
            const isBlue = teamNum === 1;
            const selected = isBlue ? team1Players : team2Players;
            return (
              <div key={teamNum} className={`rounded-xl p-4 text-white ${isBlue ? 'bg-gradient-to-br from-blue-500 to-blue-600' : 'bg-gradient-to-br from-red-500 to-red-600'}`}>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-bold">{isBlue ? 'Team 1' : 'Team 2'}</h2>
                  <span className="text-sm text-white/80">{selected.length > 0 ? `${selected.length} player${selected.length > 1 ? 's' : ''}` : 'Tap below'}</span>
                </div>
                <div className="space-y-1.5 min-h-[36px]">
                  {selected.length === 0 ? (
                    <p className="text-white/70 text-xs">Add players from below</p>
                  ) : (
                    selected.map((playerId) => {
                      const player = players.find((p) => p.id === playerId);
                      return (
                        <button
                          key={playerId}
                          type="button"
                          onClick={() => togglePlayer(teamNum as 1 | 2, playerId)}
                          className="w-full flex items-center justify-between bg-card/20 backdrop-blur px-2.5 py-1.5 rounded-lg text-left"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <PlayerAvatar name={player?.name ?? ''} avatarUrl={player?.avatar_url} size={20} />
                            <span className="font-medium text-sm truncate">{player?.name}</span>
                          </div>
                          <span className="text-white/80 text-xs">✕</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Add players */}
        <div className="bg-card rounded-xl shadow-lg p-4 mb-6">
          <h3 className="text-xs font-semibold mb-3 text-gray-500 uppercase tracking-wide">Add players (B = Team 1, R = Team 2)</h3>
          <div className="flex flex-wrap gap-2">
            {availablePlayers.map((player) => {
              const rating = ratings.find((r) => r.player_id === player.id);
              const ratingBadge = rating ? Math.round(rating.elo) : null;
              return (
                <div key={player.id} className="flex items-center rounded-lg overflow-hidden border border-gray-200">
                  <div className="pl-2 flex items-center">
                    <PlayerAvatar name={player.name} avatarUrl={player.avatar_url} size={20} />
                  </div>
                  <button
                    type="button"
                    onClick={() => togglePlayer(1, player.id)}
                    className="px-2 py-2 text-xs font-medium bg-card text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                    title={`Add ${player.name} (${ratingBadge ?? '?'}) to Team 1`}
                  >
                    {player.name}{ratingBadge !== null ? <span className="ml-1 text-gray-400">{ratingBadge}</span> : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => togglePlayer(1, player.id)}
                    className="px-2 py-2 text-xs font-bold bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => togglePlayer(2, player.id)}
                    className="px-2 py-2 text-xs font-bold bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                  >
                    R
                  </button>
                </div>
              );
            })}
            {availablePlayers.length === 0 && (
              <p className="text-sm text-gray-500">Everyone is already picked.</p>
            )}
          </div>
        </div>

        {/* Bet attach banner: a matching open gamble settles when this records */}
        {attachableGambles.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
            🎲 {attachableGambles.length === 1 ? 'Gamble' : 'Gambles'}
            {' '}#{attachableGambles.map(g => g.id).join(', #')}{' '}
            {attachableGambles.length === 1 ? 'is' : 'are'} on this matchup — recording the result settles{' '}
            {attachableGambles.length === 1 ? 'it' : 'them'} automatically (bets, entries and pot).
            {' '}Betting on this game stays open to the clock in{' '}
            <Link href="/gambling" className="underline font-medium">the casino</Link>.
          </div>
        )}

        <button
          type="button"
          onClick={startMatch}
          disabled={team1Players.length === 0 || team2Players.length === 0}
          className="w-full py-4 bg-primary text-white rounded-xl font-semibold text-lg hover:bg-primary-hover transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          🔴 Start scoring
        </button>

        {team1Players.length === 0 || team2Players.length === 0 ? (
          <p className="text-center text-sm text-gray-400 mt-3">Pick at least one player per team to start</p>
        ) : (
          <p className="text-center text-sm text-gray-400 mt-3">The clock starts when you tap. Points are kept on this device, so brief refreshes are safe.</p>
        )}

        {players.length === 0 && (
          <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <p className="text-amber-800">
              No players available.{" "}
              <Link href="/players" className="underline font-medium">Add players first</Link>.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ============ SCORING ============
  if (phase === 'scoring' && startedAt) {
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    return (
      <div className="max-w-md mx-auto select-none">
        {/* Header: game + clock */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl px-5 py-4 mb-4 text-white">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-400">{selectedGameData ? gameName(selectedGameData.name) : ''}</div>
              <div className="font-semibold">{targetHint}</div>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold font-mono tabular-nums">{formatClock(elapsedMs)}</div>
              <div className="text-xs text-slate-400 flex items-center justify-end gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" /> live
              </div>
            </div>
          </div>
        </div>

        {resumed && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm text-center">
            Resumed an in-progress match from this device
          </div>
        )}

        {/* Scoreline */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl p-4 text-white text-center">
            <div className="text-xs font-semibold uppercase tracking-wide mb-1 opacity-80">{team1Name}</div>
            <div className="text-6xl font-bold tabular-nums">{score1}</div>
          </div>
          <div className="bg-gradient-to-br from-red-500 to-red-600 rounded-xl p-4 text-white text-center">
            <div className="text-xs font-semibold uppercase tracking-wide mb-1 opacity-80">{team2Name}</div>
            <div className="text-6xl font-bold tabular-nums">{score2}</div>
          </div>
        </div>

        {/* Score buttons */}
        <p className="text-center text-xs text-gray-400 mb-2">Tap the winner of each point</p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            type="button"
            onPointerDown={() => recordPoint(0)}
            className="touch-manipulation bg-gradient-to-b from-blue-500 to-blue-600 text-white rounded-2xl py-10 text-4xl font-bold active:scale-95 active:from-blue-600 transition-transform shadow-lg"
          >
            <div className="text-2xl">{team1Name}</div>
            <div className="mt-2 text-sm font-normal opacity-80">+1 point</div>
          </button>
          <button
            type="button"
            onPointerDown={() => recordPoint(1)}
            className="touch-manipulation bg-gradient-to-b from-red-500 to-red-600 text-white rounded-2xl py-10 text-4xl font-bold active:scale-95 active:from-red-600 transition-transform shadow-lg"
          >
            <div className="text-2xl">{team2Name}</div>
            <div className="mt-2 text-sm font-normal opacity-80">+1 point</div>
          </button>
        </div>

        {/* Undo + end */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            type="button"
            onClick={undoLast}
            disabled={events.length === 0}
            className="py-3 bg-card border-2 border-gray-200 rounded-xl font-semibold text-gray-700 hover:bg-gray-50 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↩️ Undo last
          </button>
          <button
            type="button"
            onClick={endMatch}
            className="py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 active:scale-95 transition-all shadow-lg"
          >
            🏁 End match
          </button>
        </div>

        {/* Event log */}
        <div className="bg-card rounded-xl shadow-lg overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Point log ({events.length})
            </span>
            {lastEvent && (
              <span className="text-xs text-gray-400">
                Last: #{events.length} at {formatClock(lastEvent.at)} → {lastEvent.team === 0 ? team1Name : team2Name}
              </span>
            )}
          </div>
          {events.length === 0 ? (
            <p className="px-4 py-4 text-sm text-gray-400">Nothing scored yet.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-gray-50">
              {[...events].reverse().map((ev, revIdx) => {
                const idx = events.length - 1 - revIdx;
                // Running score after this event
                const running = [0, 0];
                for (let i = 0; i <= idx; i++) running[events[i].team]++;
                const scorerTeam = ev.team === 0 ? team1Name : team2Name;
                return (
                  <div key={idx} className="flex items-center justify-between px-4 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs text-gray-400 font-mono tabular-nums w-10">#{idx + 1}</span>
                      <span className="text-xs text-gray-400 font-mono tabular-nums w-10">{formatClock(ev.at)}</span>
                      <span className={`text-sm truncate ${ev.team === 0 ? 'text-blue-600 font-medium' : 'text-red-600 font-medium'}`}>
                        {scorerTeam}
                      </span>
                      {running[0] === running[1] && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded-full text-gray-500">level</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-500 tabular-nums">{running[0]}-{running[1]}</span>
                      <button
                        type="button"
                        onClick={() => removeEvent(idx)}
                        className="w-6 h-6 rounded-full bg-gray-100 text-gray-400 hover:bg-red-100 hover:text-red-600 text-xs transition-colors"
                        title="Remove this point"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={discard}
          className="w-full py-2.5 text-sm text-gray-400 hover:text-red-600 transition-colors"
        >
          Abandon match
        </button>
      </div>
    );
  }

  // ============ REVIEW ============
  if (phase === 'review' && startedAt) {
    const winnerText = score1 > score2 ? `${team1Name} win` : score2 > score1 ? `${team2Name} win` : 'Draw';
    const comeback = score1 !== score2
      ? liveStats?.teams.find(t => t.maxDeficit >= 2 && t.score === Math.max(score1, score2))
      : undefined;
    return (
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold mb-2">🏁 Match complete</h1>
          <p className="text-gray-500 text-sm">Check the record, then file the match report.</p>
        </div>

        {/* Final scoreboard */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-5 mb-4 text-white">
          <div className="grid grid-cols-2 gap-4 items-center">
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{team1Name}</div>
              <div className="text-5xl font-bold">{score1}</div>
            </div>
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{team2Name}</div>
              <div className="text-5xl font-bold">{score2}</div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-slate-700 flex items-center justify-around text-center text-sm">
            <div>
              <div className="text-slate-400 text-xs uppercase tracking-wide mb-1">Duration</div>
              <div className="font-semibold font-mono">{liveStats?.durationMs ? formatDuration(liveStats.durationMs) : '—'}</div>
            </div>
            <div>
              <div className="text-slate-400 text-xs uppercase tracking-wide mb-1">Points</div>
              <div className="font-semibold font-mono">{events.length}</div>
            </div>
            <div>
              <div className="text-slate-400 text-xs uppercase tracking-wide mb-1">Result</div>
              <div className="font-semibold">{score1 > score2 ? '🏆 ' : score2 > score1 ? '🏆 ' : ''}{winnerText}</div>
            </div>
          </div>
        </div>

        {/* Live highlights */}
        {liveStats && (
          <div className="bg-card rounded-xl shadow-lg p-4 mb-4 space-y-1.5 text-sm">
            {liveStats.firstScorer !== null && (
              <div className="flex items-center gap-2">
                <span>{liveStats.firstScorer === 0 ? '🔵' : '🔴'}</span>
                <span className="text-gray-700">First point: <strong>{liveStats.firstScorer === 0 ? team1Name : team2Name}</strong></span>
              </div>
            )}
            {liveStats.leadChanges > 0 && (
              <div className="flex items-center gap-2">
                <span>🔀</span>
                <span className="text-gray-700">Lead changed hands <strong>{liveStats.leadChanges}</strong> time{liveStats.leadChanges === 1 ? '' : 's'}</span>
              </div>
            )}
            {liveStats.teams.filter(t => t.maxDeficit >= 2).map(t => (
              <div key={t.team} className="flex items-center gap-2">
                <span>😱</span>
                <span className="text-gray-700">
                  {t.team === 0 ? team1Name : team2Name} were <strong>{t.maxDeficit}</strong> down at worst
                </span>
              </div>
            ))}
            {liveStats.wireToWireWinners.length > 0 && (
              <div className="flex items-center gap-2">
                <span>🛡️</span>
                <span className="text-gray-700">
                  {liveStats.wireToWireWinners.map(i => i === 0 ? team1Name : team2Name).join(' & ')} led wire-to-wire
                </span>
              </div>
            )}
            {comeback && (
              <div className="flex items-center gap-2">
                <span>🔄</span>
                <span className="text-gray-700">
                  Comeback win from {comeback.maxDeficit} down!
                </span>
              </div>
            )}
          </div>
        )}

        {/* Notes */}
        <div className="mb-4">
          <label className="block text-sm font-semibold text-gray-700 mb-2">Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., Great comeback!"
            className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          />
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 mb-8">
          <button
            type="button"
            onClick={() => { setFinishedAt(null); setPhase('scoring'); }}
            className="py-3 bg-card border-2 border-gray-200 rounded-xl font-semibold text-gray-700 hover:bg-gray-50 transition-all"
          >
            ← Back to scoring
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="py-3 bg-primary text-white rounded-xl font-semibold hover:bg-primary-hover transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Filing...' : `✓ Record match (${score1}-${score2})`}
          </button>
        </div>

        {score1 + score2 >= 10 && liveStats?.durationMs && (
          <p className="text-center text-xs text-gray-400 mb-6">
            Duration will show on the match report — {formatDuration(liveStats.durationMs)} for {events.length} points.
          </p>
        )}
      </div>
    );
  }

  // Live match state loading (localStorage restore in flight)
  return (
    <div className="flex items-center justify-center min-h-64 text-gray-500">
      {draftLoaded ? null : 'Loading...'}
    </div>
  );
}

export default function LiveMatchPage() {
  return (
    <Suspense fallback={<div className="text-gray-500">Loading...</div>}>
      <LiveMatchContent />
    </Suspense>
  );
}