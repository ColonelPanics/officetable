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
import type { Challenge, GambleMatch, SettleSummary } from './types';

const baseUrl = () => process.env.NEXT_PUBLIC_BASE_URL;

const RED = '#D13011';
const BLUE = '#1147D1';
const WIN = '#16a34a';
const MUTED = '#9aa0a6';

const moose = (n: number) => `${n.toLocaleString()} moose bucks`;

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
    paragraphs: [line],
    widgets: [faceOffWidget(redFinal, blueRow)],
    linkUrl: gameMatchUrl(challenge.id, 'challenges'),
    linkText: challenge.broadcast ? 'Accept it' : 'Respond',
  };
  await sendAnnouncementNotification(message);
}

/** Bets open on an accepted challenge. */
export async function announceBetsOpen(gambleMatch: GambleMatch): Promise<void> {
  const avatars = avatarMapFor([gambleMatch.red_player_id, gambleMatch.blue_player_id]);
  const message: AnnouncementMessage = {
    title: '🎲 Bets are open',
    subtitle: gambleMatch.game_name,
    paragraphs: [`${moose(gambleMatch.entry_fee)} each on the line — close your picks before it starts.`],
    widgets: [
      faceOffWidget(
        { name: gambleMatch.red_player_name ?? 'Player', avatarUrl: avatars.get(gambleMatch.red_player_id), badgeColor: RED },
        { name: gambleMatch.blue_player_name ?? 'Player', avatarUrl: avatars.get(gambleMatch.blue_player_id), badgeColor: BLUE },
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
  const avatars = avatarMapFor([gambleMatch.red_player_id, gambleMatch.blue_player_id]);
  const message: AnnouncementMessage = {
    title: '⏰ Betting closed — to the table!',
    subtitle: gambleMatch.game_name,
    paragraphs: [],
    widgets: [
      faceOffWidget(
        { name: gambleMatch.red_player_name ?? 'Player', avatarUrl: avatars.get(gambleMatch.red_player_id), badgeColor: RED },
        { name: gambleMatch.blue_player_name ?? 'Player', avatarUrl: avatars.get(gambleMatch.blue_player_id), badgeColor: BLUE },
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'View the match',
  };
  await sendAnnouncementNotification(message);
}

/** Settled — just the result and who got paid; details on the match page. */
export async function announceSettled(gambleMatch: GambleMatch, summary: SettleSummary): Promise<void> {
  const avatars = avatarMapFor([gambleMatch.red_player_id ?? -1, gambleMatch.blue_player_id ?? -1]);
  const winners = summary.betPayments.filter(b => b.status === 'won');
  const red = gambleMatch.red_player_name ?? 'Player';
  const blue = gambleMatch.blue_player_name ?? 'Player';
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
        { name: red, avatarUrl: avatars.get(gambleMatch.red_player_id ?? -1), badge: `${summary.finalScore.red}`, badgeColor: draw ? MUTED : redWon ? WIN : MUTED, muted: !draw && !redWon },
        { name: blue, avatarUrl: avatars.get(gambleMatch.blue_player_id ?? -1), badge: `${summary.finalScore.blue}`, badgeColor: draw ? MUTED : redWon ? MUTED : WIN, muted: !draw && redWon },
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'Full settlement',
  };
  await sendAnnouncementNotification(message);
}

/** Cancelled / voided with refunds. */
export async function announceCancelled(gambleMatch: GambleMatch, refundTotal: number): Promise<void> {
  const avatars = avatarMapFor([gambleMatch.red_player_id ?? -1, gambleMatch.blue_player_id ?? -1]);
  const message: AnnouncementMessage = {
    title: '♻️ Gamble cancelled',
    subtitle: gambleMatch.game_name,
    paragraphs: [`${moose(refundTotal)} back to the players.`],
    widgets: [
      faceOffWidget(
        { name: gambleMatch.red_player_name ?? 'Player', avatarUrl: avatars.get(gambleMatch.red_player_id ?? -1), badgeColor: RED, muted: true },
        { name: gambleMatch.blue_player_name ?? 'Player', avatarUrl: avatars.get(gambleMatch.blue_player_id ?? -1), badgeColor: BLUE, muted: true },
      ),
    ],
    linkUrl: gameMatchUrl(gambleMatch.id, 'matches'),
    linkText: 'View match',
  };
  await sendAnnouncementNotification(message);
}