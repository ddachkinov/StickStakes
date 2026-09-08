import { MIN_PLAYERS, isLivePhase, type ArenaState, type MatchPhase } from "@stickstakes/shared";

/**
 * The way out of a game.
 *
 * Until this existed the only exit from a room was closing the tab, and the
 * only way to change a match you had already started was to finish it. So:
 * one button, top-right, that opens a card with the four things anyone ever
 * wants — resume, restart, back to the lobby, and leave.
 *
 * Two rules shape the whole thing.
 *
 * **Pausing is solo-only.** Stopping the world is only fair when the world is
 * yours. Alone, the menu really does stop the fight (the server freezes it);
 * with company it is a local overlay and the card says so plainly, because a
 * menu that quietly leaves you standing still to be hit is worse than one that
 * warns you.
 *
 * **Leaving a live match costs you the match.** The server will not let a
 * fighter walk out and walk back in — that is the cheapest way to dodge a
 * losing round. So leaving mid-fight asks twice, and says what it costs.
 */

export interface MenuActions {
  /** Host, mid-match: throw this match away and run the same setup again. */
  restart(): void;
  /** Host: abandon the match and take the whole room back to the lobby. */
  toLobby(): void;
  /** Leave the room entirely and go back to the landing screen. */
  leave(): void;
  /** Ask the server to hold (or release) a solo fight. */
  setPaused(paused: boolean): void;
}

export interface PauseMenu {
  readonly open: boolean;
  /** Repaint against the latest state. Cheap enough to call every frame. */
  update(state: ArenaState, selfId: string): void;
  show(): void;
  close(): void;
  toggle(): void;
  on(actions: Partial<MenuActions>): void;
  /** No game to be in: close the card and take the button off the screen. */
  hide(): void;
}

export function createPauseMenu(root: ParentNode = document): PauseMenu {
  const openBtn = root.querySelector<HTMLButtonElement>("#pause")!;
  const el = root.querySelector<HTMLElement>("#menu")!;
  const titleEl = root.querySelector<HTMLElement>("#menu-title")!;
  const subEl = root.querySelector<HTMLElement>("#menu-sub")!;
  const resumeBtn = root.querySelector<HTMLButtonElement>("#menu-resume")!;
  const restartBtn = root.querySelector<HTMLButtonElement>("#menu-restart")!;
  const lobbyBtn = root.querySelector<HTMLButtonElement>("#menu-lobby")!;
  const leaveBtn = root.querySelector<HTMLButtonElement>("#menu-leave")!;
  const warnEl = root.querySelector<HTMLElement>("#menu-warn")!;

  let actions: Partial<MenuActions> = {};
  let open = false;
  /** Leaving mid-match is one-way, so the button asks a second time. */
  let armedToLeave = false;
  /** True while this client is the one holding a solo pause. */
  let pausedByUs = false;

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    el.hidden = !open;
    openBtn.setAttribute("aria-expanded", String(open));
    // Every visit starts from an unarmed Leave — nobody should be able to
    // reopen the menu and quit a match with a single stray tap.
    armedToLeave = false;
  }

  function show(): void {
    setOpen(true);
  }

  /**
   * Closing is also "unpause": if we asked the server to hold a solo fight,
   * the fight starts again the moment the card goes away. The two are the same
   * gesture, so they must never come apart — a menu that closes but leaves the
   * world frozen is a hang.
   */
  function close(): void {
    setOpen(false);
    if (pausedByUs) {
      pausedByUs = false;
      actions.setPaused?.(false);
    }
  }

  openBtn.addEventListener("click", () => {
    if (open) close();
    else show();
  });

  resumeBtn.addEventListener("click", close);

  restartBtn.addEventListener("click", () => {
    close();
    actions.restart?.();
  });

  lobbyBtn.addEventListener("click", () => {
    close();
    actions.toLobby?.();
  });

  leaveBtn.addEventListener("click", () => {
    // Nothing at stake (lobby, end screen): go straight out.
    if (!leaveBtn.dataset.confirm) {
      close();
      actions.leave?.();
      return;
    }
    if (!armedToLeave) {
      armedToLeave = true;
      leaveBtn.textContent = "Leave anyway";
      leaveBtn.classList.add("is-armed");
      return;
    }
    close();
    actions.leave?.();
  });

  /**
   * Escape is the universal "get me out of here" on a keyboard. Bound for the
   * life of the page, like the card itself; while there is no game the button
   * is hidden and this does nothing.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.code !== "Escape") return;
    if (open) close();
    else if (!openBtn.hidden) show();
  }

  document.addEventListener("keydown", onKeyDown);

  return {
    get open() {
      return open;
    },

    update(state, selfId) {
      const phase = state.phase as MatchPhase;
      const isHost = state.hostId === selfId;
      const live = isLivePhase(phase);
      const self = state.players.get(selfId);
      // Solo means the server will actually hold the world for us. It is the
      // same test the server makes, so the card never promises what it can't
      // deliver.
      const solo = state.players.size < MIN_PLAYERS;

      // No menu button until we are actually in a room with a state to leave.
      openBtn.hidden = state.players.size === 0;

      // Quitting a live match as a fighter is one-way until the match ends.
      // Kept current even while the card is shut, so it is already right the
      // frame it opens rather than one frame later.
      const costly = live && !!self && !self.spectating;
      leaveBtn.dataset.confirm = costly ? "1" : "";

      if (!open) {
        // Someone else ended the match under us (the host restarted, the round
        // ran out). Our pause went with it.
        if (pausedByUs && !state.paused) pausedByUs = false;
        return;
      }

      // Alone in a live fight: ask for a real pause the first time the card is
      // opened, and keep asking until the server agrees. `pause` is idempotent
      // and refused unless we're solo, so a room that fills up mid-menu simply
      // carries on fighting — which is exactly the intent.
      if (live && solo && !state.paused && !pausedByUs) {
        pausedByUs = true;
        actions.setPaused?.(true);
      }

      const held = state.paused;
      titleEl.textContent = held ? "Paused" : "Menu";
      subEl.textContent = held
        ? "The world is holding still."
        : live
          ? "The fight carries on while this is open — mind your stickman."
          : phase === "lobby"
            ? "Waiting in the lobby."
            : "That's the match done.";

      resumeBtn.textContent = live ? "Resume" : "Back to the game";

      // The host's two exits from a live match. Nobody else gets to end
      // everyone's game, and there is nothing to restart from the lobby — the
      // lobby's own start button covers that.
      restartBtn.hidden = !(isHost && live);
      lobbyBtn.hidden = !(isHost && phase !== "lobby");

      // Say what leaving costs before it happens rather than after.
      if (!armedToLeave) {
        leaveBtn.textContent = "Leave the game";
        leaveBtn.classList.remove("is-armed");
      }

      warnEl.textContent = armedToLeave
        ? "You'll be locked out of this match until it ends."
        : costly
          ? "Leave now and you can't rejoin until this match is over."
          : "";
      warnEl.hidden = warnEl.textContent === "";
    },

    show,
    close,
    toggle() {
      if (open) close();
      else show();
    },
    on(next) {
      actions = { ...actions, ...next };
    },
    hide() {
      // Straight to closed: there is no room left to unpause.
      pausedByUs = false;
      setOpen(false);
      openBtn.hidden = true;
    },
  };
}
