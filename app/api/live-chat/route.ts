import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

// Live-score updates from the live scorer, posted to the same Google Chat
// space as match results (shared GOOGLE_CHAT_WEBHOOK_URL). Threading: every
// message carries thread.thread_key and messageReplyOption on the URL — a
// fresh key opens a thread, the same key posts each subsequent point as a
// reply inside it.

/** Goal emoji: per-game setting (chat_emoji.<gameId>) beats the default
 *  (chat_emoji) — both editable in the settings menu. Falls back to 🏆. */
function goalEmoji(gameId?: number): string {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'chat_emoji%'`).all() as { key: string; value: string }[];
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  if (gameId != null) {
    const own = byKey.get(`chat_emoji.${gameId}`);
    if (own) return own;
  }
  return byKey.get('chat_emoji') || '🏆';
}

interface LiveChatBody {
  action: 'start' | 'goal' | 'final';
  threadKey?: string;
  game?: string | null;
  gameId?: number;
  targetHint?: string | null;
  redName?: string;
  blueName?: string;
  scorer?: string;
  /** Running score as "3-2". */
  score?: string;
  /** Clock stamp for a goal, e.g. "08:12". */
  at?: string;
  /** Match length for the full-time line. */
  duration?: string;
}

export async function POST(request: NextRequest) {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json({ ok: false, error: 'chat_webhook_not_configured' });
  }

  let body: LiveChatBody;
  try {
    body = await request.json() as LiveChatBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }

  const threadKey = body.action === 'start'
    ? `live-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    : body.threadKey;
  if (!threadKey) {
    return NextResponse.json({ ok: false, error: 'threadKey required' }, { status: 400 });
  }

  const red = body.redName ?? 'Team 1';
  const blue = body.blueName ?? 'Team 2';
  const score = body.score ?? '';

  let text: string;
  switch (body.action) {
    case 'start':
      text = `🔴 *LIVE* ${body.game ? body.game : 'Match'}${body.targetHint ? ` (${body.targetHint})` : ''} — *${red}* vs *${blue}*. Kick off!`;
      break;
    case 'goal':
      text = `${goalEmoji(body.gameId)} ${body.at ? `${body.at} — ` : ''}*${body.scorer ?? 'A side'}* scores → *${score}*`;
      break;
    case 'final':
      text = `🏁 *FULL TIME* ${red} ${score} ${blue}${body.duration ? ` · ${body.duration}` : ''}`;
      break;
    default:
      return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  }

  try {
    // With messageReplyOption set, Chat looks up threadKey and posts the
    // message as a reply to that thread (falls back to a new thread when the
    // key isn't found — the kickoff case). Without this URL param the
    // threadKey is ignored and every message starts its own thread.
    const sep = webhookUrl.includes('?') ? '&' : '?';
    const postUrl = `${webhookUrl}${sep}messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
    const res = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, thread: { threadKey } }),
    });
    if (!res.ok) {
      console.error('Google Chat live update failed:', res.status, res.statusText);
      return NextResponse.json({ ok: false, error: 'webhook error' });
    }
  } catch (error) {
    console.error('Error sending Google Chat live update:', error);
    return NextResponse.json({ ok: false, error: 'webhook unreachable' });
  }

  return NextResponse.json({ ok: true, threadKey });
}
