'use client';

import { useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';

/**
 * Live chip for the top bar.
 *
 * A live match is the in-progress scorer draft in localStorage (see
 * /matches/live, DRAFT_KEY 'liveMatchDraft.v1') — no shared server signal
 * exists for "a match is in progress", so the chip appears on the device
 * where a live match is being recorded. Hidden otherwise.
 *
 * shortcut: live presence is device-local (the draft), not shared across
 * devices — upgrade when the backend exposes an "in-progress match" state.
 */
const DRAFT_KEY = 'liveMatchDraft.v1';

function hasLiveDraft(): boolean {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const draft = JSON.parse(raw) as { version?: number; startedAt?: string; events?: unknown[] };
    return draft.version === 1 && !!draft.startedAt && Array.isArray(draft.events) && draft.events.length > 0;
  } catch {
    return false;
  }
}

function subscribe(callback: () => void) {
  const check = () => callback();
  // Draft changes in other tabs arrive as storage events; in this tab the
  // live scorer updates the draft silently, so re-check on focus + a slow poll.
  window.addEventListener('storage', check);
  window.addEventListener('focus', check);
  const poll = window.setInterval(check, 30_000);
  return () => {
    window.removeEventListener('storage', check);
    window.removeEventListener('focus', check);
    window.clearInterval(poll);
  };
}

export function LiveChip() {
  const live = useSyncExternalStore(subscribe, hasLiveDraft, () => false);

  if (!live) return null;

  return (
    <Link
      href="/matches/live"
      className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-all"
      title="A live match is being recorded — resume the live scorer"
    >
      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse motion-reduce:animate-none inline-block" aria-hidden />
      <span className="hidden sm:inline">Live</span>
    </Link>
  );
}
