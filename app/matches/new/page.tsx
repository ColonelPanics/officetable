"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSelectedGame } from "@/lib/hooks/useSelectedGame";
import { PlayerAvatar } from "@/components/PlayerAvatar";

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

function NewMatchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selectedGameId, games, setSelectedGameId } = useSelectedGame();
  const selectedGameData = games.find(g => g.id === selectedGameId);
  const [players, setPlayers] = useState<Player[]>([]);
  const [ratings, setRatings] = useState<PlayerRating[]>([]);
  const [team1Players, setTeam1Players] = useState<number[]>([]);
  const [team2Players, setTeam2Players] = useState<number[]>([]);
  const [team1Score, setTeam1Score] = useState<string>("0");
  const [team2Score, setTeam2Score] = useState<string>("0");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check URL params for pre-selected game
  useEffect(() => {
    const gameParam = searchParams.get("game");
    if (gameParam) {
      const gameIdFromParam = parseInt(gameParam, 10);
      const gameExists = games.some((g: Game) => g.id === gameIdFromParam);
      if (gameExists) {
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
        .then((data) => {
          setRatings(data);
        });
    }
  }, [selectedGameId]);

  function togglePlayer(team: 1 | 2, playerId: number) {
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedGameId) return;

    if (team1Players.length === 0 || team2Players.length === 0) {
      setError("Each team must have at least one player");
      return;
    }

    const score1 = parseInt(team1Score, 10);
    const score2 = parseInt(team2Score, 10);

    if (isNaN(score1) || isNaN(score2) || score1 < 0 || score2 < 0) {
      setError("Scores must be valid non-negative numbers");
      return;
    }

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
            {
              team: 0,
              player_ids: team1Players,
              score: score1,
            },
            {
              team: 1,
              player_ids: team2Players,
              score: score2,
            },
          ],
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to record match");
      }

      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record match");
    } finally {
      setSubmitting(false);
    }
  }

  const availablePlayers = players.filter(
    (p) => !team1Players.includes(p.id) && !team2Players.includes(p.id)
  );

  const score1 = parseInt(team1Score, 10) || 0;
  const score2 = parseInt(team2Score, 10) || 0;
  const winnerText = score1 > score2 ? "Team 1 wins" : score2 > score1 ? "Team 2 wins" : "Tie";

  // K-factor for Elo calculations
  const K_FACTOR = 25;

  // Calculate predicted result based on team Elo
  const prediction = useMemo(() => {
    if (team1Players.length === 0 || team2Players.length === 0 || !selectedGameData) return null;

    const team1Elo = team1Players.reduce((sum, id) => {
      const r = ratings.find((r) => r.player_id === id);
      return sum + (r?.elo ?? 0);
    }, 0);

    const team2Elo = team2Players.reduce((sum, id) => {
      const r = ratings.find((r) => r.player_id === id);
      return sum + (r?.elo ?? 0);
    }, 0);

    // Expected result formula: 1 / (1 + 10^((opponentElo - teamElo) / 180))
    const expectedTeam1 = 1 / (1 + Math.pow(10, (team2Elo - team1Elo) / 180));
    const expectedTeam2 = 1 / (1 + Math.pow(10, (team1Elo - team2Elo) / 180));

    let expectedTeam1Score, expectedTeam2Score
    // Expected score
    if (selectedGameData.score_type === 'best_of') {
        // For best of, we just take the ratios of the score_value, easy!
        expectedTeam1Score = Math.round(expectedTeam1 * selectedGameData.score_value);
        expectedTeam2Score = Math.round(expectedTeam2 * selectedGameData.score_value);
    } else if (selectedGameData.score_type === 'first_to') {
        // For first_to:
        // - Highest ratio = winner, full score
        // - Second ratio = double ratio of total score but capped at total - 1
        //
        // Note: Second ratio being doubled means results are closer for skill ranks that
        // are closer. This doesn't oblige by game-specific restrictions such as Table
        // Tennis where are lead of 2 points is needed
        if (expectedTeam1 > 0.5) {
            expectedTeam1Score = selectedGameData.score_value;
            expectedTeam2Score = Math.min((selectedGameData.score_value - 1), Math.round(expectedTeam2 * 2 * selectedGameData.score_value));
        } else {
            expectedTeam1Score = Math.min((selectedGameData.score_value - 1), Math.round(expectedTeam1 * 2 * selectedGameData.score_value));
            expectedTeam2Score = selectedGameData.score_value;
        }
    }

    // Calculate projected Elo changes based on entered scores
    const totalScore = score1 + score2;
    const actualTeam1 = totalScore === 0 ? 0.5 : score1 / totalScore;
    const actualTeam2 = totalScore === 0 ? 0.5 : score2 / totalScore;
    const projectedChange1 = K_FACTOR * (actualTeam1 - expectedTeam1);
    const projectedChange2 = K_FACTOR * (actualTeam2 - expectedTeam2);

    return {
      team1Elo,
      team2Elo,
      expectedTeam1,
      expectedTeam1Score,
      expectedTeam2,
      expectedTeam2Score,
      projectedChange1,
      projectedChange2,
    };
  }, [team1Players, team2Players, ratings, score1, score2, selectedGameData]);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Record Match</h1>
        {selectedGameData && (
          <p className="text-gray-500">
            {selectedGameData.score_type === 'best_of'
              ? `Best of ${selectedGameData.score_value} games`
              : `First to ${selectedGameData.score_value} points`}
          </p>
        )}
        <p className="text-sm text-gray-400 mt-2">
          Playing right now?{' '}
          <Link
            href={selectedGameId ? `/matches/live?game=${selectedGameId}` : '/matches/live'}
            className="text-red-600 hover:underline font-medium"
          >
            🔴 Track the match live
          </Link>{' '}
          for the scoring order, duration and comeback achievements.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Teams Section */}
        <div className="grid grid-cols-2 gap-6">
          {/* Team 1 — red side everywhere (matches the gamble/bookie sides
              and the live scorer; teams[0] = red) */}
          <div className="bg-gradient-to-br from-red-500 to-red-600 rounded-xl p-5 text-white">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Team 1</h2>
              <span className="text-3xl font-bold">{team1Score}</span>
            </div>
            <div className="space-y-2 min-h-[80px]">
              {team1Players.length === 0 ? (
                <p className="text-white/80 text-sm">Select players below</p>
              ) : (
                team1Players.map((playerId) => {
                  const player = players.find((p) => p.id === playerId);
                  const rating = ratings.find((r) => r.player_id === playerId);
                  return (
                    <div
                      key={playerId}
                      className="flex items-center justify-between bg-card/20 backdrop-blur px-3 py-2 rounded-lg"
                    >
                      <div className="flex items-center gap-2">
                        <PlayerAvatar
                          name={player?.name ?? ''}
                          avatarUrl={player?.avatar_url}
                          size={22}
                        />
                        <span className="font-medium">{player?.name}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => togglePlayer(1, playerId)}
                        className="text-white/80 hover:text-white text-sm"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Team 2 — blue side */}
          <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl p-5 text-white">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Team 2</h2>
              <span className="text-3xl font-bold">{team2Score}</span>
            </div>
            <div className="space-y-2 min-h-[80px]">
              {team2Players.length === 0 ? (
                <p className="text-white/80 text-sm">Select players below</p>
              ) : (
                team2Players.map((playerId) => {
                  const player = players.find((p) => p.id === playerId);
                  return (
                    <div
                      key={playerId}
                      className="flex items-center justify-between bg-card/20 backdrop-blur px-3 py-2 rounded-lg"
                    >
                      <div className="flex items-center gap-2">
                        <PlayerAvatar
                          name={player?.name ?? ''}
                          avatarUrl={player?.avatar_url}
                          size={22}
                        />
                        <span className="font-medium">{player?.name}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => togglePlayer(2, playerId)}
                        className="text-white/80 hover:text-white text-sm"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Score Input */}
        <div className="bg-card rounded-xl shadow-lg p-6">
          <h3 className="text-lg font-semibold mb-4 text-center">Score</h3>
          <div className="flex items-center justify-center gap-8">
            <div className="text-center">
              <label className="block text-sm font-medium text-red-600 mb-2">Team 1</label>
              <input
                type="number"
                value={team1Score}
                onChange={(e) => setTeam1Score(e.target.value)}
                min="0"
                className="w-24 text-center text-4xl font-bold border-2 border-red-200 rounded-xl px-3 py-2 focus:outline-none focus:border-red-500 focus:ring-2 focus:ring-red-200"
              />
            </div>
            <div className="text-3xl font-bold text-gray-300">VS</div>
            <div className="text-center">
              <label className="block text-sm font-medium text-blue-600 mb-2">Team 2</label>
              <input
                type="number"
                value={team2Score}
                onChange={(e) => setTeam2Score(e.target.value)}
                min="0"
                className="w-24 text-center text-4xl font-bold border-2 border-blue-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              />
            </div>
          </div>
          <div className="text-center mt-4">
            <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-lg font-semibold ${
              score1 > score2
                ? 'bg-red-100 text-red-700'
                : score2 > score1
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-700'
            }`}>
              {score1 > score2 ? '🏆 Team 1 wins!' : score2 > score1 ? '🏆 Team 2 wins!' : '⚖️ Tie'}
            </span>
          </div>
        </div>

        {/* Predicted Changes */}
        {prediction && (
          <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-xl p-5 text-white">
            <h3 className="text-sm font-semibold mb-3 text-slate-400 uppercase tracking-wide">Projected Elo Changes</h3>
            <div className="flex justify-around">
              <div className="text-center">
                <div className="text-xs text-slate-400 mb-1">Team 1</div>
                <div className={`text-2xl font-bold font-mono ${prediction.projectedChange1 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {prediction.projectedChange1 >= 0 ? '+' : ''}{prediction.projectedChange1.toFixed(1)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-slate-400 mb-1">Team 2</div>
                <div className={`text-2xl font-bold font-mono ${prediction.projectedChange2 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {prediction.projectedChange2 >= 0 ? '+' : ''}{prediction.projectedChange2.toFixed(1)}
                </div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-slate-700 grid grid-cols-2 gap-4 text-xs text-slate-400">
              <div>
                <span className="text-red-400">Team 1 Elo:</span> {prediction.team1Elo.toFixed(0)} | Expected: {prediction.expectedTeam1Score}
              </div>
              <div>
                <span className="text-blue-400">Team 2 Elo:</span> {prediction.team2Elo.toFixed(0)} | Expected: {prediction.expectedTeam2Score}
              </div>
            </div>
          </div>
        )}

        {/* Add Players */}
        {availablePlayers.length > 0 && (
          <div className="bg-card rounded-xl shadow-lg p-5">
            <h3 className="text-sm font-semibold mb-3 text-gray-500 uppercase tracking-wide">Add Players</h3>
            <div className="flex flex-wrap gap-2">
              {availablePlayers.map((player) => {
                const rating = ratings.find((r) => r.player_id === player.id);
                return (
                  <div key={player.id} className="flex items-center rounded-lg overflow-hidden border border-gray-200">
                    <div className="pl-2 flex items-center">
                      <PlayerAvatar
                        name={player.name}
                        avatarUrl={player.avatar_url}
                        size={20}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => togglePlayer(1, player.id)}
                      className="px-2 py-1.5 text-sm font-medium bg-card text-gray-700 hover:bg-red-50 hover:text-red-700 transition-colors"
                    >
                      {player.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePlayer(1, player.id)}
                      className="px-2 py-1.5 text-sm font-bold bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                      title="Add to Team 1"
                    >
                      T1
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePlayer(2, player.id)}
                      className="px-2 py-1.5 text-sm font-bold bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                      title="Add to Team 2"
                    >
                      T2
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Notes (optional)
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., Great comeback!"
            className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
            {error}
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-4 justify-center">
          <button
            type="submit"
            disabled={submitting || team1Players.length === 0 || team2Players.length === 0}
            className="px-8 py-3 bg-primary text-white rounded-xl font-semibold text-lg hover:bg-primary-hover transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Recording..." : "✓ Record Match"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>

      {players.length === 0 && (
        <div className="mt-8 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-amber-800">
            No players available.{" "}
            <a href="/players" className="underline font-medium">
              Add players first
            </a>{" "}
            before recording a match.
          </p>
        </div>
      )}
    </div>
  );
}

export default function NewMatchPage() {
  return (
    <Suspense fallback={<div className="text-gray-500">Loading...</div>}>
      <NewMatchContent />
    </Suspense>
  );
}
