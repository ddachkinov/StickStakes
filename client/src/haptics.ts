/**
 * Vibration.
 *
 * This game gets played at a table where every phone is on silent and four
 * people are talking over each other, so a buzz is often the only feedback
 * that actually lands. Android honours it; iOS Safari ignores `vibrate`
 * entirely and silently, which is fine — it degrades to nothing.
 *
 * Only ever fires for things that happened to YOU. Buzzing on every remote
 * hit would turn a four-player brawl into a permanently rattling phone.
 */

const supported = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function buzz(pattern: number | number[]): void {
  if (!supported) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw when the page isn't visible. Never worth crashing for.
  }
}

export const haptics = {
  supported,
  /** `strength` is 0..1 — a light tap at 0%, a proper jolt at high damage. */
  hit(strength: number): void {
    buzz(Math.round(12 + Math.min(1, Math.max(0, strength)) * 28));
  },
  death(): void {
    buzz([30, 45, 70]);
  },
  roundEnd(): void {
    buzz([18, 60, 18]);
  },
  matchOver(): void {
    buzz([25, 50, 25, 50, 90]);
  },
  /** Cancel anything in flight — used when leaving the game. */
  stop(): void {
    buzz(0);
  },
};
