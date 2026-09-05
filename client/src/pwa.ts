/**
 * Install-to-homescreen and screen wake-lock: the two things that make this
 * feel like an app on a phone rather than a tab.
 */

/**
 * Register the service worker. Production only — in dev, Vite serves modules
 * unbundled and a caching worker between you and HMR is nothing but grief.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // Not fatal: without a worker the game still plays, it just isn't
      // installable and cold launches stay cold.
      console.warn("[pwa] service worker registration failed", error);
    });
  });
}

/**
 * Hold the screen awake.
 *
 * A phone dimming mid-round is the single most annoying failure in a game you
 * play with your thumbs and no keyboard. The lock is dropped by the browser
 * whenever the page is hidden, so it has to be re-taken on the way back —
 * that re-acquire is the part everybody forgets.
 */
export function createWakeLock() {
  let sentinel: WakeLockSentinel | null = null;
  let wanted = false;

  const supported = "wakeLock" in navigator;

  async function take(): Promise<void> {
    if (!supported || !wanted || sentinel || document.visibilityState !== "visible") return;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => {
        sentinel = null;
      });
    } catch {
      // Denied, low battery, or the tab lost focus mid-request. Harmless —
      // the next visibility change tries again.
      sentinel = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void take();
  });

  return {
    supported,
    /** Call when a match is on and the screen must stay lit. */
    acquire(): void {
      wanted = true;
      void take();
    },
    /** Call when back on a menu, so the phone can sleep normally again. */
    release(): void {
      wanted = false;
      void sentinel?.release().catch(() => {});
      sentinel = null;
    },
  };
}

export type WakeLock = ReturnType<typeof createWakeLock>;
