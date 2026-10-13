interface MatchNotification {
  gameName: string;
  imageUrl?: string | null;
  matchId: number;
  teams: {
    playerIds: number[];
    players: string[];
    score: number;
    result: 'win' | 'loss' | 'draw';
  }[];
  playerAvatars?: Map<number, string>;
  skillChanges: {
    playerName: string;
    change: number;
    rankChange?: number;
  }[];
  notes?: string | null;
  achievements?: {
    playerName: string;
    achievementName: string;
    achievementIcon?: string | null;
    /** Moose bucks paid from the table's pot for this achievement, when it paid. */
    payout?: number;
  }[];
  punditry?: {
    description: string;
  }[];
  timestamp: string;
}

const WIN_COLOR = '#16a34a';
const LOSS_COLOR = '#dc2626';
const DRAW_COLOR = '#e8eaed';
/** De-emphasised grey used for the losing team's score. */
const MUTED_COLOR = '#9aa0a6';

/** Team accent colours, cycled if a match ever has more than 2 teams. */
const TEAM_COLORS = ['#1147D1', '#D13011', '#8430ce', '#0b8043'];

/** Minimal HTML escaping for names embedded in Chat card markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


/** One row of a two-player face-off: avatar (or person placeholder), accent
 *  coloured name, optional badge (score, odds, payout). Used by match cards
 *  and the (much briefer) gambling cards so they share one visual language. */
export interface FaceOffPlayer {
  name: string;
  avatarUrl?: string | null;
  badge?: string;
  badgeColor?: string;
  /** Grey name+badge for the loser / the not-yet-known side. */
  muted?: boolean;
}

export function faceOffColumn(player: FaceOffPlayer): Record<string, unknown> {
  const name = escapeHtml(player.name);
  const nameColor = player.muted ? MUTED_COLOR : (player.badgeColor ?? MUTED_COLOR);
  const badge = player.badge
    ? ` <b><font color="${player.badgeColor ?? MUTED_COLOR}">${escapeHtml(player.badge)}</font></b>`
    : '';
  return {
    horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
    horizontalAlignment: 'START' as const,
    verticalAlignment: 'TOP' as const,
    widgets: [
      {
        decoratedText: {
          startIcon: {
            imageType: 'CIRCLE' as const,
            iconUrl: player.avatarUrl || PERSON_PLACEHOLDER_ICON_URL,
            altText: player.name,
          },
          text: `<b><font color="${nameColor}">${name}</font></b>${badge}`,
          wrapText: true,
        },
      },
    ],
  };
}

export function faceOffWidget(left: FaceOffPlayer, right: FaceOffPlayer): Record<string, unknown> {
  return { columns: { columnItems: [faceOffColumn(left), faceOffColumn(right)] } };
}

/**
 * Default "person" icon used as a placeholder for players without an avatar.
 * Kept circular so it crops identically to real avatars.
 */
const PERSON_PLACEHOLDER_ICON_URL = 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/person/default/48px.svg';

/**
 * Builds the face-off section: one column per team. The top of each column is
 * the team name + score (winner highlighted, loser de-emphasised), followed by
 * one row per player with their avatar (or a person placeholder), bold name
 * and coloured skill change. Handles any team size (1v1, 2v2, ...).
 */
export function buildFaceOffColumnsWidget(
  match: MatchNotification,
  skillChangeByName: Map<string, { change: number; rankChange?: number }>
): Record<string, unknown> {
  const maxScore = Math.max(...match.teams.map(t => t.score));
  const isDraw = match.teams.filter(t => t.score === maxScore).length > 1;

  const columnItems = match.teams.slice(0, 4).map((team, teamIndex) => {
    const teamColor = TEAM_COLORS[teamIndex % TEAM_COLORS.length];
    const teamName = escapeHtml(team.players.join(' & '));
    const isWinner = !isDraw && team.score === maxScore;

    // Score line: bold score; winner gets a trophy + green, loser is pushed
    // into the background with grey, draws are neutral with a handshake.
    const scoreColor = isDraw ? DRAW_COLOR : isWinner ? WIN_COLOR : MUTED_COLOR;
    const trophy = isWinner ? '\u{1F3C6} ' : isDraw ? '\u{1F91D} ' : '';
    const scoreWidget = {
      textParagraph: {
        text: `<b><font color='${teamColor}'>${teamName}</font></b> ${trophy}<b><font color='${scoreColor}'>${team.score}</font></b>`
      }
    };

    const playerWidgets = team.playerIds.map((id, index) => {
      const name = team.players[index];
      const skill = skillChangeByName.get(name);
      const sign = skill && skill.change >= 0 ? '+' : '';
      const rankPart = skill?.rankChange !== undefined && skill.rankChange !== 0
        ? ` (${skill.rankChange > 0 ? '+' : ''}${skill.rankChange} rank${Math.abs(skill.rankChange) !== 1 ? 's' : ''})`
        : '';
      const arrow = skill ? (skill.change >= 0 ? '\u25B2 ' : '\u25BC ') : '';
      const skillText = skill
        ? ` <font color='${skill.change >= 0 ? WIN_COLOR : LOSS_COLOR}'>${arrow}${sign}${skill.change.toFixed(3)}</font>${rankPart}`
        : '';

      const avatarUrl = match.playerAvatars?.get(id);

      return {
        decoratedText: {
          startIcon: avatarUrl
            ? {
                imageType: 'CIRCLE' as const,
                iconUrl: avatarUrl,
                altText: name,
              }
            : {
                imageType: 'CIRCLE' as const,
                iconUrl: PERSON_PLACEHOLDER_ICON_URL,
              },
          text: `<b>${escapeHtml(name)}</b>${skillText}`,
          wrapText: true
        }
      };
    });

    return {
      horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
      horizontalAlignment: 'START' as const,
      verticalAlignment: 'TOP' as const,
      widgets: [scoreWidget, ...playerWidgets]
    };
  });

  return { columns: { columnItems } };
}

export function buildChatCardsPayload(match: MatchNotification): Record<string, unknown> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  // Determine winner/draw status
  const maxScore = Math.max(...match.teams.map(t => t.score));
  const winners = match.teams.filter(t => t.score === maxScore);
  const isDraw = winners.length > 1;

  // Header shows the game/sport identity: game image if set, otherwise a default symbol
  const headerImageUrl = match.imageUrl || (isDraw
    ? 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/handshake/default/48px.svg'
    : 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/emoji_events/default/48px.svg');
  const headerImageType = match.imageUrl ? 'SQUARE' : 'CIRCLE';

  // Build line 2: match link
  const matchLink = baseUrl ? `${baseUrl}/matches/${match.matchId}` : null;

  // Skill change + rank change per player name, for the face-off rows
  const skillChangeByName = new Map(
    match.skillChanges.map(sc => [sc.playerName, { change: sc.change, rankChange: sc.rankChange }])
  );

  const hasExtraInfo = Boolean(match.notes?.trim())
    || Boolean(match.achievements && match.achievements.length > 0)
    || Boolean(match.punditry && match.punditry.length > 0);

  // Build widgets for the card
  const widgets = [];

  // Face-off columns — one column per team; score on top (winner
  // highlighted), then one row per player with their avatar (or person
  // placeholder), name and coloured skill change.
  widgets.push(buildFaceOffColumnsWidget(match, skillChangeByName));

  // Divider between the score/player face-off and the further info below.
  if (hasExtraInfo) {
    widgets.push({ divider: {} });
  }

  // Notes (if present)
  if (match.notes?.trim()) {
    widgets.push({
      textParagraph: {
        text: `<i>\u{1F4AC} ${match.notes.trim()}</i>`
      }
    });
  }

  // Achievements (if present)
  if (match.achievements && match.achievements.length > 0) {
    const achievementsText = match.achievements
      .map(a => {
        const icon = a.achievementIcon || '\u{1F3C5}';
        const name = a.achievementName.replace(/_/g, ' ');
        const payout = a.payout ? ` <i>(+${a.payout} moose bucks)</i>` : '';
        return `${icon} <b>${a.playerName}</b>: ${name}${payout}`;
      })
      .join('  \u00b7  ');
    widgets.push({
      textParagraph: {
        text: achievementsText
      }
    });
  }

  // Line 5: Punditry (if present)
  if (match.punditry && match.punditry.length > 0) {
    const punditryText = match.punditry
      .slice(0, 3) // Limit to 3 facts to keep the notification concise
      .map(p => `\u{1F399}\u{FE0F} ${p.description}`)
      .join('<br>');
    const suffix = match.punditry.length > 3 ? `<br><i>...and ${match.punditry.length - 3} more insights</i>` : '';
    widgets.push({
      textParagraph: {
        text: punditryText + suffix
      }
    });
  }

  // Footer: match link, last so it reads as a "find out more"
  if (matchLink) {
    widgets.push({
      textParagraph: {
        text: `<a href="${matchLink}">Find out more</a>`
      }
    });
  }

  return {
    cardsV2: [
      {
        cardId: 'match-result',
        card: {
          header: {
            title: match.gameName,
            subtitle: new Date(match.timestamp).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit'
            }),
            imageUrl: headerImageUrl,
            imageType: headerImageType
          },
          sections: [
            {
              widgets: widgets
            }
          ]
        }
      }
    ]
  };
}

export async function sendGoogleChatNotification(match: MatchNotification): Promise<void> {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log('Google Chat webhook URL not configured, skipping notification');
    return;
  }

  // Build the cards V2 payload
  const payload = buildChatCardsPayload(match);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('Failed to send Google Chat notification:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('Error sending Google Chat notification:', error);
  }
}

export function buildMatchNotification(
  gameName: string,
  matchId: number,
  teams: { player_ids: number[]; score: number }[],
  playerNames: Map<number, string>,
  skillChanges: Map<number, { before: number; after: number; change: number }>,
  imageUrl?: string | null,
  notes?: string | null,
  rankChanges?: Map<number, number>,
  achievements?: { playerId: number; achievementName: string; achievementIcon?: string | null; payout?: number }[],
  punditry?: { description: string }[],
  playerAvatars?: Map<number, string>
): MatchNotification {
  const maxScore = Math.max(...teams.map(t => t.score));
  const winners = teams.filter(t => t.score === maxScore);
  const isDraw = winners.length > 1;

  return {
    gameName,
    imageUrl: imageUrl,
    matchId,
    teams: teams.map(team => ({
      playerIds: team.player_ids,
      players: team.player_ids.map(id => playerNames.get(id) || `Player ${id}`),
      score: team.score,
      result: team.score === maxScore ? (isDraw ? 'draw' : 'win') : 'loss'
    })),
    playerAvatars,
    skillChanges: teams.flatMap(team =>
      team.player_ids.map(id => ({
        playerName: playerNames.get(id) || `Player ${id}`,
        change: skillChanges.get(id)?.change ?? 0,
        rankChange: rankChanges?.get(id)
      }))
    ),
    notes: notes,
    achievements: achievements?.map(a => ({
      playerName: playerNames.get(a.playerId) || `Player ${a.playerId}`,
      achievementName: a.achievementName,
      achievementIcon: a.achievementIcon,
      payout: a.payout
    })),
    punditry: punditry?.map(p => ({ description: p.description })),
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// Announcement cards (e.g. season hype) — simple text cards that
// don't have a match face-off at their centre.
// ============================================================

export interface AnnouncementMessage {
  /** Header title (can include emoji). */
  title: string;
  /** Header subtitle, e.g. a date. */
  subtitle?: string;
  /** HTML paragraphs (safe markup: <b>, <i>, <font color=...>, <a>). */
  paragraphs: string[];
  /** Any prebuilt widgets (face-offs etc.) rendered before the paragraphs. */
  widgets?: Record<string, unknown>[];
  /** Optional footer link. */
  linkUrl?: string;
  linkText?: string;
}

export function buildAnnouncementCardsPayload(message: AnnouncementMessage): Record<string, unknown> {
  const widgets: Record<string, unknown>[] = [
    ...(message.widgets ?? []),
    ...message.paragraphs.map(p => ({
      textParagraph: { text: p }
    })),
  ];

  widgets.push({ divider: {} });
  if (message.linkUrl) {
    widgets.push({
      textParagraph: {
        text: `<a href="${message.linkUrl}">${message.linkText || 'Find out more'}</a>`
      }
    });
  }

  return {
    cardsV2: [
      {
        cardId: 'announcement',
        card: {
          header: {
            title: message.title,
            ...(message.subtitle ? { subtitle: message.subtitle } : {})
          },
          sections: [{ widgets }]
        }
      }
    ]
  };
}

export async function sendAnnouncementNotification(message: AnnouncementMessage): Promise<'sent' | 'skipped'> {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log('Google Chat webhook URL not configured, skipping announcement');
    return 'skipped';
  }

  const payload = buildAnnouncementCardsPayload(message);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Google Chat announcement failed: ${response.status} ${response.statusText} ${body}`);
  }

  return 'sent';
}
