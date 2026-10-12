// Bets-window display clock, shared by the gambling lobby and the match page.
// Client-import-safe on purpose: no db / node dependencies here.

/** The open window reads "BETS CLOSING" for its final stretch. */
export const BETS_CLOSING_AFTER_S = 180;

/** True while the open betting window is inside its closing stretch. */
export function betsClosingSoon(secondsToClose: number): boolean {
  return secondsToClose > 0 && secondsToClose <= BETS_CLOSING_AFTER_S;
}

/**
 * Open-window countdown: minutes while the window is long, seconds once the
 * closing stretch starts (where the label itself flips to BETS CLOSING).
 */
export function formatBetsCountdown(secondsToClose: number): string {
  const s = Math.max(0, secondsToClose);
  return s <= BETS_CLOSING_AFTER_S ? `${s}s` : `${Math.floor(s / 60)}m`;
}