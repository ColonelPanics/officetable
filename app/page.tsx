import { getLeaderboard, getGameStats, getGameRecords, getGames } from "@/lib/data";
import { getCurrentSeason, getSeason } from "@/lib/seasons";
import { getSeasonalTheme } from "@/lib/seasonalTheme";
import LeaderboardClient from "./LeaderboardClient";

// Shared scope links cold-load via query params: ?game=<id>&season=<id> or
// ?scope=alltime. The server renders the scoped data directly so no default
// scope flashes into view (spec L6.2).
interface UrlScope {
  dataOptions: { scope?: 'season' | 'alltime'; seasonId?: number };
  key: string;
}

function parseUrlScope(sp: Record<string, string | string[] | undefined>): UrlScope {
  const alltime = sp.scope === 'alltime';
  const seasonRaw = typeof sp.season === 'string' ? sp.season : undefined;
  const seasonId = seasonRaw && /^\d+$/.test(seasonRaw) ? Number(seasonRaw) : null;
  if (alltime) return { dataOptions: { scope: 'alltime' }, key: 'alltime' };
  if (seasonId !== null && getSeason(seasonId)) {
    return { dataOptions: { seasonId }, key: `season:${seasonId}` };
  }
  return { dataOptions: { scope: 'season' }, key: 'current' };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const scope = parseUrlScope(sp);

  // Fetch data for the URL game (or the first game) in the URL scope
  const games = getGames();
  const urlGameId = Number(typeof sp.game === 'string' ? sp.game : NaN);
  const initialGameId = games.some(g => g.id === urlGameId) ? urlGameId : games[0]?.id ?? 0;

  // Fetch initial data in the scoped context
  const [initialLeaderboard, initialStats, initialRecords] = await Promise.all([
    Promise.resolve(getLeaderboard(initialGameId, { includeRetired: false, ...scope.dataOptions })),
    Promise.resolve(getGameStats(initialGameId, scope.dataOptions)),
    Promise.resolve(getGameRecords(initialGameId, scope.dataOptions))
  ]);

  return (
    <LeaderboardClient
      initialGameId={initialGameId}
      initialScopeKey={`${initialGameId}:${scope.key}`}
      initialLeaderboard={initialLeaderboard}
      initialStats={initialStats}
      initialRecords={initialRecords}
      currentSeasonId={getCurrentSeason()?.id ?? 0}
      seasonalTheme={getSeasonalTheme()}
    />
  );
}