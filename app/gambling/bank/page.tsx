'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useMe } from '@/lib/contexts/MeContext';
import type { BankTransaction } from '@/lib/types';

// Your Alces Bookie account — the central office bank is where moose bucks
// actually live ("bank is the truth"). Register a new account or connect one
// you already registered on the bank, see your ledger, and keep an eye on
// movement sync.
//
// These credentials are ALSO your gambling login. Logged out, an unlinked
// site profile can still be claimed: pick the profile, register/link the bank
// account, and the server logs this browser in as that profile. Once linked,
// only the logged-in owner can change or disconnect it.

interface BankData {
  player_id: number;
  balance: number;
  transactions: BankTransaction[];
  house_balance: number;
  mirror_enabled?: boolean;
  bank_username: string | null;
  bank_linked_at?: string | null;
  sync_backlog?: { pending: number; failed: number; unverified: number } | null;
}

const REF_LABEL: Record<string, string> = {
  challenge_fee: 'Entry fee',
  bet_stake: 'Bet stake',
  gambler_payout: 'Bet won',
  player_share: 'Entry share back',
  pot_winner_share: 'Won the gamble',
  pot_score_share: 'Score pot share',
  house_fee: 'House fee',
  pot_house_cut: 'House cut',
  house_loss: 'House payout over-cap',
  topup: 'Moose bucks top-up',
  seed: 'Starting moose',
  refund: 'Refund',
};

const fmtTime = (dbStr: string) =>
  new Date(dbStr.replace(' ', 'T') + 'Z').toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export default function BankPage() {
  const { me, players, refresh } = useMe();
  const [data, setData] = useState<BankData | null>(null);
  const [mode, setMode] = useState<'create' | 'link'>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [profileId, setProfileId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Logged out, the page is the claiming desk: act on the profile you pick.
  const actingId = me?.id ?? profileId;
  const actingName =
    me?.name ?? (profileId ? players.find(p => p.id === profileId)?.name : undefined);

  const load = useCallback(async () => {
    if (!me) {
      setData(null); // logged out — nothing personal to show yet
      return;
    }
    const res = await fetch(`/api/gambling/bank?player_id=${me.id}`);
    if (res.ok) setData(await res.json());
  }, [me?.id]);

  useEffect(() => { load(); }, [load]);

  async function submitLink(action: 'create' | 'link') {
    if (!actingId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/gambling/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: actingId, action, username, password }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; bank_username?: string };
      if (!res.ok) {
        setError(body.error ?? 'Registration failed');
        return;
      }
      setPassword('');
      setNotice(`Account ${body.bank_username} linked — you're playing it as ${actingName}.`);
      await refresh(); // the successful link logs this browser in
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function resyncFailed() {
    if (!me) return;
    setBusy(true);
    try {
      await fetch('/api/gambling/bank/resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: me.id }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!me || !confirm(
      'Disconnect this Alces Bookie account from your player profile?\n\n' +
      'Your credentials will be cleared from the site — after this you can\'t log ' +
      'back in as this profile unless the account is claimed again.'
    )) return;
    setBusy(true);
    setError(null);
    try {
      await fetch('/api/gambling/bank/link', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: me.id }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Back link */}
      <Link href="/gambling" className="inline-flex items-center gap-2 text-gray-500 hover:text-primary transition-colors">
        ← Back to the casino
      </Link>

      <h1 className="text-3xl font-bold">🏦 Your bank account</h1>

      {data && data.mirror_enabled === false && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
          <strong>Mock bank mode.</strong> This site is running its own local mint
          (accounts start at an invented balance) and nothing is being moved on the
          Alces Bookie central bank. Fine for testing — don&apos;t treat these balances
          as real.
        </div>
      )}

      {!me && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm">
          You&apos;re not logged in. Already registered? Log in with your bank username + password
          (🔐 top right). First time? Pick your site profile below and register your Alces Bookie
          account — a successful link logs you in as that profile.
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-card p-5 space-y-3">
        {me && data?.bank_username ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Linked account</div>
                <div className="text-xl font-bold text-gray-900">{data.bank_username}</div>
              </div>
              <button
                onClick={unlink}
                disabled={busy}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
            <div className="text-3xl font-bold text-gray-900">
              {data.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
              <span className="text-sm font-normal text-gray-500">moose bucks</span>
            </div>
            {data.sync_backlog && (data.sync_backlog.pending > 0 || data.sync_backlog.failed > 0 || data.sync_backlog.unverified > 0) && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                <span>
                  ⏳ {data.sync_backlog.pending} movement{data.sync_backlog.pending === 1 ? '' : 's'} still syncing to the central bank
                  {data.sync_backlog.failed > 0 && <> · {data.sync_backlog.failed} failed (one controlled retry per press)</>}
                  {data.sync_backlog.unverified > 0 && <> · {data.sync_backlog.unverified} need manual verification (the drainer couldn&apos;t prove on the bank whether the transfer landed)</>}
                </span>
                {(data.sync_backlog.failed > 0 || data.sync_backlog.unverified > 0) && (
                  <button
                    onClick={resyncFailed}
                    disabled={busy}
                    className="shrink-0 font-semibold text-amber-800 underline hover:no-underline disabled:opacity-50"
                  >
                    Retry failed →
                  </button>
                )}
              </div>
            )}
            <div className="text-xs text-gray-400">
              Your login uses this account&apos;s username + password (managed on the central bank).
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-gray-600">
              {me
                ? <>{me.name} has no Alces Bookie account linked yet — every player registers their
                    own account on the shared office bank. These credentials become your login.</>
                : <>Pick the site profile you&apos;re registering below, then create or link your
                    Alces Bookie account. A successful link logs you in as that profile.</>}
            </div>
            <div className="text-xs text-gray-400">
              No account yet? You can still play everything on the game side — leaderboards,
              matches and achievements don&apos;t need the bank.
            </div>

            {!me && (
              <label className="block">
                <span className="text-xs text-gray-500">Site profile to claim</span>
                <select
                  value={profileId ?? ''}
                  onChange={e => setProfileId(parseInt(e.target.value, 10) || null)}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
                >
                  <option value="">Choose profile…</option>
                  {players.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex gap-2 text-sm">
              <button
                onClick={() => setMode('create')}
                className={`px-3 py-1.5 rounded-lg font-semibold ${mode === 'create' ? 'bg-primary text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              >
                Create a new account
              </button>
              <button
                onClick={() => setMode('link')}
                className={`px-3 py-1.5 rounded-lg font-semibold ${mode === 'link' ? 'bg-primary text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              >
                Link an existing account
              </button>
            </div>

            <div className="space-y-2">
              <label className="block">
                <span className="text-xs text-gray-500">Bank username</span>
                <input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder={mode === 'create' ? 'pick one — 4-25 letters/numbers' : 'e.g. AdamB'}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Bank password</span>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-background"
                  onKeyDown={e => { if (e.key === 'Enter' && actingId && username && password && !busy) void submitLink(mode); }}
                />
              </label>
              {mode === 'create' && (
                <p className="text-xs text-gray-400">
                  Creating a new account mints you <b>500 moose bucks</b> on the bank.
                </p>
              )}
              <button
                onClick={() => submitLink(mode)}
                disabled={busy || !username || !password || !actingId}
                className="font-semibold bg-primary text-white rounded-lg px-4 py-2 hover:bg-primary-hover disabled:opacity-40"
              >
                {mode === 'create' ? 'Register account' : 'Link account'}
                <span className="ml-1 opacity-75">as {actingName ?? '…'}</span>
              </button>
            </div>

            {/* 18+ disclaimer — gambling account creation is staff-only and adults-only */}
            <div className="text-xs text-gray-500 border-t border-gray-200 pt-3 leading-relaxed">
              <b>18+ office staff only.</b> Gambling on this platform is strictly for office
              employees aged 18 and over, played in virtual moose bucks for fun — there is no
              real money, no prizes of any worth, and no way to cash out. Know your limits:
              if gambling stops feeling like a laugh between rounds at the table, take a break.
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg bg-green-50 border border-green-200 text-green-800 px-4 py-3 text-sm">{notice}</div>
      )}

      {/* Ledger — own account only; logged out there's nothing personal to show */}
      {me && data && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Ledger ({data.transactions.length})
          </h2>
          {data.transactions.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing has moved yet.</p>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-card divide-y divide-gray-100">
              {data.transactions.map(t => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                  <span className="font-medium text-gray-800">{REF_LABEL[t.ref_type] ?? t.ref_type}</span>
                  <span className="text-xs text-gray-400">{t.memo ?? ''} · {fmtTime(t.created_at)}</span>
                  <span className={`font-semibold tabular-nums ${t.amount >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {t.amount > 0 ? '+' : ''}{t.amount}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-2">
            Amounts are the site&apos;s ledger — the central bank may round its own side
            (it skims a small percentage of every receipt into its reserve).
          </p>
        </section>
      )}
    </div>
  );
}