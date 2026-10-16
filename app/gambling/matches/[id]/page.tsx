'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMe } from '@/lib/contexts/MeContext';
import { GambleOddsBoard } from '@/components/GambleOddsBoard';
import { betsClosingSoon, formatBetsCountdown } from '@/lib/betsClock';
import type { BankTransaction, Bet, GambleMatch, ScoreOutcome, SettleSummary } from '@/lib/types';

// Gamble match detail: countdown + odds board + bet form for others, score
// entry for the two players, full settlement view once done.

interface Detail {
  match: GambleMatch;
  derived_status: string;
  seconds_to_close: number;
  bets: Bet[];
  pool: number;
  final_score: { red: number; blue: number } | null;
  /** Ledger-reconstructed settlement, present once the gamble is settled. */
  summary?: SettleSummary | null;
  my_bets: Bet[];
  my_staked: number;
  is_participant: boolean;
  can_bet: boolean;
  can_score: boolean;
  can_cancel: boolean;
  can_correct: boolean;
}

interface BalanceInfo {
  balance: number;
  transactions: BankTransaction[];
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

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  bets_closed: 'bg-amber-100 text-amber-800',
  awaiting_score: 'bg-amber-100 text-amber-800',
  settled: 'bg-gray-200 text-gray-700',
  cancelled: 'bg-gray-200 text-gray-700',
};

export default function GambleMatchPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [summary, setSummary] = useState<SettleSummary | null>(null);
  const [stake, setStake] = useState(20);
  const [pick, setPick] = useState<{ red: number; blue: number } | null>(null);
  const [scoreRed, setScoreRed] = useState(7);
  const [scoreBlue, setScoreBlue] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (me) qs.set('player_id', String(me.id));
    const res = await fetch(`/api/gambling/matches/${id}?${qs}`);
    if (res.ok) {
      const body = await res.json();
      setDetail(body);
      // The API reconstructs the settlement from the ledger for settled
      // gambles — take it unless a fresher live-settle summary already exists.
      if (body.summary) setSummary(body.summary);
    }
    if (me) {
      const bankRes = await fetch(`/api/gambling/bank?player_id=${me.id}`);
      if (bankRes.ok) setBalance(await bankRes.json());
    }
  }, [id, me?.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => {
      load();
      // Local countdown re-render every second between fetches
      setTick(t => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [load]);
  const [tick, setTick] = useState(0);
  useEffect(() => { void tick; }, [tick]);

  async function placeBet() {
    if (!me || !pick || !detail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/gambling/matches/${id}/bets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player_id: me.id,
          red_score: pick.red,
          blue_score: pick.blue,
          stake,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Bet failed');
        return;
      }
      setNotice(`Bet placed: ${pick.red}-${pick.blue} for ${stake} — good luck!`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function enterScore() {
    if (!me || !detail) return;
    const redName = detail.match.red_player_name ?? 'Red player';
    const blueName = detail.match.blue_player_name ?? 'Blue player';
    if (!confirm(
      `Is ${redName} ${scoreRed}–${scoreBlue} ${blueName} the correct score?\n\n` +
      'This records the match, settles every bet and pays out — it cannot be undone.',
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gambling/matches/${id}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: me.id, red_score: scoreRed, blue_score: scoreBlue }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Settle failed');
        return;
      }
      setSummary(body.summary);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function cancelMatch() {
    if (!me || !detail) return;
    const refundTotal = 2 * detail.match.entry_fee + detail.pool;
    if (!confirm(
      `Cancel this gamble? ${detail.bets.length} bet${detail.bets.length === 1 ? '' : 's'} totalling ${detail.pool} bucks ` +
      `will be refunded, plus both ${detail.match.entry_fee}-buck entry fees (${refundTotal} total).\n\n` +
      'The challenge closes as cancelled — it cannot be undone.',
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gambling/matches/${id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: me.id }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Cancel failed');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!detail?.match) {
    return <p className="text-sm text-gray-500">Loading gamble…</p>;
  }

  const gm = detail.match;
  const ladder: ScoreOutcome[] = gm.odds?.outcomes ?? [];
  const predicted = gm.odds?.predictedLine;
  const isRed = me?.id === gm.red_player_id;
  const status = detail.derived_status;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-xl border border-gray-200 bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          {(() => {
            // Minutes while the betting window is long; the closing stretch
            // flips the badge to BETS CLOSING and the countdown to seconds.
            const closing = status === 'open' && betsClosingSoon(detail.seconds_to_close);
            return (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${closing ? 'bg-amber-100 text-amber-800' : (STATUS_BADGE[status] ?? 'bg-gray-100')}`}>
                {status === 'open' ? `BETS ${closing ? 'CLOSING' : 'OPEN'} — close in ${formatBetsCountdown(detail.seconds_to_close)}`
                  : status === 'bets_closed' ? 'BETS CLOSED'
                  : status === 'awaiting_score' ? 'WAITING ON SCORE'
                  : status.toUpperCase()}
              </span>
            );
          })()}
          {gm.challenge_id && (
            <Link href={`/gambling/challenges/${gm.challenge_id}`} className="text-xs text-gray-400 hover:text-gray-600">
              challenge #{gm.challenge_id}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3 text-xl font-bold">
          <span className={isRed ? 'underline decoration-red-400' : ''}>
            <span className="text-red-600">{gm.red_player_name}</span>
          </span>
          <span className="text-gray-400 text-base">vs</span>
          <span className="text-blue-600">{gm.blue_player_name}</span>
          <span className="text-gray-400 text-base">· {gm.game_name}</span>
        </div>
        <div className="text-sm text-gray-500 mt-1">
          {fmtTime(gm.scheduled_at)} · entry {gm.entry_fee} each · bookie's line{' '}
          <span className="text-amber-600 font-semibold">{predicted}</span>
        </div>
        <div className="text-sm text-gray-500">
          Entries pay after a 10% house fee, split by score against{' '}
          <span className="font-semibold text-gray-700">{evensLabel(gm.payout_line ?? 'true_even')}</span> —
          dead level when the final score lands right on the line, otherwise your share is your score out of{' '}
          {gm.outcome_total}.
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Every missed bet feeds the gambler's pot, which pays out <b>50% house / 25% to the winner / 25% by score</b> —
          so it genuinely pays to have people bet <i>against</i> you. Everyone piling onto your exact score gives
          terrible value; the contrarian money is what builds your pot. And the winner's 25% makes playing —
          and winning — worth the entry on its own.
        </div>
        {gm.special_rules && (
          <div className="text-sm text-amber-700 italic mt-1">📜 Special rules: {gm.special_rules}</div>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg bg-green-50 border border-green-200 text-green-800 px-4 py-3 text-sm">{notice}</div>
      )}

      {/* Settled view */}
      {(status === 'settled' || status === 'cancelled') && (
        <SettledView gm={gm} bets={detail.bets} summary={summary} finalScore={detail.final_score} />
      )}

      {/* Wrong score? Participants can correct a settled gamble within 24 hours
          — re-runs the recorded match and re-marks the bets; money with the bookie. */}
      {status === 'settled' && detail.can_correct && (
        <CorrectScorePanel gm={gm} finalScore={detail.final_score} onDone={load} />
      )}

      {status !== 'settled' && status !== 'cancelled' && (
        <>
          {/* Odds board + bet form for outsiders */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-card p-5">
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-3">
                Exact-score odds (UK prices) · pot {detail.pool} moose bucks
              </div>
              <p className="text-[11px] text-gray-400 -mt-2 mb-3">
                ⚠️ House rule: there are two pots — the bet pool and the house bank — and total payouts are
                capped at the two combined − 1, so the casino always keeps at least 1 moose buck. If long-odds
                picks hit together, winnings scale down to fit. Whatever's left after payouts — the losing
                stakes — pays out 25% to the match winner and 25% by score, so backing the crowd's pick only
                fattens the pot you're betting against.
              </p>
              <GambleOddsBoard
                ladder={ladder}
                predictedLine={predicted}
                total={gm.outcome_total}
                stake={stake}
                selected={pick}
                onSelect={detail.can_bet ? (r, b) => setPick({ red: r, blue: b }) : undefined}
              />
            </div>

            <div className="rounded-xl border border-gray-200 bg-card p-5 space-y-3">
              {detail.is_participant ? (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  You're playing this one — players can't bet their own match (match-fixing guard).
                </div>
              ) : !me ? (
                <div className="text-sm text-gray-500">
                  <span className="font-semibold">🔐 Log in (top right)</span> with your bank
                  credentials to bet.
                </div>
              ) : status === 'open' ? (
                <div className="space-y-3">
                  <div className="text-sm text-gray-600">
                    Balance: <b>{balance ? balance.balance.toLocaleString() : '…'}</b> moose bucks
                  </div>
                  <div className="text-sm text-gray-700">
                    Pick: <b>{pick ? `${pick.red}-${pick.blue}` : 'none'}</b>{' '}
                    {pick && (() => {
                      const o = ladder.find(x => x.redScore === pick.red && x.blueScore === pick.blue);
                      return o ? <span className="text-gray-500">@ {o.fractional}</span> : null;
                    })()}
                  </div>
                  <label className="block">
                    <span className="text-xs text-gray-500">Stake</span>
                    <input
                      type="number" min={1} value={stake}
                      onChange={e => setStake(parseInt(e.target.value, 10) || 0)}
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
                    />
                  </label>
                  <button
                    onClick={placeBet}
                    disabled={busy || !pick || stake < 1}
                    className="w-full font-semibold bg-primary text-white rounded-lg px-4 py-2 hover:bg-primary-hover disabled:opacity-40"
                  >
                    Place bet
                  </button>
                </div>
              ) : (
                <div className="text-sm text-gray-500">Bets are closed for this match.</div>
              )}

              {/* Score entry for participants */}
              {detail.can_score && (
                <div className="border-t border-gray-200 pt-3 space-y-2">
                  <div className="text-sm font-semibold text-gray-800">Enter the final score</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={0} max={gm.outcome_total} value={scoreRed}
                      onChange={e => setScoreRed(parseInt(e.target.value, 10) || 0)}
                      className="w-16 px-2 py-1.5 rounded-lg border border-gray-200 bg-background text-center text-red-600 font-bold"
                      aria-label="Red score"
                    />
                    <span className="text-gray-400">–</span>
                    <input
                      type="number" min={0} max={gm.outcome_total} value={scoreBlue}
                      onChange={e => setScoreBlue(parseInt(e.target.value, 10) || 0)}
                      className="w-16 px-2 py-1.5 rounded-lg border border-gray-200 bg-background text-center text-blue-600 font-bold"
                      aria-label="Blue score"
                    />
                    <span className={`text-xs ${scoreRed + scoreBlue === gm.outcome_total ? 'text-green-600' : 'text-red-500'}`}>
                      = {scoreRed + scoreBlue} / {gm.outcome_total}
                    </span>
                  </div>
                  <button
                    onClick={enterScore}
                    disabled={busy || scoreRed + scoreBlue !== gm.outcome_total}
                    className="w-full font-semibold bg-primary text-white rounded-lg px-4 py-2 hover:bg-primary-hover disabled:opacity-40"
                  >
                    Record result & settle
                  </button>
                  <p className="text-[11px] text-gray-400">
                    Settles every bet, splits entries by score against the evens line after the 10% house fee,
                    and divides whatever's left in the pot 50% house / 25% to the winner / 25% by score.
                  </p>
                </div>
              )}

              {detail.can_cancel && (
                <div className="border-t border-gray-200 pt-3">
                  <button
                    onClick={cancelMatch}
                    disabled={busy}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel gamble (refund everyone)
                  </button>
                </div>
              )}
            </div>
          </div>

        </>
      )}

      <BetsPanel bets={detail.bets} pool={detail.pool} />
    </div>
  );
}

/** Every bet on this match — the full amount each bettor put on each pick,
 *  and (once settled) exactly who won what and who lost. */
function BetsPanel({ bets, pool }: { bets: Bet[]; pool: number }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Bets ({bets.length}) — pool {pool} moose bucks
      </h3>
      {bets.length === 0 ? (
        <p className="text-sm text-gray-500">Nobody has put anything on this one yet.</p>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-card divide-y divide-gray-100">
          {bets.map(b => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span className="font-medium text-gray-800">{b.bettor_name}</span>
              <span className="text-gray-600">
                put <b>{b.stake}</b> on <b>{b.red_score}-{b.blue_score}</b> @ {b.decimal_odds.toFixed(2)}
              </span>
              {b.status === 'won' && (
                <span className="font-semibold text-green-700">
                  WON — paid {b.payout} (net +{(b.payout ?? 0) - b.stake})
                </span>
              )}
              {b.status === 'lost' && (
                <span className="font-semibold text-red-700">
                  LOST — −{b.stake}
                </span>
              )}
              {b.status === 'open' && <span className="text-gray-500">staked and live</span>}
              {b.status === 'refunded' && <span className="text-gray-500">refunded</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettledView({ gm, bets, summary, finalScore }: { gm: GambleMatch; bets: Bet[]; summary: SettleSummary | null; finalScore: { red: number; blue: number } | null }) {
  const won = bets.filter(b => b.status === 'won');
  const lost = bets.filter(b => b.status === 'lost');
  const refunded = bets.filter(b => b.status === 'refunded');
  const pool = won.reduce((s, b) => s + b.stake, 0) + lost.reduce((s, b) => s + b.stake, 0);
  const returns = won.reduce((s, b) => s + (b.payout ?? 0), 0);

  // Per-player payout: what each participant paid in (entry fee) and what
  // came back (entry share + pot shares), with a coloured net total — the
  // same won/lost clarity the bet list has. The API reconstructs the
  // settlement from the bank ledger, so this shows for reloaded pages too.
  const entrySplitNote = summary
    ? (summary.entryEvenHit
      ? `evens line hit (${summary.payoutLine}) — 50/50 entry split`
      : `entries split by score${summary.payoutLine && summary.payoutLine !== 'true_even' && summary.payoutLine !== 'elo_even' ? ` (line was ${summary.payoutLine})` : ''}`)
    : null;
  const playerCards = ([
    { id: gm.red_player_id, name: gm.red_player_name ?? 'Red player', colour: 'text-red-600', bg: 'bg-red-50', border: 'border-red-100' },
    { id: gm.blue_player_id, name: gm.blue_player_name ?? 'Blue player', colour: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
  ]).map(p => {
    const entry = summary?.playerEntry.find(pe => pe.playerId === p.id);
    const scoreShare = summary?.pot.scoreShares.find(s => s.playerId === p.id)?.amount ?? 0;
    const winnerShare = summary?.pot.winnerPlayerId === p.id ? (summary?.pot.winnerShare ?? 0) : 0;
    const entryNet = entry ? entry.returned - entry.fee : null;
    const net = entryNet != null ? entryNet + scoreShare + winnerShare : null;
    return { ...p, entry, entryNet, scoreShare, winnerShare, net };
  });
  const netColour = (n: number) => (n > 0 ? 'text-green-700' : n < 0 ? 'text-red-700' : 'text-gray-500');
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;

  return (
    <div className="rounded-xl border border-gray-200 bg-card p-5 space-y-4">
      <div className="text-lg font-bold text-gray-900">
        Final: <span className="text-red-600">{gm.red_player_name}</span> {summary?.finalScore.red ?? finalScore?.red ?? '?'}–{summary?.finalScore.blue ?? finalScore?.blue ?? '?'}{' '}
        <span className="text-blue-600">{gm.blue_player_name}</span>
      </div>

      {gm.status === 'cancelled' ? (
        <div className="text-sm text-gray-600">Gamble cancelled — all stakes and entry fees refunded.</div>
      ) : (
        <>
          {/* Who got what: entry back + pot shares + coloured net total */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {playerCards.map(p => (
              <div key={p.id} className={`rounded-lg border ${p.border} ${p.bg} p-3`}>
                <div className="flex items-baseline justify-between gap-2">
                  <div className={`font-bold ${p.colour}`}>{p.name}</div>
                  {p.net != null ? (
                    <div className={`font-bold ${netColour(p.net)}`}>
                      {signed(p.net)} net
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400">net pending</div>
                  )}
                </div>
                <ul className="text-xs text-gray-700 mt-1.5 space-y-0.5">
                  {p.entry ? (
                    <li>
                      Entry: paid <b>{p.entry.fee}</b> → got back <b>{p.entry.returned}</b>{' '}
                      <span className={`font-semibold ${netColour(p.entryNet ?? 0)}`}>({signed(p.entryNet ?? 0)})</span>
                    </li>
                  ) : (
                    <li className="text-gray-400">entry share pending</li>
                  )}
                  {(p.scoreShare > 0 || p.winnerShare > 0) ? (
                    <li>
                      Pot:{p.winnerShare > 0 && <> winner share <b>{p.winnerShare}</b></>}
                      {p.scoreShare > 0 && <> score share <b>{p.scoreShare}</b></>}
                      {(p.scoreShare + p.winnerShare) > 0 && ` (+${p.scoreShare + p.winnerShare})`}
                    </li>
                  ) : (
                    <li className="text-gray-400">no pot share</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
          {summary && (
            <div className="text-[11px] text-gray-400 -mt-2">
              {entrySplitNote} · house took <b>{summary.pot.houseFee}</b> fee on entries
              {summary.pot.house > 0
                ? ` · house kept ${summary.pot.house} of the pot`
                : summary.pot.houseLoss > 0 ? ` · house covered −${summary.pot.houseLoss}` : ''}
              {summary.returnsCapped && ` · winnings capped at bet pool + house bank − 1 (${summary.payoutCap} was payable)`}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xs text-gray-500 uppercase">Bet pool</div>
              <div className="font-bold text-gray-900">{summary ? summary.pool : pool}</div>
              <div className="text-xs text-gray-500">{won.length} won · {lost.length} lost · paid out {summary ? summary.returns : returns}</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xs text-gray-500 uppercase">Bank pot</div>
              {summary ? (
                summary.pot.positive ? (
                  <div className="text-gray-800">
                    <div>house <b>{summary.pot.house}</b></div>
                    <div>winner <b>{summary.pot.winnerShare}</b></div>
                    <div>score split <b>{summary.pot.scoreShares.map(s => s.amount).join(' / ')}</b></div>
                  </div>
                ) : (
                  <div className="text-red-700">house covered −{summary.pot.houseLoss}</div>
                )
              ) : (
                <div className="text-gray-500">
                  pot {pool ? `${Math.max(0, pool - returns)} left` : undefined} · returns {returns}
                </div>
              )}
            </div>
          </div>

          <Link href={`/matches/${gm.match_id ?? ''}`} className="text-sm text-primary underline">
            See the recorded match on the leaderboard →
          </Link>
        </>
      )}

      {refunded.length > 0 && (
        <div className="text-sm text-gray-500">{refunded.length} bets were refunded before the close.</div>
      )}
    </div>
  );
}
/** Post-settlement score correction (24h window, participants only):
 *  re-runs the recorded match through the Elo replay and re-marks every bet's
 *  won/lost + payout. The bank is deliberately untouched — money true-ups are
 *  settled with the bookie directly, out-of-band. */
function CorrectScorePanel({ gm, finalScore, onDone }: {
  gm: GambleMatch;
  finalScore: { red: number; blue: number } | null;
  onDone: () => void;
}) {
  const [red, setRed] = useState(finalScore?.red ?? 0);
  const [blue, setBlue] = useState(finalScore?.blue ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { me } = useMe();

  async function correct() {
    if (!me) return;
    if (!confirm(
      `Is ${(gm.red_player_name ?? 'Red player')} ${red}–${blue} ${(gm.blue_player_name ?? 'Blue player')} correct?\n\n` +
      'Replays the recorded match and re-marks every bet result.',
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gambling/matches/${gm.id}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: me.id, red_score: red, blue_score: blue }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Correction failed');
        return;
      }
      setDone(true);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-5">
      <div className="text-sm font-semibold text-amber-800 mb-2">Wrong score recorded?</div>
      {done ? (
        <p className="text-sm text-amber-800">
          Corrected — the match has been re-recorded and the bets re-marked. Any pays/repays on the money go through the bookie.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3">
            <input
              type="number" min={0} max={gm.outcome_total} value={red}
              onChange={e => setRed(parseInt(e.target.value, 10) || 0)}
              className="w-16 px-2 py-1.5 rounded-lg border border-gray-200 bg-background text-center text-red-600 font-bold"
              aria-label="Corrected red score"
            />
            <span className="text-gray-400">–</span>
            <input
              type="number" min={0} max={gm.outcome_total} value={blue}
              onChange={e => setBlue(parseInt(e.target.value, 10) || 0)}
              className="w-16 px-2 py-1.5 rounded-lg border border-gray-200 bg-background text-center text-blue-600 font-bold"
              aria-label="Corrected blue score"
            />
            <span className={`text-xs ${red + blue === gm.outcome_total ? 'text-green-600' : 'text-red-500'}`}>
              = {red + blue} / {gm.outcome_total}
            </span>
          </div>
          {error && <p className="text-xs text-red-700 mb-2">{error}</p>}
          <button
            onClick={correct}
            disabled={busy || red + blue !== gm.outcome_total || (red === finalScore?.red && blue === finalScore?.blue)}
            className="font-semibold bg-amber-600 text-white rounded-lg px-4 py-2 hover:bg-amber-700 disabled:opacity-40 text-sm"
          >
            Correct the final score
          </button>
          <p className="text-[11px] text-amber-700 mt-2">
            Replays the recorded match (Elo recalculated from here forward) and re-marks every bet result — banking
            true-ups are settled with the bookie. Available for 24 hours after the settle.
          </p>
        </>
      )}
    </div>
  );
}
