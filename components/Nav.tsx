'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useGames } from '../lib/contexts/GameContext';
import { useTheme, type ColorMode } from '../lib/contexts/ThemeContext';
import { LiveChip } from './LiveChip';

function formatGameName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Top-level surfaces. Live chip and Record Match live in the actions zone,
// never among tabs.
const TABS: Array<[string, string]> = [
  ['/', '📊 Leaderboard'],
  ['/players', '👥 Players'],
  ['/gambling', '🎲 Casino'],
  ['/ladder-history', '🕰️ Time Machine'],
];

const SEASON_LABEL: Record<string, string> = { alltime: '🏆 All Time' };

export function Nav() {
  const { settings, colorMode, setColorMode } = useTheme();
  const {
    selectedGame, selectedGameId, games, setSelectedGameId, isLoading,
    seasons, currentSeasonId, seasonView, setSeasonView,
  } = useGames();
  const [showGameMenu, setShowGameMenu] = useState(false);
  const [showSeasonMenu, setShowSeasonMenu] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  // Casino is not a game — exactly one of {game, casino} is highlighted at a time.
  const onCasino = pathname?.startsWith('/gambling') ?? false;

  useEffect(() => { setMounted(true); }, []);

  const closeMenus = () => { setShowGameMenu(false); setShowSeasonMenu(false); };

  const nextMode: Record<ColorMode, ColorMode> = { system: 'dark', dark: 'light', light: 'system' };
  const modeLabel: Record<ColorMode, string> =
    { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };
  const currentMode: ColorMode = mounted ? colorMode : 'system';

  // Season dropdown options: current season + all past seasons + All-time
  const seasonOptions = seasons.filter(s => currentSeasonId === null || s.id !== currentSeasonId);
  const currentSeason = seasons.find(s => s.id === currentSeasonId);
  const seasonLabel = !mounted || (currentSeasonId !== null && seasonView !== 'alltime' && typeof seasonView !== 'number')
    ? (currentSeason?.name ?? 'Season')
    : seasonView === 'alltime'
      ? SEASON_LABEL.alltime
      : typeof seasonView === 'number'
        ? seasons.find(s => s.id === seasonView)?.name ?? 'Season'
        : currentSeason?.name ?? 'Season';

  const pickSeason = (view: typeof seasonView) => {
    setShowSeasonMenu(false);
    setSeasonView(view);
  };

  const gameButton = (
    <button
      onClick={() => { setShowGameMenu(!showGameMenu); setShowSeasonMenu(false); }}
      className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-slate-800 to-slate-900 text-white rounded-lg hover:opacity-90 transition-opacity"
    >
      {selectedGame?.image_url ? (
        <img src={selectedGame.image_url} alt={selectedGame.name} className="w-5 h-5 rounded object-cover" />
      ) : (
        <span className="text-lg">🎮</span>
      )}
      <span className="text-sm font-semibold">
        {selectedGame ? formatGameName(selectedGame.name) : 'Select Game'}
      </span>
      <svg
        className={`w-4 h-4 transition-transform ${showGameMenu ? 'rotate-180' : ''}`}
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );

  const gameMenu = showGameMenu && (
    <div className="absolute top-full left-0 mt-2 w-48 bg-card rounded-lg shadow-xl border border-gray-200 py-1 z-20">
      {games.map((game) => (
        <button
          key={game.id}
          onClick={() => {
            setSelectedGameId(game.id);
            closeMenus();
            // The casino ignores scope — picking a game there returns to the
            // leaderboard, where the new game scope is visible.
            if (onCasino) router.push('/');
          }}
          className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-100 transition-colors ${
            game.id === selectedGameId ? 'bg-gray-50' : ''
          }`}
        >
          {game.image_url ? (
            <img src={game.image_url} alt={game.name} className="w-5 h-5 rounded object-cover" />
          ) : (
            <span className="w-5 h-5 flex items-center justify-center">🎮</span>
          )}
          <span className={`text-sm ${game.id === selectedGameId ? 'font-semibold text-primary' : 'text-gray-700'}`}>
            {formatGameName(game.name)}
          </span>
          {game.id === selectedGameId && <span className="ml-auto text-primary">✓</span>}
        </button>
      ))}
    </div>
  );

  const seasonMenu = showSeasonMenu && (
    <div className="absolute top-full left-0 mt-2 w-52 bg-card rounded-lg shadow-xl border border-gray-200 py-1 z-20">
      {currentSeason && (
        <button
          onClick={() => pickSeason('current')}
          className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-100 transition-colors ${
            seasonView !== 'alltime' && typeof seasonView !== 'number' ? 'bg-gray-50' : ''
          }`}
        >
          <span className="w-5 h-5 flex items-center justify-center">🗓️</span>
          <span className={`text-sm ${seasonView !== 'alltime' && typeof seasonView !== 'number' ? 'font-semibold text-primary' : 'text-gray-700'}`}>
            {currentSeason.name}
          </span>
          <span className="ml-auto text-xs text-gray-400">current</span>
        </button>
      )}
      {seasonOptions.map(s => (
        <button
          key={s.id}
          onClick={() => pickSeason(s.id)}
          className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-100 transition-colors ${
            seasonView === s.id ? 'bg-gray-50' : ''
          }`}
        >
          <span className="w-5 h-5 flex items-center justify-center">🗓️</span>
          <span className={`text-sm ${seasonView === s.id ? 'font-semibold text-primary' : 'text-gray-700'}`}>
            {s.name}
          </span>
        </button>
      ))}
      <div className="border-t border-gray-200 my-1" />
      <button
        onClick={() => pickSeason('alltime')}
        className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-100 transition-colors ${
          seasonView === 'alltime' ? 'bg-gray-50' : ''
        }`}
      >
        <span className="w-5 h-5 flex items-center justify-center">🏆</span>
        <span className={`text-sm ${seasonView === 'alltime' ? 'font-semibold text-primary' : 'text-gray-700'}`}>
          🏆 All Time
        </span>
        {seasonView === 'alltime' && <span className="ml-auto text-primary">✓</span>}
      </button>
    </div>
  );

  return (
    <nav className="bg-card/80 backdrop-blur-md border-b border-gray-200/50 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-center justify-between gap-2">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-3 group shrink-0">
            {settings.logo_url ? (
              <img
                src={settings.logo_url}
                alt={settings.company_name || 'Logo'}
                className="h-9 w-9 object-contain rounded-lg shadow-sm group-hover:shadow-md transition-shadow"
              />
            ) : (
              <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center text-white font-bold text-lg shadow-sm group-hover:shadow-md transition-shadow">
                {settings.company_name?.charAt(0) || 'O'}
              </div>
            )}
            <span className="hidden lg:inline-block text-xl font-bold text-gray-900 group-hover:text-primary transition-colors">
              {settings.company_name || 'Office Games'}
            </span>
          </Link>

          {/* Tabs — exactly four top-level surfaces */}
          <div className="hidden md:flex items-center gap-1">
            {TABS.map(([href, label]) => {
              const active = href === '/gambling'
                ? onCasino
                : href === '/'
                  ? pathname === '/'
                  : pathname?.startsWith(href) ?? false;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    active
                      ? 'text-primary bg-gray-100'
                      : 'text-gray-600 hover:text-primary hover:bg-gray-100'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>

          {/* Context bar + actions — game and season scope survive on mobile */}
          <div className="flex items-center gap-1.5 sm:gap-2 pl-2 border-l border-gray-200">
            <div className="relative">
              {isLoading ? (
                <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg">
                  <div className="w-5 h-5 bg-gray-300 rounded animate-pulse" />
                  <span className="text-sm text-gray-500 hidden sm:inline">Loading...</span>
                </div>
              ) : gameButton}
              {gameMenu}
            </div>

            <div className="relative">
              <button
                onClick={() => { setShowSeasonMenu(!showSeasonMenu); setShowGameMenu(false); }}
                className="flex items-center gap-1.5 px-2 sm:px-3 py-2 bg-gray-100 text-gray-800 rounded-lg hover:bg-gray-200 transition-colors"
                title="Scope: season (current / past / all-time)"
              >
                <span className="hidden sm:inline">🗓️</span>
                <span className="text-sm font-medium max-w-36 truncate">
                  {seasonLabel}
                </span>
                <svg
                  className={`w-4 h-4 transition-transform ${showSeasonMenu ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {seasonMenu}
            </div>

            {/* Click-away for either dropdown */}
            {(showGameMenu || showSeasonMenu) && (
              <div className="fixed inset-0 z-10" onClick={closeMenus} aria-hidden />
            )}

            <LiveChip />

            <Link
              href={selectedGameId !== null ? `/matches/new?game=${selectedGameId}` : '/matches/new'}
              className="hidden sm:inline-flex px-4 py-2 text-sm font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover transition-all shadow-sm hover:shadow-md"
            >
              + Record Match
            </Link>

            {/* Mobile: theme + burger — links unreachable otherwise */}
            <div className="flex items-center sm:hidden">
              <button
                onClick={() => setColorMode(nextMode[currentMode])}
                className="p-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label={`Switch to ${nextMode[currentMode].replace(' theme', '')}`}
              >
                {!mounted ? (
                  <span className="block w-5 h-5" aria-hidden>🌗</span>
                ) : currentMode === 'dark' ? (
                  <span className="block w-5 h-5" aria-hidden>🌙</span>
                ) : currentMode === 'light' ? (
                  <span className="block w-5 h-5" aria-hidden>☀️</span>
                ) : (
                  <span className="block w-5 h-5" aria-hidden>🌗</span>
                )}
              </button>
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="p-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileOpen}
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {mobileOpen
                    ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />}
                </svg>
              </button>
            </div>
          </div>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t border-gray-200/50 mt-3 pt-2 flex flex-col">
            {TABS.map(([href, label]) => {
              const active = href === '/gambling'
                ? onCasino
                : href === '/'
                  ? pathname === '/'
                  : pathname?.startsWith(href) ?? false;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileOpen(false)}
                  className={`px-2 py-3 text-base font-medium rounded-lg ${
                    active ? 'text-primary bg-gray-100' : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            <Link
              href="/matches/new"
              onClick={() => setMobileOpen(false)}
              className="mt-2 py-3 text-center text-base font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover transition-all shadow-sm"
            >
              + Record Match
            </Link>
          </div>
        )}
      </div>
    </nav>
  );
}
