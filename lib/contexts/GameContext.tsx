'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Game } from '../types';

export type SeasonView = 'current' | 'alltime' | number;

interface SeasonInfo {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  is_current?: boolean;
}

interface GameContextType {
  selectedGameId: number | null;
  setSelectedGameId: (id: number) => void;
  games: Game[];
  selectedGame: Game | null;
  isLoading: boolean;
  currentSeasonId: number | null;
  seasons: SeasonInfo[];
  seasonView: SeasonView;
  setSeasonView: (view: SeasonView) => void;
}

const GameContext = createContext<GameContextType | null>(null);

const STORAGE_KEY = 'selectedGameId';

/**
 * Pages that render data in the global season scope. Unscoped surfaces
 * (casino, live scorer, record form, players directory, settings, time
 * machine) carry only the game stamp — season scope is meaningless there
 * (spec L2 region boundary: context bar present but inert).
 */
function isScopedSeasonPath(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname === '/matches') return true;
  if (pathname.startsWith('/players/')) return true;
  return false;
}

interface GameProviderProps {
  children: ReactNode;
  initialGameId?: number | null;
}

/**
 * Write the global season scope onto a URLSearchParams object.
 * Page URLs use `?season=<id>` / `?scope=alltime`; API calls keep their own
 * `season_id` / `scope` names (API params are built by the callers).
 */
export function applySeasonParams(params: URLSearchParams, seasonView: SeasonView) {
  params.delete('scope');
  params.delete('season');
  if (seasonView === 'alltime') {
    params.set('scope', 'alltime');
  } else if (typeof seasonView === 'number') {
    params.set('season', String(seasonView));
  }
}

/** Parse a SeasonView value out of a search string (cold-load scope support). */
export function parseSeasonView(search: string): SeasonView {
  const s = new URLSearchParams(search);
  if (s.get('scope') === 'alltime') return 'alltime';
  const season = s.get('season');
  if (season && /^\d+$/.test(season)) return parseInt(season, 10);
  return 'current';
}

export function GameProvider({ children, initialGameId }: GameProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGameId, setSelectedGameIdState] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentSeasonId, setCurrentSeasonId] = useState<number | null>(null);
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [seasonView, setSeasonViewState] = useState<SeasonView>('current');

  // Fetch games + seasons on mount, adopting URL scope (game/season/scope)
  // so a shared link cold-loads in the shared scope. Priority: URL > stored > first game.
  useEffect(() => {
    async function fetchGames() {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlSeason = parseSeasonView(window.location.search);
        const [gamesRes, seasonsRes] = await Promise.all([
          fetch('/api/games'),
          fetch('/api/seasons').then(res => res.json()).catch(() => null),
        ]);
        const gameList: Game[] = gamesRes.ok ? await gamesRes.json() : [];
        setGames(gameList);
        if (seasonsRes) {
          setSeasons(seasonsRes.seasons || []);
          setCurrentSeasonId(seasonsRes.current_season_id ?? null);
        }

        const storedId = typeof window !== 'undefined'
          ? localStorage.getItem(STORAGE_KEY)
          : null;

        let gameId: number | null = null;

        const urlGameId = params.get('game');
        const valid = (gameId: number | null, gameList: Game[]) => gameId !== null && gameList.some((g: Game) => g.id === gameId);

        if (valid(Number(urlGameId) || null, gameList)) {
          gameId = Number(urlGameId);
        } else if (initialGameId && gameList.some((g: Game) => g.id === initialGameId)) {
          gameId = initialGameId;
        } else if (storedId) {
          const parsedId = parseInt(storedId, 10);
          if (gameList.some((g: Game) => g.id === parsedId)) gameId = parsedId;
        }

        if (!gameId && gameList.length > 0) {
          gameId = gameList[0].id;
        }

        setSelectedGameIdState(gameId);
        setSeasonViewState(urlSeason);
      } catch (error) {
        console.error('Failed to fetch games:', error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchGames();
  }, [initialGameId]);

  // Rewrite the current URL (router.replace — no history spam) with fresh
  // scope params, preserving page-specific params (filters, pagination).
  // Season params are stamped only on season-scoped pages.
  const syncUrl = useCallback((gameId: number | null, view: SeasonView) => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (gameId !== null) params.set('game', String(gameId));
    else params.delete('game');
    if (isScopedSeasonPath(url.pathname)) {
      applySeasonParams(params, view);
    } else {
      params.delete('scope');
      params.delete('season');
    }
    router.replace(url.pathname + url.search);
  }, [router]);

  const setSelectedGameId = useCallback((id: number) => {
    // Same game: leave URL alone — pages that read ?game= to pre-select call
    // this on every searchParams update, and a no-op router.replace here
    // recreates searchParams and loops those effects forever in dev.
    if (id === selectedGameId) return;
    setSelectedGameIdState(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(id));
      syncUrl(id, seasonView);
    }
  }, [selectedGameId, seasonView, syncUrl]);

  const setSeasonView = useCallback((view: SeasonView) => {
    if (view === seasonView) return; // no-op: URL stamp effect owns the URL
    setSeasonViewState(view);
    if (typeof window !== 'undefined' && selectedGameId !== null) {
      syncUrl(selectedGameId, view);
    }
  }, [selectedGameId, syncUrl]);

  // Keep the scope stamped on the URL after in-app navigation so every page
  // URL stays shareable in the global scheme (spec L4). Idempotent: only
  // rewrites when the stamped params drift from the context state.
  useEffect(() => {
    if (isLoading || selectedGameId === null) return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const scoped = isScopedSeasonPath(url.pathname);
    const gameOk = params.get('game') === String(selectedGameId);
    const seasonOk = !scoped
      ? !params.has('scope') && !params.has('season')
      : seasonView === 'alltime'
        ? params.get('scope') === 'alltime'
        : typeof seasonView === 'number'
          ? params.get('season') === String(seasonView)
          : !params.has('scope') && !params.has('season');
    if (gameOk && seasonOk && !params.has('season_id')) return;
    syncUrl(selectedGameId, seasonView);
  }, [pathname, selectedGameId, seasonView, isLoading, syncUrl]);

  const selectedGame = games.find(g => g.id === selectedGameId) || null;

  return (
    <GameContext.Provider value={{
      selectedGameId,
      setSelectedGameId,
      games,
      selectedGame,
      isLoading,
      currentSeasonId,
      seasons,
      seasonView,
      setSeasonView,
    }}>
      {children}
    </GameContext.Provider>
  );
}

export function useGames() {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGames must be used within a GameProvider');
  }
  return context;
}
