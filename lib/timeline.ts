// ------------------------------------------------------------
// Live match timeline
//
// A match recorded "live" stores the ordered sequence of points as they
// were scored, each stamped with its offset from the match start. The
// timeline travels with the match as JSON in `matches.points_timeline`
// and unlocks:
//   - point scoring order + match duration (summary/report views)
//   - game-state achievements (wire_to_wire, comeback_kid, marathon)
//   - live punditry (comebacks, lead changes, never trailed)
//
// This module is the single source of truth for the shape + validation +
// derived state. It imports NOTHING (no db, no server-only) so the client
// can parse a match's timeline string with the exact same code the server
// uses to validate and analyse it.

/**
 * One scored point. `team` indexes the match's teams array (0 = team 1);
 * `at` is the offset in MILLISECONDS from `start`.
 */
export interface PointTimelineEvent {
  team: number;
  at: number;
}

/** Shape stored (as JSON text) in matches.points_timeline. */
export interface PointTimeline {
  /** ISO timestamp when tracking started. */
  start: string;
  /** ISO timestamp tracking finished (usually the final point / match end). */
  end?: string | null;
  events: PointTimelineEvent[];
}

/** Per-team live-state summary derived from a timeline. */
export interface TimelineTeamStats {
  team: number;
  score: number;
  /** Scored the first point of the match. */
  firstPoint: boolean;
  /** Was strictly behind the opponent's running score after some event. */
  everTrailed: boolean;
  /** Biggest deficit faced while trailing (0 when never trailed). */
  maxDeficit: number;
}

/** Derived facts for a whole timeline. */
export interface TimelineStats {
  /** Duration in ms: end − start (or last point's offset when end missing). */
  durationMs: number | null;
  pointCount: number;
  scores: Map<number, number>;
  teams: TimelineTeamStats[];
  /** Scoring team of the first point (null when no points). */
  firstScorer: number | null;
  /** How many times the outright lead changed hands (ties ignored). */
  leadChanges: number;
  /** True when the eventual top team(s) never trailed after going behind
   *  following the FIRST point — i.e. they scored first and were never
   *  behind. For "wire to wire". Non-draws only. */
  wireToWireWinners: number[];
}

const MAX_EVENTS = 1000;
/** 24h — a sane upper bound on point offsets / durations. */
const MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Validate + normalise a raw (untrusted JSON) timeline for a match being
 * created with `teams` (CreateMatchInput['teams']) and that team layout's
 * FINAL scores. The timeline's team indexes are positions in the same
 * `teams` array the match is recorded with. Returns an error message on
 * invalid input, null on success.
 */
export function validatePointTimeline(
  raw: unknown,
  teams: { team: number; player_ids: number[]; score: number }[],
  teamScores: number[]
): { error?: string; timeline?: PointTimeline } {
  if (raw === null || raw === undefined) return { timeline: { start: '', events: [] } };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'timeline must be an object' };
  }
  const t = raw as Partial<PointTimeline>;

  const start = typeof t.start === 'string' ? t.start : '';
  if (isNaN(new Date(start).getTime())) {
    return { error: 'timeline.start must be a valid ISO timestamp' };
  }
  const startMs = new Date(start).getTime();

  let endMs: number | null = null;
  if (t.end !== null && t.end !== undefined) {
    if (typeof t.end !== 'string' || isNaN(new Date(t.end).getTime())) {
      return { error: 'timeline.end must be a valid ISO timestamp' };
    }
    endMs = new Date(t.end).getTime();
    if (endMs < startMs) return { error: 'timeline.end must be after timeline.start' };
    if (endMs - startMs > MAX_MS) return { error: 'timeline.end is more than 24h after timeline.start' };
  }

  if (!Array.isArray(t.events)) return { error: 'timeline.events must be an array' };
  if (t.events.length > MAX_EVENTS) {
    return { error: `timeline.events must have at most ${MAX_EVENTS} entries` };
  }

  const teamCount = teams.length;
  const pointsPerTeam = new Array(teamCount).fill(0);
  let lastAt = -1;
  for (const ev of t.events as unknown[]) {
    if (typeof ev !== 'object' || ev === null) {
      return { error: 'each timeline event must be an object' };
    }
    const { team, at } = ev as { team?: unknown; at?: unknown };
    if (!Number.isInteger(team) || (team as number) < 0 || (team as number) >= teamCount) {
      return { error: 'timeline event team must index the recorded teams array' };
    }
    if (typeof at !== 'number' || !isFinite(at) || at < 0) {
      return { error: 'timeline event at must be a non-negative number (ms offset)' };
    }
    if (at > MAX_MS) return { error: 'timeline event at is more than 24h after the start' };
    if (at < lastAt) return { error: 'timeline events must be in ascending time order' };
    lastAt = at;
    pointsPerTeam[team as number]++;
  }

  // The live-recorded final score must equal the counted points: correcting
  // scores post-game is the edit-match flow's job, and a timeline that
  // disagrees with the stored score would break every timeline view.
  for (let i = 0; i < teamCount; i++) {
    if (pointsPerTeam[i] !== (teamScores[i] ?? 0)) {
      return {
        error: `timeline records ${pointsPerTeam[i]} points for teams[${i}] but its score is ${teamScores[i] ?? 0}`
      };
    }
  }

  return {
    timeline: {
      start,
      end: t.end ?? null,
      events: (t.events as PointTimelineEvent[]).map(ev => ({ team: ev.team as number, at: ev.at as number })),
    },
  };
}

/** Parse a stored points_timeline JSON string. Null on missing/invalid data. */
export function parsePointTimeline(raw: string | null | undefined): PointTimeline | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<PointTimeline>;
    if (typeof t.start !== 'string' || !Array.isArray(t.events)) return null;
    const events: PointTimelineEvent[] = [];
    for (const ev of t.events) {
      if (typeof ev !== 'object' || ev === null) return null;
      const team = (ev as Partial<PointTimelineEvent>).team;
      const at = (ev as Partial<PointTimelineEvent>).at;
      if (typeof team !== 'number' || !Number.isInteger(team) || typeof at !== 'number' || !isFinite(at) || at < 0) return null;
      events.push({ team, at });
    }
    return { start: t.start, end: t.end ?? null, events };
  } catch {
    return null;
  }
}

/**
 * Derive the game-state facts from a timeline. Uses each team's FINAL score
 * (the authoritative stored score) to classify winners; the timeline only
 * supplies the ORDER/TIMING of points.
 */
export function computeTimelineStats(timeline: PointTimeline, teamScores: number[]): TimelineStats {
  const teams: TimelineTeamStats[] = teamScores.map((score, team) => ({
    team,
    score,
    firstPoint: false,
    everTrailed: false,
    maxDeficit: 0,
  }));

  const running: number[] = new Array(teamScores.length).fill(0);
  let firstScorer: number | null = null;
  let leadChanges = 0;

  const leader = (scores: number[]): number | null => {
    const max = Math.max(...scores);
    if (max === 0) return null; // nothing scored yet
    const leaders = scores.filter(s => s === max);
    return leaders.length === 1 ? scores.indexOf(max) : null;
  };

  let prevLeader: number | null = null;
  for (const ev of timeline.events) {
    if (running[ev.team] === undefined) continue;
    running[ev.team]++;
    if (firstScorer === null) {
      firstScorer = ev.team;
      if (teams[ev.team]) teams[ev.team].firstPoint = true;
    }
    const current = leader(running);
    if (current !== null && prevLeader !== null && current !== prevLeader) {
      leadChanges++;
    }
    if (current !== null) prevLeader = current;

    for (let i = 0; i < running.length; i++) {
      const others = running.filter((_, j) => j !== i);
      const bestOpponent = others.length > 0 ? Math.max(...others) : 0;
      if (running[i] < bestOpponent) {
        teams[i].everTrailed = true;
        const deficit = bestOpponent - running[i];
        if (deficit > teams[i].maxDeficit) teams[i].maxDeficit = deficit;
      }
    }
  }

  // Wire to wire: a non-draw winner who scored the first point and never
  // trailed (ties are allowed — being level isn't being behind).
  const topScore = Math.max(...teamScores);
  const isDraw = teamScores.filter(s => s === topScore).length > 1;
  const wireToWireWinners = isDraw
    ? []
    : teamScores
        .map((score, team) => (score === topScore && teams[team]?.firstPoint && !teams[team]?.everTrailed ? team : -1))
        .filter(t => t >= 0);

  const lastEventAt = (timeline.events[timeline.events.length - 1]?.at) ?? 0;
  const startMs = new Date(timeline.start).getTime();
  const durationMs = timeline.end
    ? new Date(timeline.end).getTime() - startMs
    : (lastEventAt > 0 && timeline.events.length > 0 ? lastEventAt : null);

  return {
    durationMs,
    pointCount: timeline.events.length,
    scores: new Map<number, number>(teamScores.map((score, team) => [team, score])),
    teams,
    firstScorer,
    leadChanges,
    wireToWireWinners,
  };
}

/** Format milliseconds as a compact duration (e.g. "12m 34s", "1m 02s"). */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Format a ms offset as an mm:ss clock time (for point times in reports). */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}