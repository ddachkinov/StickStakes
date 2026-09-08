/**
 * Install-to-homescreen, screen wake-lock and fullscreen: the things that make
 * this feel like an app on a phone rather than a tab.
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

/**
 * Fullscreen, across the browsers that actually ship it.
 *
 * Three things make this less trivial than it looks:
 *
 *  - Safari (desktop, and iPad) only has the `webkit`-prefixed spelling, so the
 *    unprefixed call alone silently does nothing there.
 *  - iPhone Safari has no element fullscreen at all — only `<video>` gets it.
 *    There is nothing to fall back to, so the button hides rather than sitting
 *    there dead. (Installing to the home screen is the real answer on iOS, and
 *    the manifest already asks for a fullscreen display mode.)
 *  - An installed PWA is already fullscreen, so the button is noise there too.
 */
interface FullscreenControl {
  /** False when there is nothing worth showing a button for. */
  readonly supported: boolean;
  readonly active: boolean;
  toggle(): void;
  /** Fires whenever the state changes, including when the user presses Esc. */
  onChange(handler: (active: boolean) => void): void;
}

/**
 * The fullscreen API as it really is, rather than as `lib.dom` describes it.
 *
 * `lib.dom` declares `requestFullscreen` and `exitFullscreen` as always
 * present, which is exactly the assumption that leaves an iPhone with a button
 * that does nothing. Going through these narrow, all-optional shapes is what
 * lets the checks below be honest — and gets us the `webkit` spellings Safari
 * still needs.
 */
interface FullscreenElementApi {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface FullscreenDocumentApi {
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
}

export function createFullscreen(): FullscreenControl {
  const root = document.documentElement as unknown as FullscreenElementApi;
  const doc = document as unknown as FullscreenDocumentApi;

  const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;

  // Already running without browser chrome: an installed PWA, or a phone that
  // launched us from the home screen.
  const standalone =
    window.matchMedia?.("(display-mode: fullscreen), (display-mode: standalone)").matches ||
    // iOS's own, pre-standard flag for the same thing.
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const supported = Boolean(request && exit && enabled) && !standalone;
  const handlers: ((active: boolean) => void)[] = [];

  const isActive = (): boolean =>
    Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);

  function announce(): void {
    for (const handler of handlers) handler(isActive());
  }

  // Both spellings: the browser fires one or the other, never both.
  document.addEventListener("fullscreenchange", announce);
  document.addEventListener("webkitfullscreenchange", announce);

  return {
    supported,
    get active() {
      return isActive();
    },
    toggle() {
      if (!supported) return;
      // A rejected request is not worth surfacing — the browser has already
      // decided, usually because the gesture didn't qualify.
      const done = isActive() ? exit?.call(document) : request?.call(document.documentElement);
      void Promise.resolve(done).catch(() => {});
    },
    onChange(handler) {
      handlers.push(handler);
    },
  };
}
