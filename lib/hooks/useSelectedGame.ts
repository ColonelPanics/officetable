import { useGames } from '../contexts/GameContext';

/**
 * Selected game + global season scope. Season scope is context-wide:
 * leaderboard, players, and matches all inherit it (see spec L2/L4).
 */
export function useSelectedGame() {
  const {
    selectedGameId, setSelectedGameId, games, selectedGame, isLoading,
    currentSeasonId, seasons, seasonView, setSeasonView,
  } = useGames();

  return {
    selectedGameId,
    setSelectedGameId,
    games,
    selectedGame,
    isLoading,
    currentSeasonId,
    seasons,
    seasonView,
    setSeasonView,
  };
}
