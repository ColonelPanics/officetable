'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMe } from '@/lib/contexts/MeContext';
import { useSelectedGame } from '@/lib/hooks/useSelectedGame';
import { GambleOddsBoard } from '@/components/GambleOddsBoard';
import type { Challenge, ChallengeSlot, ChallengeTerm, GambleMatch, OddsLadder } from '@/lib/types';

// Challenge negotiation: current terms up top, history thread below, and
// contextual actions — the non-terms author accepts/declines/counters, the
// terms author cancels.

interface Detail {
  challenge: Challenge;
  /** Team-challenge seats (empty for legacy 1v1s). NULL player = open seat. */
  slots: ChallengeSlot[];
  terms_history: ChallengeTerm[];
  gamble_match: GambleMatch | null;
  derived_status: string | null;
  seconds_to_close: number | null;
  pool: number;
  ladder?: OddsLadder | null;
}

const fmtTime = (dbStr: string) =>
  new Date(dbStr.replace(' ', 'T') + 'Z').toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });

const EVENS: Record<string, string> = {
  true_even: 'evens on a draw (5-5)',
  elo_even: "evens on the bookie's line",
};

const evensLabel = (line: string) => EVENS[line] ?? `evens on ${line}`;

export default function ChallengeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const { games } = useSelectedGame();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const [counterFee, setCounterFee] = useState(50);
  const [counterTime, setCounterTime] = useState('');
  const [counterSide, setCounterSide] = useState<'red' | 'blue'>('red');
  const [counterLine, setCounterLine] = useState('elo_even');
  const [counterRules, setCounterRules] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/gambling/challenges/${id}`);
    if (res.ok) {
      const data: Detail = await res.json();
      setDetail(data);
      const last = data.terms_history[data.terms_history.length - 1];
      if (last && !counterOpen) {
        setCounterFee(last.entry_fee);
        const d = new Date(last.scheduled_at.replace(' ', 'T') + 'Z');
        const pad = (n: number) => String(n).padStart(2, '0');
        setCounterTime(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
        setCounterSide(last.red_player_id === (data.challenge.challenger_id) ? 'red' : 'blue');
      setCounterLine(data.challenge.payout_line ?? 'elo_even');
      setCounterRules(data.challenge.special_rules ?? '');
      }
    }
  }, [id, counterOpen]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function respond(action: 'accept' | 'decline' | 'cancel' | 'counter', counter?: unknown, claimSide?: 'red' | 'blue') {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gambling/challenges/${id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: me.id, action, ...(counter ? { counter } : {}), ...(claimSide ? { claim_side: claimSide } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Something went wrong');
        return;
      }
      if (action === 'accept' && body.gambleMatch?.id) {
        router.push(`/gambling/matches/${body.gambleMatch.id}`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return <p className="text-sm text-gray-500">Loading challenge…</p>;
  }

  const { challenge, terms_history, gamble_match, slots } = detail;
  const isBroadcast = !!challenge.broadcast;
  const isTeam = slots.length > 0;
  const openSeats = slots.filter(s => s.player_id == null);
  const openSides = (['red', 'blue'] as const).filter(side => slots.some(s => s.side === side && s.player_id == null));
  const awaitingCount = slots.filter(s => s.player_id != null && !s.accepted_at).length;
  const mySlot = me ? slots.find(s => s.player_id === me.id) : undefined;
  const amSeated = !!mySlot;
  const amMaker = me?.id === challenge.challenger_id;
  const iSentTerms = me?.id === challenge.terms_by;
  const amParticipant = me != null && (
    me.id === challenge.challenger_id
    || me.id === challenge.opponent_id
    || (isBroadcast && me.id !== challenge.challenger_id)
    || amSeated
  );
  const counterpart = challenge.challenger_id === me?.id ? challenge.opponent_name : challenge.challenger_name;
  const redName = challenge.red_player_id == null
    ? 'first to accept'
    : challenge.red_player_id === challenge.challenger_id ? challenge.challenger_name : (challenge.opponent_name ?? 'first to accept');
  const gameTotal = games.find(g => g.id === challenge.game_id)?.score_value ?? null;
  const counterLines: { value: string; label: string }[] = [
    { value: 'elo_even', label: "Evens on the bookie's predicted line" },
    { value: 'true_even', label: 'Evens on a draw (5-5)' },
  ];
  if (gameTotal != null) {
    for (let red = 1; red <= 9; red++) {
      const blue = gameTotal - red;
      if (blue < 1 || blue > 9) continue;
      counterLines.push({ value: `${red}-${blue}`, label: `Custom line ${red}-${blue}` });
    }
  }

  return (
    <div className="space-y-5">
      {/* Current terms */}
      <div className="rounded-xl border border-gray-200 bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-gray-900">
            {challenge.challenger_name} vs {isBroadcast ? 'first to accept' : challenge.opponent_name}
            <span className="ml-2 text-sm font-normal text-gray-500">{challenge.game_name}{isBroadcast ? ' · broadcast' : ''}</span>
          </h2>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            challenge.status === 'pending' ? 'bg-green-100 text-green-800'
            : challenge.status === 'countered' ? 'bg-amber-100 text-amber-800'
            : challenge.status === 'accepted' ? 'bg-blue-100 text-blue-800'
            : 'bg-gray-200 text-gray-600'
          }`}>
            {challenge.status}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Entry</div>
            <div className="font-semibold text-gray-900">{challenge.entry_fee} each</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Red side</div>
            <div className="font-semibold text-red-600">{redName}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">When</div>
            <div className="font-semibold text-gray-900">{fmtTime(challenge.scheduled_at)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Terms by</div>
            <div className="font-semibold text-gray-900">{challenge.terms_by_name}</div>
          </div>
        </div>
        <div className="mt-3 text-sm">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Payout line</div>
          <div className="font-semibold text-gray-900">{challenge.payout_line ? evensLabel(challenge.payout_line) : 'evens on a draw (5-5)'}</div>
        </div>
        {challenge.special_rules && (
          <div className="mt-2 text-sm">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Special rules</div>
            <div className="text-amber-700 italic">📜 {challenge.special_rules}</div>
          </div>
        )}
        {isBroadcast && (
          <div className="mt-2 text-xs text-amber-700">
            📢 Broadcast challenge — anyone (except the challenger) can accept and take the opposite side. Countering isn't possible. It expires 5 minutes before the start if nobody accepts.
          </div>
        )}
        {isTeam && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Team gamble — {slots.filter(s => s.side === 'red').length}v{slots.filter(s => s.side === 'blue').length}{' · '}
              {openSeats.length > 0
                ? `${openSeats.length} open seat${openSeats.length === 1 ? '' : 's'} left`
                : awaitingCount > 0
                  ? `awaiting ${awaitingCount} acceptance${awaitingCount === 1 ? '' : 's'}`
                  : 'waiting to complete…'}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {(['red', 'blue'] as const).map(side => (
                <div key={side}>
                  <div className={`text-[11px] font-semibold uppercase tracking-wide ${side === 'red' ? 'text-red-500' : 'text-blue-500'}`}>{side} side</div>
                  <ul className="mt-1 space-y-1 text-sm">
                    {slots.filter(s => s.side === side).map(s => (
                      <li key={s.id} className="flex flex-wrap items-baseline gap-2">
                        {s.player_id == null ? (
                          <span className="text-amber-600">📢 open seat — first to claim</span>
                        ) : (
                          <>
                            <span className={`font-medium ${side === 'red' ? 'text-red-600' : 'text-blue-600'}`}>{s.player_name}</span>
                            {s.accepted_at
                              ? <span className="text-[11px] text-green-600">✓ accepted</span>
                              : s.player_id === challenge.challenger_id
                                ? <span className="text-[11px] text-green-600">maker</span>
                                : <span className="text-[11px] text-amber-600">⏳ awaiting their accept</span>}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="text-xs text-gray-400 mt-1">
              Everyone except the maker must accept — team-mates included. Entry fees are only charged when the FULL shape is filled and accepted.
            </div>
          </div>
        )}
      </div>

      {/* Team-challenge actions: hold/claim seats, maker withdraws */}
      {isTeam && challenge.status === 'pending' && me && (
        <div className="rounded-xl border border-gray-200 bg-card p-4 flex flex-wrap items-center gap-3">
          {amMaker ? (
            <>
              <span className="text-sm text-gray-500">
                Waiting on {openSeats.length + awaitingCount} seat{openSeats.length + awaitingCount === 1 ? '' : 's'} to fill — named players accept, broadcast seats get claimed.
              </span>
              <button
                disabled={busy}
                onClick={() => respond('cancel')}
                className="ml-auto px-4 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                Withdraw challenge
              </button>
            </>
          ) : mySlot && !mySlot.accepted_at ? (
            <>
              <button
                disabled={busy}
                onClick={() => respond('accept')}
                className="font-semibold bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Accept — you'll pay {challenge.entry_fee} once everyone's in
              </button>
              <button
                disabled={busy}
                onClick={() => respond('decline')}
                className="px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Decline (cancels the challenge)
              </button>
            </>
          ) : !mySlot && openSeats.length > 0 ? (
            <>
              {openSides.length === 1 ? (
                <button
                  disabled={busy}
                  onClick={() => respond('accept', undefined, openSides[0])}
                  className="font-semibold bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  Claim the {openSides[0]} seat — join for {challenge.entry_fee} moose bucks
                </button>
              ) : (
                <>
                  <span className="text-sm text-gray-500">Open seat on both sides — pick one:</span>
                  {openSides.map(side => (
                    <button
                      key={side}
                      disabled={busy}
                      onClick={() => respond('accept', undefined, side)}
                      className={`font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-50 ${side === 'red' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                    >
                      Join {side} ({challenge.entry_fee})
                    </button>
                  ))}
                </>
              )}
              <span className="text-xs text-gray-400">You pay only when the whole shape is filled and accepted.</span>
            </>
          ) : (
            <span className="text-sm text-gray-500">
              You're in — waiting on {awaitingCount + openSeats.length} other seat{awaitingCount + openSeats.length === 1 ? '' : 's'}.
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>
      )}

      {/* Actions */}
      {!me && (challenge.status === 'pending' || challenge.status === 'countered') && (
        <div className="text-sm text-gray-500">
          <span className="font-semibold">🔐 Log in (top right)</span> with your bank credentials to respond.
        </div>
      )}
      {/* Legacy 1v1/broadcast actions (team challenges use the block above) */}
      {!isTeam && amParticipant && (challenge.status === 'pending' || challenge.status === 'countered') && (
        <div className="rounded-xl border border-gray-200 bg-card p-4 flex flex-wrap items-center gap-3">
          {!iSentTerms ? (
            <>
              <button
                disabled={busy}
                onClick={() => respond('accept')}
                className="font-semibold bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Accept — both pay {challenge.entry_fee}
              </button>
              {!isBroadcast && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => setCounterOpen(!counterOpen)}
                    className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {counterOpen ? 'Hide counter form' : 'Counter (change terms)'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => respond('decline')}
                    className="px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Decline
                  </button>
                </>
              )}
              {isBroadcast && (
                <span className="text-xs text-gray-500">You'd take the {challenge.challenger_side === 'red' ? 'blue' : 'red'} side — no countering on broadcasts.</span>
              )}
            </>
          ) : (
            <>
              <span className="text-sm text-gray-500">
                Waiting on {isBroadcast ? 'someone to accept' : `${counterpart} to respond to your terms`}.
              </span>
              <button
                disabled={busy}
                onClick={() => respond('cancel')}
                className="ml-auto px-4 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                Withdraw challenge
              </button>
            </>
          )}
        </div>
      )}

      {/* Odds preview while negotiating */}
      {!gamble_match && detail.ladder && (
        <div className="rounded-xl border border-gray-200 bg-card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-3">Odds preview (frozen on accept)</div>
          <GambleOddsBoard ladder={detail.ladder.outcomes} predictedLine={detail.ladder.predictedLine} total={detail.ladder.total} />
        </div>
      )}

      {/* Counter form */}
      {counterOpen && (
        <div className="rounded-xl border border-gray-200 bg-card p-5 space-y-3">
          <div className="text-sm font-semibold text-gray-900">Counter the terms</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-500">Entry fee each</span>
              <input
                type="number" min={10} max={500} value={counterFee}
                onChange={e => setCounterFee(parseInt(e.target.value, 10) || 0)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">When (local)</span>
              <input
                type="datetime-local" value={counterTime}
                onChange={e => setCounterTime(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Red side plays</span>
              <select
                value={counterSide}
                onChange={e => setCounterSide(e.target.value as 'red' | 'blue')}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
              >
                <option value="red">{challenge.challenger_name}</option>
                <option value="blue">{challenge.opponent_name}</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Payout line</span>
              <select
                value={counterLine}
                onChange={e => setCounterLine(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
              >
                {counterLines.map(pl => (
                  <option key={pl.value} value={pl.value}>{pl.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-gray-500">Special rules (optional)</span>
            <textarea
              value={counterRules}
              maxLength={500}
              onChange={e => setCounterRules(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background text-sm"
              rows={3}
            />
          </label>
          <button
            disabled={busy}
            onClick={() => respond('counter', {
              entry_fee: counterFee,
              scheduled_at: counterTime,
              side: counterSide,
              payout_line: counterLine,
              ...(counterRules.trim() ? { special_rules: counterRules.trim() } : {}),
            })}
            className="font-semibold bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-hover disabled:opacity-50"
          >
            Send counter-offer
          </button>
        </div>
      )}

      {/* Accepted → link to gamble match */}
      {gamble_match && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm">
          Challenge accepted — the gamble is live.
          <a href={`/gambling/matches/${gamble_match.id}`} className="ml-2 font-semibold text-green-800 underline">
            Open gamble #{gamble_match.id} →
          </a>
          {detail.derived_status && <span className="ml-2 text-green-700">({detail.derived_status})</span>}
        </div>
      )}

      {/* Terms history */}
      <section>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Negotiation thread</h3>
        <ol className="space-y-2">
          {terms_history.map((t, i) => (
            <li key={t.id} className={`rounded-lg border px-4 py-2.5 text-sm ${i === terms_history.length - 1 ? 'border-primary/40 bg-primary/5' : 'border-gray-200 bg-card'}`}>
              <div className="text-gray-900">
                <b>{t.proposed_by_name}</b> proposed {t.entry_fee} moose bucks each at {fmtTime(t.scheduled_at)}, red:{' '}
                <span className="font-medium text-red-600">
                  {t.red_player_id == null ? 'first to accept' : t.red_player_id === challenge.challenger_id ? challenge.challenger_name : (challenge.opponent_name ?? 'first to accept')}
                </span>
                {t.payout_line ? <span className="ml-1">· {evensLabel(t.payout_line)}</span> : null}
              </div>
              {t.special_rules && <div className="text-xs text-amber-700 italic">📜 {t.special_rules}</div>}
              <div className="text-xs text-gray-400">{t.created_at.replace('T', ' ').substring(0, 16)} UTC</div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}