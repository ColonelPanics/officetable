// Chat-card announcements for the gambling flow. These are BRIEF call-to-
// actions: a face-off (profile avatars, accent-coloured names), at most one
// line of context, and a link — the webapp is where the details live. Route
// handlers call these with .catch(console.error) — a webhook failure must
// never fail a settled transaction. Avatars come straight from
// players.avatar_url: the same external URLs the match cards embed.

import db from './db';
import {
  sendAnnouncementNotification,
  faceOffWidget,
  type AnnouncementMessage,
} from './notifications';
import type { Challenge, ChallengeSlot, GambleMatch, SettleSummary } from './types';

const baseUrl = () => process.env.NEXT_PUBLIC_BASE_URL;

const RED = '#D13011';
const BLUE = '#1147D1';
const WIN = '#16a34a';
const MUTED = '#9aa0a6';

const moose = (n: number) => `${n.toLocaleString()} moose bucks`;

/**
 * One-line house-rules note for the chat card. Long rules get truncated — the
 * full text is always on the match/challenge page, where the link points.
 */
function specialRulesLine(specialRules: string | null | undefined): string | null {
  const text = specialRules?.trim();
  if (!text) return null;
  const MAX = 160;
  const shown = text.length > MAX ? `${text.slice(0, MAX - 1).trimEnd()}…` : text;
  return `📜 <i>${shown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</i>${text.length > MAX ? ' — <b>full rules on the page</b>' : ''}`;
}

/** avatar_url per player id for card icons (missing = person placeholder). */
export function avatarMapFor(playerIds: number[]): Map<number, string> {
  if (!playerIds.length) return new Map();
  const placeholders = playerIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, avatar_url FROM players WHERE id IN (${placeholders})
  `).all(...playerIds) as { id: number; avatar_url: string | null }[];
  const map = new Map<number, string>();
  for (const r of rows) if (r.avatar_url) map.set(r.id, r.avatar_url);
  return map;
}

/** Card-side shape (compatible with the shared FaceOffPlayer icon builder). */
interface CardSide {
  name: string;
  avatarUrl?: string | null;
  badge?: string;
  badgeColor?: string;
  muted?: boolean;
}

function ctaWidget(matchUrl: string | undefined, label: string): Record<string, unknown> | null {
  if (!matchUrl) return null;
  return { textParagraph: { text: `<a href="${matchUrl}">${label}</a>` } };
}

function gameMatchUrl(id: number | null | undefined, path: string): string | undefined {
  return id != null && baseUrl() ? `${baseUrl()}/gambling/${path}/${id}` : undefined;
}

/** Side line for a card: full roster names joined ('Stuts & Joe'), falling
 *  back to the legacy first-seat name when no roster is attached (legacy rows). */
function sideCard(gm: GambleMatch, team: 0 | 1, fallbackId: number, fallbackName: string, extra: Partial<CardSide> = {}): CardSide {
  const roster = (gm.participants ?? []).filter(p => p.team === team);
  const names = roster.map(p => p.player_name ?? `Player ${p.player_id}`);
  const name = names.length > 1 ? names.join(' & ') : (names[0] ?? fallbackName);
  const avatarUrl = roster.length ? avatarMapFor(roster.map(p => p.player_id)).get(roster[0].player_id) : undefined;
  if (!names.length && fallbackId != null) {
    const avatars = avatarMapFor([fallbackId]);
    return { name: fallbackName, avatarUrl: avatars.get(fallbackId), badgeColor: extra.badgeColor, ...extra };
  }
  return { name, avatarUrl, ...extra };
}

/** Challenge issued — the opponent (or the whole office, if broadcast) gets a respond prompt. */
export async function announceChallengeIssued(challenge: Challenge): Promise<void> {
  const avatars = avatarMapFor([challenge.challenger_id, challenge.opponent_id]
    .filter((x): x is number => x != null));
  const nameOf = (id: number): string =>
    id === challenge.challenger_id
      ? (challenge.challenger_name ?? `Player ${id}`)
      : (challenge.opponent_name ?? `Player ${id}`);
  // CardSide rows: whoever took red/blue (ids) gets coloured; the open broadcast
  // slot is grey with a "first to accept" label.
  const rowFor = (id: number | null, take: CardSide): CardSide =>
    id == null ? { ...take, name: challenge.broadcast ? 'First to accept' : take.name, muted: true } as CardSide
      : { name: nameOf(id), avatarUrl: avatars.get(id), badgeColor: take.badgeColor, muted: false } as CardSide;
  const challengerIsRed = challenge.challenger_side === 'red';
  const openName = challenge.broadcast
    ? 'First to accept takes blue'
    : 'First to accept';
  const redRow = rowFor(challenge.red_player_id, { name: openName, badgeColor: RED });
  const blueRow: CardSide = challengerIsRed
    ? rowFor(challenge.broadcast ? null : challenge.opponent_id, { name: openName, badgeColor: BLUE })
    : { name: nameOf(challenge.challenger_id), avatarUrl: avatars.get(challenge.challenger_id), badgeColor: BLUE };
  const redFinal: CardSide = challengerIsRed
    ? { name: nameOf(challenge.challenger_id), avatarUrl: avatars.get(challenge.challenger_id), badgeColor: RED }
    : redRow;
  const line = challenge.broadcast
    ? `<b>${nameOf(challenge.challenger_id)}</b> throws the gauntlet down — open entry ${moose(challenge.entry_fee)} each.`
    : `<b>${nameOf(challenge.challenger_id)}</b> challenges <b>${nameOf(challenge.opponent_id ?? challenge.challenger_id)}</b> — ${moose(challenge.entry_fee)} each.`;
  const message: AnnouncementMessage = {
    title: '⚔️ Challenge issued',
    subtitle: challenge.game_name ?? undefined,
    paragraphs: [specialRulesLine(challenge.special_rules), line].filter(
      (p): p is string => p != null,
    ),
    widgets: [faceOffWidget(redFinal, blueRow)],
    linkUrl: gameMatchUrl(challenge.id, 'challenges'),
    linkText: challenge.broadcast ? 'Accept it' : 'Respond',
  };
  await sendAnnouncementNotification(message);
}

/** Team challenge issued — broadcast seats highlighted, seat shape in the line. */
export async function announceTeamChallengeIssued(challenge: Challenge, slots: ChallengeSlot[]): Promise<void> {
  const ids = slots.map(s => s.player_id).filter((x): x is number => x != null);
  const avatars = avatarMapFor(ids);
  const seatLine = (side: 'red' | 'blue', badgeColor: string): CardSide => {
    const mine = slots.filter(s => s.side === side);
    const names = mine.filter(s => s.player_id != null).map(s => s.player_name ?? `Player ${s.player_id}`);
    const open = mine.filter(s => s.player_id == null).length;
    const label = [
      names.join(' & '),
      open ? `${names.length ? ' & ' : ''}${open} open seat${open === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join('');
    const firstNamed = mine.find(s => s.player_id != null)?.player_id;
    return {
      name: label || 'Open seats',
      avatarUrl: firstNamed != null ? avatars.get(firstNamed) : undefined,
      badgeColor,
      muted: !names.length,
    };
  };
  const makerName = challenge.challenger_name ?? `Player ${challenge.challenger_id}`;
  const openCount = slots.filter(s => s.player_id == null).length;
  const shape = `${slots.filter(s => s.side === 'red').length}v${slots.filter(s => s.side === 'blue').length}`;
  const line = `<b>${makerName}</b> throws down a ${shape} — ${moose(challenge.entry_fee)} each, ` +
    (openCount ? `${openCount} seat${openCount === 1 ? '' : 's'} still to fill.` : 'waiting on the named seats to accept.');
  const message: AnnouncementMessage = {
    title: '⚔️ Team challenge issued',
    subtitle: challenge.game_name ?? undefined,
    paragraphs: [specialRulesLine(challenge.special_rules), line].filter(
      (p): p is string => p != null,
    ),
    widgets: [faceOffWidget(seatLine('red', RED), seatLine('blue', BLUE))],
    linkUrl: gameMatchUrl(challenge.id, 'challenges'),
    linkText: openCount ? 'Claim or accept' : 'View it',
  };
  await sendAnnouncementNotification(message);
}

/** Bets open on an accepted challenge (any team shapes). */
export async function announceBetsOpen(gambleMatch: GambleMatch): Promise<void> {
  const message: AnnouncementMessage = {
    title: '🎲 Bets are open',
    subtitle: gambleMatch.game_name,
    paragraphs: [
      specialRulesLine(gambleMatch.special_rules),
      `${moose(gambleMatch.entry_fee)} each on the line — close your picks before it starts.`,
    ].filter((p): p is string => p != null),
    widgets: [
      faceOffWidget(
        sideCard(gambleMatch, 0, gambleMatch.red_player_id, gambleMatch.red_player_name ?? 'Player', { badgeColor: RED }),
        sideCard(gambleMatch, 1, gambleMatch.blue_player_id, gambleMatch.blue_player_name ?? 'Player', { badgeColor: BLUE }),
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'Place a bet',
  };
  await sendAnnouncementNotification(message);
}

/** Bets closed — the window shut and the match is on: players to the table.
 *  Fired by syncStatuses exactly when rows flip open → awaiting_score. */
export async function announceBetsClosed(gambleMatch: GambleMatch): Promise<void> {
  const message: AnnouncementMessage = {
    title: '⏰ Betting closed — to the table!',
    subtitle: gambleMatch.game_name,
    paragraphs: [specialRulesLine(gambleMatch.special_rules)].filter(
      (p): p is string => p != null,
    ),
    widgets: [
      faceOffWidget(
        sideCard(gambleMatch, 0, gambleMatch.red_player_id, gambleMatch.red_player_name ?? 'Player', { badgeColor: RED }),
        sideCard(gambleMatch, 1, gambleMatch.blue_player_id, gambleMatch.blue_player_name ?? 'Player', { badgeColor: BLUE }),
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'View the match',
  };
  await sendAnnouncementNotification(message);
}

/** Settled — just the result and who got paid; details on the match page. */
export async function announceSettled(gambleMatch: GambleMatch, summary: SettleSummary): Promise<void> {
  const winners = summary.betPayments.filter(b => b.status === 'won');
  const sideNames = (team: 0 | 1, fallback: string) =>
    (gambleMatch.participants ?? []).filter(p => p.team === team).map(p => p.player_name ?? `Player ${p.player_id}`).join(' & ') || fallback;
  const red = sideNames(0, gambleMatch.red_player_name ?? 'Player');
  const blue = sideNames(1, gambleMatch.blue_player_name ?? 'Player');
  const draw = summary.finalScore.red === summary.finalScore.blue;
  const redWon = !draw && summary.finalScore.red > summary.finalScore.blue;
  const message: AnnouncementMessage = {
    title: draw ? `🤝 ${red} ${summary.finalScore.red}–${summary.finalScore.blue} ${blue} — draw!`
      : `🏆 ${red} ${summary.finalScore.red}–${summary.finalScore.blue} ${blue}`,
    subtitle: gambleMatch.game_name,
    paragraphs: [
      winners.length
        ? `${winners.length} winning ${winners.length === 1 ? 'bet' : 'bets'} paid ${moose(summary.returns)}`
        : 'No winning bets this time',
    ],
    widgets: [
      faceOffWidget(
        { ...sideCard(gambleMatch, 0, gambleMatch.red_player_id ?? -1, red, { badgeColor: draw ? MUTED : redWon ? WIN : MUTED }), badge: `${summary.finalScore.red}`, muted: !draw && !redWon },
        { ...sideCard(gambleMatch, 1, gambleMatch.blue_player_id ?? -1, blue, { badgeColor: draw ? MUTED : redWon ? MUTED : WIN }), badge: `${summary.finalScore.blue}`, muted: !draw && redWon },
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'Full settlement',
  };
  await sendAnnouncementNotification(message);
}

/** Cancelled / voided with refunds. */
export async function announceCancelled(gambleMatch: GambleMatch, refundTotal: number): Promise<void> {
  const message: AnnouncementMessage = {
    title: '♻️ Gamble cancelled',
    subtitle: gambleMatch.game_name,
    paragraphs: [`${moose(refundTotal)} back to the players.`],
    widgets: [
      faceOffWidget(
        sideCard(gambleMatch, 0, gambleMatch.red_player_id ?? -1, gambleMatch.red_player_name ?? 'Player', { badgeColor: RED, muted: true }),
        sideCard(gambleMatch, 1, gambleMatch.blue_player_id ?? -1, gambleMatch.blue_player_name ?? 'Player', { badgeColor: BLUE, muted: true }),
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'View match',
  };
  await sendAnnouncementNotification(message);
}
/** Final score corrected on a settled gamble — the recorded match was re-run
 *  through the Elo replay and every bet re-marked; the bookie trues the money
 *  up out-of-band. */
export async function announceCorrected(
  gambleMatch: GambleMatch,
  from: { red: number | null; blue: number | null },
  to: { red: number; blue: number },
): Promise<void> {
  const red = (gambleMatch.participants ?? []).filter(p => p.team === 0).map(p => p.player_name ?? `Player ${p.player_id}`).join(' & ')
    || (gambleMatch.red_player_name ?? 'Player');
  const blue = (gambleMatch.participants ?? []).filter(p => p.team === 1).map(p => p.player_name ?? `Player ${p.player_id}`).join(' & ')
    || (gambleMatch.blue_player_name ?? 'Player');
  const draw = to.red === to.blue;
  const redWon = !draw && to.red > to.blue;
  const knownFrom = from.red != null && from.blue != null
    ? `The final score was wrongly recorded as ${from.red}–${from.blue}; it is now ${to.red}–${to.blue}.`
    : `The recorded final score is now ${to.red}–${to.blue} (re-recorded from the match page).`;
  const message: AnnouncementMessage = {
    title: `♻️ Score corrected — ${red} ${to.red}–${to.blue} ${blue}`,
    subtitle: gambleMatch.game_name,
    paragraphs: [
      `${knownFrom} Bets have been re-marked accordingly — any pays/repays on that money go through the bookie.`,
    ],
    widgets: [
      faceOffWidget(
        { ...sideCard(gambleMatch, 0, gambleMatch.red_player_id ?? -1, red, { badgeColor: draw ? MUTED : redWon ? WIN : MUTED }), badge: `${to.red}`, muted: !draw && !redWon },
        { ...sideCard(gambleMatch, 1, gambleMatch.blue_player_id ?? -1, blue, { badgeColor: draw ? MUTED : redWon ? MUTED : WIN }), badge: `${to.blue}`, muted: !draw && redWon },
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'Corrected settlement',
  };
  await sendAnnouncementNotification(message);
}
