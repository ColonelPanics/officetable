'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import type { Player } from '../types';

// Gambling identity IS the server session: an httpOnly cookie set by
// /api/gambling/auth, logged in with the player's linked bank username +
// password. Anonymous visitors view the casino read-only; all money rules
// are enforced server-side (routes require the session to match the actor).

interface MeContextType {
  me: Player | null;
  players: Player[];
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeContextType | null>(null);

export function MeProvider({ children }: { children: ReactNode }) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [me, setMeState] = useState<Player | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      // Players always; the identity is the server session's answer.
      const [playersRes, authRes] = await Promise.all([
        fetch('/api/players'),
        fetch('/api/gambling/auth'),
      ]);
      const list: Player[] = playersRes.ok ? ((await playersRes.json()) as Player[]) : [];
      setPlayers(list);
      if (authRes.ok) {
        const body = (await authRes.json()) as { player: { id: number; name: string } | null };
        setMeState(body.player ? (list.find(p => p.id === body.player!.id) ?? (body.player as unknown as Player)) : null);
      }
    } catch (error) {
      console.error('Failed to load session identity:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Clear the legacy free-picker key: identity is the session now, full stop.
  useEffect(() => {
    try { localStorage.removeItem('gamblingPlayerId'); } catch { /* private mode */ }
  }, []);

  useEffect(() => { void refresh(); }, []); // initial load

  const login = useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch('/api/gambling/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) return { ok: false, error: body.error ?? 'Login failed' };
      await refresh();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Login failed — try again' };
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await fetch('/api/gambling/auth', { method: 'DELETE' }); } finally {
      setMeState(null);
    }
  }, []);

  return (
    <MeContext.Provider value={{ me, players, isLoading, login, logout, refresh }}>
      {children}
    </MeContext.Provider>
  );
}

export function useMe() {
  const context = useContext(MeContext);
  if (!context) throw new Error('useMe must be used within a MeProvider');
  return context;
}