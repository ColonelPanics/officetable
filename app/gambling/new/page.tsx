'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMe } from '@/lib/contexts/MeContext';
import { useSelectedGame } from '@/lib/hooks/useSelectedGame';
import { GambleOddsBoard } from '@/components/GambleOddsBoard';
import type { OddsLadder } from '@/lib/types';

// New challenge: pick opponent, game, entry fee, side and time. The odds
// preview is computed live in the browser from the same lib/ math the
// accept path server-side uses — display only, never authoritative.

export default function NewChallengePage() {
  const { me, players } = useMe();
  const { selectedGameId, games, selectedGame, setSelectedGameId } = useSelectedGame();
  const router = useRouter();

  const [opponentId, setOpponentId] = useState<number | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  // Team gamble builder: the maker sits on their chosen side (seat 0), plus
  // extra seats that are either a named player or a broadcast/null open seat.
  // The other side is made entirely of these seats — a named one, two open
  // ones for a 1v2, whatever shape you want (up to 4 a side).
  const [teamMode, setTeamMode] = useState(false);
  const [myExtraSeats, setMyExtraSeats] = useState<(number | null)[]>([null]);
  const [otherSeats, setOtherSeats] = useState<(number | null)[]>([null, null]);
  const [entryFee, setEntryFee] = useState(50);
  const [side, setSide] = useState<'red' | 'blue'>('red');
  const [payoutLine, setPayoutLine] = useState('elo_even');
  const [specialRules, setSpecialRules] = useState('');
  const [scheduledLocal, setScheduledLocal] = useState(() => {
    // Default: one hour from now, local ISO datetime-local format
    const d = new Date(Date.now() + 60 * 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live odds preview (client-side lib math); season ratings come from the
  // server normally — for the preview we fetch nothing: we need elo, so we
  // call the ladder preview endpoint instead — see effect below.
  const [ladder, setLadder] = useState<OddsLadder | null>(null);
  const [preview, setPreview] = useState<{
    redName: string; blueName: string; predicted: string; total: number;
  } | null>(null);
  const [previewTimer, setPreviewTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const opponent = broadcast ? null : (players.find(p => p.id === opponentId) ?? null);
  const redName = side === 'red' ? (me?.name ?? 'Red player') : (opponent?.name ?? 'Red player');
  const blueName = side === 'blue' ? (me?.name ?? 'Blue player') : (opponent?.name ?? 'Blue player');

  // Debounced preview fetch — the client lib needs Elo ratings from the DB,
  // so the preview runs through the games/odds endpoint.
  const gameId = selectedGameId;
  useEffect(() => {
    if (!gameId || !me || broadcast || teamMode || !opponentId) { setLadder(null); setPreview(null); return; }
    if (previewTimer) clearTimeout(previewTimer);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/gambling/odds-preview?game_id=${gameId}&red=${side === 'red' ? me.id : opponentId}&blue=${side === 'blue' ? me.id : opponentId}`
        );
        if (res.ok) {
          const data = await res.json();
          setLadder(data.ladder);
          setPreview({
            redName,
            blueName,
            predicted: data.ladder.predictedLine,
            total: data.player_totals_total,
          });
        }
      } catch {
        // preview failing is non-fatal
      }
    }, 400);
    setPreviewTimer(timer);
    return () => clearTimeout(timer);
  }, [gameId, me?.id, opponentId, side, redName, blueName, broadcast, teamMode]);

  async function submit() {
    if (!me) return;
    if (!teamMode && !broadcast && !opponentId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/gambling/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenger_id: me.id,
          ...(teamMode
            ? (side === 'red'
              ? { red_slots: [me.id, ...myExtraSeats], blue_slots: otherSeats }
              : { blue_slots: [me.id, ...myExtraSeats], red_slots: otherSeats })
            : {
                broadcast,
                ...(broadcast ? {} : { opponent_id: opponentId }),
              }),
          game_id: selectedGameId,
          entry_fee: entryFee,
          scheduled_at: scheduledLocal,
          side,
          payout_line: payoutLine,
          ...(specialRules.trim() ? { special_rules: specialRules.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Failed to create the challenge');
        return;
      }
      router.push(`/gambling/challenges/${body.challenge_id}`);
    } finally {
      setSubmitting(false);
    }
  }

  const feeInvalid = !Number.isInteger(entryFee) || entryFee < 10 || entryFee > 500;
  const teamShapeInvalid =
    teamMode && (otherSeats.length < 1 || myExtraSeats.length > 3 || otherSeats.length > 4);
  const namedIds = [...myExtraSeats, ...otherSeats].filter((x): x is number => x != null && x !== me?.id);

  // Payout line options: evens presets + custom R-B lines that sum to the
  // game total (10-0 / 0-10 are deliberately not choosable — real wins/draws
  // have their own payout rules).
  const total = selectedGame?.score_value ?? 10;
  const payoutLines: { value: string; label: string }[] = [
    { value: 'elo_even', label: ladder ? `Evens on the bookie's line (${ladder.predictedLine})` : "Evens on the bookie's predicted line" },
    { value: 'true_even', label: "Evens on a draw (5-5)" },
  ];
  for (let red = 1; red <= 9; red++) {
    const blue = total - red;
    if (blue < 1 || blue > 9) continue;
    payoutLines.push({ value: `${red}-${blue}`, label: `Custom line ${red}-${blue} — evens if it lands` });
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-card p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Opponent (1v1 modes only — teams use the seat editor below) */}
          {!teamMode && (broadcast ? (
            <div className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Challenging</span>
              <div className="mt-1 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-800">
                📢 Broadcast — first player to accept plays the opposite side
              </div>
              <span className="text-xs text-gray-400">
                Countering isn't possible on broadcasts. If nobody accepts by 5 minutes before the start, it expires.
              </span>
            </div>
          ) : (
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Challenging</span>
              <select
                value={opponentId ?? ''}
                onChange={e => setOpponentId(parseInt(e.target.value, 10) || null)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-gray-800"
              >
                <option value="">Choose a player…</option>
                {players.filter(p => p.id !== me?.id).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <span className="text-xs text-gray-400">
                {me ? `You are ${me.name} — log out (top right) if that's wrong.` : 'Not logged in — log in (top right) to send challenges.'}
              </span>
            </label>
          ))}

          {/* Game */}
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Game</span>
            <select
              value={selectedGameId ?? ''}
              onChange={e => {
                const id = parseInt(e.target.value, 10);
                if (id) setSelectedGameId(id);
              }}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-gray-800"
            >
              {games.map(g => (
                <option key={g.id} value={g.id}>{g.name} (to {g.score_value})</option>
              ))}
            </select>
            <span className="text-xs text-gray-400">
              {selectedGame?.score_type === 'best_of'
                ? 'Fixed-total game — betting on the exact score.'
                : selectedGame ? 'This game has no fixed score total, betting unavailable.' : ''}
            </span>
          </label>

          {/* Entry fee */}
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Entry fee (moose bucks each)</span>
            <input
              type="number"
              min={10}
              max={500}
              value={entryFee}
              onChange={e => setEntryFee(parseInt(e.target.value, 10) || 0)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-gray-800"
            />
            <span className="text-xs text-gray-400">Between 10 and 500. Both players pay the same on accept.</span>
          </label>

          {/* Time */}
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">When (your local time)</span>
            <input
              type="datetime-local"
              value={scheduledLocal}
              onChange={e => setScheduledLocal(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-gray-800"
            />
            <span className="text-xs text-gray-400">Bets close 2 minutes before this. Unaccepted challenges expire 5 minutes before the start.</span>
          </label>
        </div>

        {/* Mode toggles */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={teamMode}
              onChange={e => setTeamMode(e.target.checked)}
              className="w-4 h-4 accent-amber-600"
            />
            <span className="text-sm text-gray-700 font-medium">
              ⚔️ Team gamble — uneven teams welcome (1v2 you vs two of them, 2v2…). Seats can be named players or open for anyone to claim.
            </span>
          </label>
          {!teamMode && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={broadcast}
                onChange={e => setBroadcast(e.target.checked)}
                className="w-4 h-4 accent-amber-600"
              />
              <span className="text-sm text-gray-700 font-medium">📢 Broadcast — open to everyone, first to accept plays the other side</span>
            </label>
          )}
        </div>

        {/* Team seat editor */}
        {teamMode && (() => {
          const namedTaken = namedIds;
          const seatRow = (
            seat: number | null,
            idx: number,
            seats: (number | null)[],
            setSeats: (next: (number | null)[]) => void,
            canRemove: boolean,
          ) => (
            <div key={idx} className="flex items-center gap-2">
              <select
                value={seat == null ? 'open' : String(seat)}
                onChange={e => {
                  const next = [...seats];
                  next[idx] = e.target.value === 'open' ? null : parseInt(e.target.value, 10);
                  setSeats(next);
                }}
                className="flex-1 px-2 py-1.5 rounded-lg border border-gray-200 bg-background text-gray-800 text-sm"
              >
                <option value="open">📢 Open seat — anyone can claim it</option>
                {players.filter(p => p.id !== me?.id && !namedTaken.includes(p.id)).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {canRemove && (
                <button
                  type="button"
                  title="Remove seat"
                  onClick={() => setSeats(seats.filter((_, i) => i !== idx))}
                  className="px-1.5 py-1 text-gray-400 hover:text-red-500"
                >
                  ✕
                </button>
              )}
            </div>
          );
          const MY_MAX_EXTRA = 3; // me + up to 3 more = 4 a side
          const otherColour = side === 'red' ? 'text-blue-500' : 'text-red-500';
          const myColour = side === 'red' ? 'text-red-500' : 'text-blue-500';
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                <div className={`text-xs font-semibold uppercase tracking-wide ${myColour}`}>Your side — {side === 'red' ? 'red' : 'blue'}</div>
                <div className="px-2 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800 font-medium">
                  {me ? me.name : 'You'} (you — maker)
                </div>
                {myExtraSeats.map((s, i) => seatRow(s, i, myExtraSeats, setMyExtraSeats, true))}
                {myExtraSeats.length < MY_MAX_EXTRA && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setMyExtraSeats([...myExtraSeats, null])}
                      className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                      + open seat
                    </button>
                    <button
                      type="button"
                      disabled={players.filter(p => p.id !== me?.id && !namedTaken.includes(p.id)).length === 0}
                      onClick={() => {
                        const firstFree = players.find(p => p.id !== me?.id && !namedTaken.includes(p.id));
                        if (firstFree) setMyExtraSeats([...myExtraSeats, firstFree.id]);
                      }}
                      className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      + named seat
                    </button>
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                <div className={`text-xs font-semibold uppercase tracking-wide ${otherColour}`}>Opposition — {side === 'red' ? 'blue' : 'red'}</div>
                {otherSeats.map((s, i) => seatRow(s, i, otherSeats, setOtherSeats, otherSeats.length > 1))}
                {otherSeats.length < 4 && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setOtherSeats([...otherSeats, null])}
                      className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                      + open seat
                    </button>
                    <button
                      type="button"
                      disabled={players.filter(p => p.id !== me?.id && !namedTaken.includes(p.id)).length === 0}
                      onClick={() => {
                        const firstFree = players.find(p => p.id !== me?.id && !namedTaken.includes(p.id));
                        if (firstFree) setOtherSeats([...otherSeats, firstFree.id]);
                      }}
                      className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      + named seat
                    </button>
                  </div>
                )}
                <div className="text-xs text-gray-400">
                  At least one seat. Looking for 2 opponents? Leave two open — the first two to claim play with/against you.
                </div>
              </div>
            </div>
          );
        })()}

        {/* Side */}
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Your side</span>
          <div className="flex gap-2 mt-1">
            {(['red', 'blue'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  side === s
                    ? s === 'red' ? 'bg-red-600 text-white border-red-600' : 'bg-blue-600 text-white border-blue-600'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {s === 'red' ? '🔴 Red' : '🔵 Blue'}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-400">
            {teamMode
              ? `You sit in seat 0 of the ${side} side${myExtraSeats.length ? ` with ${myExtraSeats.length} team-mate seat${myExtraSeats.length === 1 ? '' : 's'}` : ''} — the ${side === 'red' ? 'blue' : 'red'} side has ${otherSeats.length} seat${otherSeats.length === 1 ? '' : 's'}. Every seat holder except you must accept before it opens.`
              : broadcast
                ? side === 'red'
                  ? 'You play red · first to accept plays blue'
                  : 'You play blue · first to accept plays red'
                : `Red side: ${redName} · Blue side: ${blueName}`}
          </span>
        </div>

        {/* Payout line */}
        <label className="block max-w-md">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Payout line (part of the terms — can be countered)</span>
          <select
            value={payoutLine}
            onChange={e => setPayoutLine(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-gray-800"
          >
            {payoutLines.map(pl => (
              <option key={pl.value} value={pl.value}>{pl.label}</option>
            ))}
          </select>
          <span className="text-xs text-gray-400">
            If the final score equals the line, the players' entry pot is split 50/50 instead of by score share. Winner-quarter still follows the score.
          </span>
        </label>

        {/* Special rules */}
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Special rules (optional)</span>
          <textarea
            value={specialRules}
            maxLength={500}
            onChange={e => setSpecialRules(e.target.value)}
            placeholder="e.g. loser buys the winner a coffee · no jumpers · best of three rounds scored as one match"
            className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-gray-800 text-sm"
            rows={3}
          />
          <span className="text-xs text-gray-400">
            Free-text the gamblers see before betting — displayed everywhere but never changes the odds ({specialRules.length}/500).
          </span>
        </label>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>
        )}

        <button
          onClick={submit}
          disabled={!me || (!broadcast && !opponentId && !teamMode) || teamShapeInvalid || !selectedGameId || feeInvalid || submitting}
          className="w-full sm:w-auto font-semibold bg-primary text-white rounded-lg px-6 py-2.5 hover:bg-primary-hover shadow-sm disabled:opacity-40"
        >
          {submitting ? 'Sending…' : teamMode ? 'Send team challenge' : 'Send challenge'}
        </button>
        <p className="text-xs text-gray-400">
          No money moves until the challenge is accepted —{' '}
          {teamMode
            ? 'and every seat is filled and accepted; seat holders pay only then, and anyone declining or expiring strands nothing.'
            : broadcast
              ? "first player to accept takes the other side, and broadcasts can't be countered."
              : 'they can accept, decline, or counter your terms.'}
        </p>
      </div>

      {/* Odds preview */}
      {ladder && (
        <div className="rounded-xl border border-gray-200 bg-card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
            Odds preview — Elo + head-to-head
          </div>
          <div className="text-sm text-gray-700 mb-3">
            <span className="font-semibold text-red-600">{preview?.redName}</span> vs{' '}
            <span className="font-semibold text-blue-600">{preview?.blueName}</span>
            {' · '}bookie's line <b>{ladder.predictedLine}</b>
          </div>
          <GambleOddsBoard ladder={ladder.outcomes} predictedLine={ladder.predictedLine} total={ladder.total} />
        </div>
      )}
    </div>
  );
}