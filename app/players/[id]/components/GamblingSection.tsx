'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MoneyChart } from '@/components/MoneyChart';

// Gambling section on a player profile — the same tracking as the gambling
// leaderboard, per person: stat cards, net-over-time line, every gamble
// they've played, every bet they've placed.

interface Summary {
  balance: number;
  net: number;
  wagered: number;
  bets_won: number;
  bets_lost: number;
  gambles_played: number;
  gambles_won: number;
  gambles_lost: number;
  gambles_drawn: number;
}

interface PlayerGamble {
  gamble_match_id: number;
  game_name: string;
  scheduled_at: string;
  status: string;
  side: 'red' | 'blue';
  opponent_id: number;
  opponent_name: string;
  my_score: number | null;
  opponent_score: number | null;
  entry_fee: number;
  entry_net: number;
  result: 'win' | 'loss' | 'draw' | null;
}

interface PlayerBet {
  id: number;
  gamble_match_id: number;
  created_at: string;
  game_name: string;
  scheduled_at: string;
  red_player_name: string;
  blue_player_name: string;
  red_score: number;
  blue_score: number;
  stake: number;
  decimal_odds: number;
  status: string;
  payout: number | null;
}

const fmtDate = (dbStr: string) =>
  new Date(dbStr.replace(' ', 'T') + 'Z').toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export function GamblingSection({ playerId }: { playerId: number }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [netHistory, setNetHistory] = useState<{ gamble: number | null; date: string | null; net: number }[]>([]);
  const [gambles, setGambles] = useState<PlayerGamble[]>([]);
  const [bets, setBets] = useState<PlayerBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    fetch(`/api/gambling/player-stats?player_id=${playerId}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load gambling record');
        return res.json();
      })
      .then((d: { summary: Summary; net_history?: { gamble: number | null; date: string | null; net: number }[]; gambles: PlayerGamble[]; bets: PlayerBet[] }) => {
        setSummary(d.summary);
        setNetHistory(d.net_history ?? []);
        setGambles(d.gambles ?? []);
        setBets(d.bets ?? []);
      })
      .catch(err => console.error('Failed to load gambling stats:', err))
      .finally(() => setLoading(false));
  }, [playerId]);

  return (
    <div className="bg-card rounded-2xl shadow-lg overflow-hidden mt-8">
      {/* Clickable header, matching the per-game accordion styling */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-6 py-4 bg-gradient-to-r from-amber-100 to-orange-50 hover:from-amber-150 hover:to-orange-100 transition-colors flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-sm">
            🎲
          </div>
          <h2 className="text-xl font-bold text-gray-900">Gambling</h2>
          {summary && (
            <span className={`text-sm font-semibold ${summary.net > 0 ? 'text-green-600' : summary.net < 0 ? 'text-red-500' : 'text-gray-400'}`}>
              {summary.net > 0 ? '+' : ''}{summary.net.toLocaleString()} moose bucks
            </span>
          )}
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="p-6 space-y-6">
          {loading ? (
            <p className="text-gray-500 text-sm">Loading gambling record…</p>
          ) : !summary ? (
            <p className="text-gray-500 text-sm">No gambling activity yet.</p>
          ) : (
            <>
              {/* Stat cards — same casino style as the lobby leaderboard */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-4 text-white shadow">
                  <div className="text-xs font-medium text-slate-200 uppercase tracking-wide mb-1">Balance</div>
                  <div className="text-2xl font-bold">{summary.balance.toLocaleString()}</div>
                </div>
                <div className={`rounded-xl p-4 text-white shadow bg-gradient-to-br ${
                  summary.net >= 0 ? 'from-emerald-600 to-emerald-700' : 'from-rose-600 to-red-700'
                }`}>
                  <div className="text-xs font-medium text-white/80 uppercase tracking-wide mb-1">Net</div>
                  <div className="text-2xl font-bold">{summary.net > 0 ? '+' : ''}{summary.net.toLocaleString()}</div>
                </div>
                <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl p-4 text-white shadow">
                  <div className="text-xs font-medium text-white/80 uppercase tracking-wide mb-1">Staked</div>
                  <div className="text-2xl font-bold">{summary.wagered.toLocaleString()}</div>
                  <div className="text-[11px] text-white/80">{summary.bets_won} bets won · {summary.bets_lost} lost</div>
                </div>
                <div className="bg-gradient-to-br from-amber-400 to-orange-500 rounded-xl p-4 text-white shadow">
                  <div className="text-xs font-medium text-white/80 uppercase tracking-wide mb-1">Gambles</div>
                  <div className="text-2xl font-bold">{summary.gambles_played.toLocaleString()}</div>
                  <div className="text-[11px] text-white/80">
                    {summary.gambles_won}W · {summary.gambles_lost}L · {summary.gambles_drawn}D
                  </div>
                </div>
              </div>

              {/* Net over time — one point per official gamble, same form as the Skill History chart */}
              {netHistory.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">📈</span>
                    <span className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Net over time</span>
                  </div>
                  <MoneyChart points={netHistory} gradientId="playerNetGradient" />
                </div>
              )}

              {/* Gambles they've played */}
              <div>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Gambles played ({gambles.length})
                </h3>
                {gambles.length === 0 ? (
                  <p className="text-sm text-gray-500">Hasn&apos;t been matched as a player yet.</p>
                ) : (
                  <div className="rounded-xl bg-gray-50 divide-y divide-gray-100 overflow-hidden">
                    {gambles.map(g => (
                      <Link
                        key={g.gamble_match_id}
                        href={`/gambling/matches/${g.gamble_match_id}`}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-gray-100 transition-colors"
                      >
                        <span className="font-medium text-gray-800">
                          <span className={g.side === 'red' ? 'text-red-600' : 'text-blue-600'}>
                            {g.side === 'red' ? 'red' : 'blue'}
                          </span>{' '}
                          vs {g.opponent_name}
                        </span>
                        <span className="text-gray-500">{g.game_name} · {fmtDate(g.scheduled_at)}</span>
                        {g.status === 'cancelled' ? (
                          <span className="text-gray-400">cancelled — refunded</span>
                        ) : g.result === null ? (
                          <span className="text-gray-400">no result</span>
                        ) : (
                          <span className="font-semibold text-gray-700 tabular-nums">
                            {g.my_score}–{g.opponent_score}
                            {' '}
                            <span className={g.result === 'win' ? 'text-green-600' : g.result === 'loss' ? 'text-red-500' : 'text-gray-400'}>
                              {g.result === 'win' ? 'WON' : g.result === 'loss' ? 'LOST' : 'DRAW'}
                            </span>
                          </span>
                        )}
                        <span className="text-gray-500 tabular-nums">
                          entries {' '}
                          <span className={g.entry_net >= 0 ? 'text-green-600' : 'text-red-500'}>
                            {g.entry_net > 0 ? '+' : ''}{g.entry_net.toLocaleString()}
                          </span>
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Bets they've placed */}
              <div>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Bets placed ({bets.length})
                </h3>
                {bets.length === 0 ? (
                  <p className="text-sm text-gray-500">Hasn&apos;t placed any bets yet.</p>
                ) : (
                  <div className="rounded-xl bg-gray-50 divide-y divide-gray-100 overflow-hidden">
                    {bets.map(b => (
                      <Link
                        key={b.id}
                        href={`/gambling/matches/${b.gamble_match_id}`}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-gray-100 transition-colors"
                      >
                        <span className="font-medium text-gray-800">
                          <span className="text-red-600">{b.red_player_name}</span> vs <span className="text-blue-600">{b.blue_player_name}</span>
                        </span>
                        <span className="text-gray-500">{b.game_name} · {fmtDate(b.scheduled_at)}</span>
                        <span className="text-gray-700 tabular-nums">
                          {b.red_score}-{b.blue_score} for <b>{b.stake}</b> @ {b.decimal_odds.toFixed(2)}
                        </span>
                        {b.status === 'won' && (
                          <span className="font-semibold text-green-600">WON — paid {b.payout} (net +{(b.payout ?? 0) - b.stake})</span>
                        )}
                        {b.status === 'lost' && (
                          <span className="font-semibold text-red-500">LOST — −{b.stake}</span>
                        )}
                        {b.status === 'refunded' && (
                          <span className="text-gray-400">refunded</span>
                        )}
                        {b.status === 'open' && (
                          <span className="text-gray-400">still running</span>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}