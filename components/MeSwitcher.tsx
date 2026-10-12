'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMe } from '@/lib/contexts/MeContext';

// Log in / playing-as widget for the gambling pages' header. Credentials are
// the player's linked Alces Bookie bank username + password; the identity is
// an httpOnly session cookie — there is no free "viewing as" anymore.

export function MeSwitcher() {
  const { me, isLoading, login, logout } = useMe();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return <span className="text-sm text-gray-500 px-3 py-1.5">Loading identity…</span>;
  }

  if (me) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-500">Playing as</span>
        <span className="text-sm font-semibold text-gray-900">{me.name}</span>
        <button
          onClick={() => { setPassword(''); void logout(); }}
          className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
        >
          Log out
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm font-semibold px-3 py-1.5 rounded-lg border border-gray-200 bg-card text-gray-800 hover:border-primary/50"
      >
        🔐 Log in
      </button>
    );
  }

  return (
    <div className="absolute right-4 top-11 z-30 w-64 rounded-lg border border-gray-200 bg-card p-3 shadow-lg">
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Log in with your bank credentials</div>
      <div className="space-y-2">
        <input
          value={username}
          onChange={e => { setUsername(e.target.value); setError(null); }}
          placeholder="bank username"
          className="w-full px-3 py-1.5 rounded-lg border border-gray-200 bg-background text-sm"
        />
        <input
          type="password"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && username && password && !busy) {
              void submit();
            }
          }}
          placeholder="bank password"
          className="w-full px-3 py-1.5 rounded-lg border border-gray-200 bg-background text-sm"
        />
        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={busy || !username || !password}
            className="flex-1 text-sm font-semibold bg-primary text-white rounded-lg px-3 py-1.5 hover:bg-primary-hover disabled:opacity-40"
          >
            Log in
          </button>
          <button
            onClick={() => { setOpen(false); setError(null); setPassword(''); }}
            className="text-sm text-gray-400 hover:text-gray-700 px-2"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="text-[11px] text-gray-400 mt-2 border-t border-gray-200 pt-2">
        Not registered yet? Create your bank account on the{' '}
        <Link href="/gambling/bank" className="font-semibold text-primary hover:underline">
          🏦 bank page
        </Link>{' '}— it logs you in too.
      </div>
    </div>
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await login(username, password);
      if (!result.ok) setError(result.error ?? 'Login failed');
      else { setOpen(false); setPassword(''); }
    } finally {
      setBusy(false);
    }
  }
}