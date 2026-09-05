import {
  LIVES_OPTIONS,
  MAX_STAKE_LENGTH,
  ROUND_OPTIONS,
  type ArenaState,
} from "@stickstakes/shared";

/**
 * The lobby panel: the room code to read across the table, and the host's
 * match setup (rounds, lives, and what everyone is actually playing for).
 *
 * Non-hosts see the same panel read-only, so nobody has to ask "how many
 * rounds is this?" — the answer is on their screen too.
 */

export interface LobbyPanel {
  update(state: ArenaState, selfId: string, code: string): void;
  hide(): void;
  onConfigure(handler: (change: Configure) => void): void;
  onShare(handler: () => void): void;
}

export interface Configure {
  totalRounds?: number;
  livesPerRound?: number;
  stake?: string;
}

export function createLobbyPanel(root: ParentNode = document): LobbyPanel {
  const el = root.querySelector<HTMLElement>("#lobby")!;
  const codeEl = root.querySelector<HTMLElement>("#lobby-code-value")!;
  const shareBtn = root.querySelector<HTMLButtonElement>("#lobby-share")!;
  const roundsEl = root.querySelector<HTMLElement>("#setup-rounds")!;
  const livesEl = root.querySelector<HTMLElement>("#setup-lives")!;
  const stakeEl = root.querySelector<HTMLInputElement>("#setup-stake")!;
  const hintEl = root.querySelector<HTMLElement>("#lobby-hint")!;

  let configureHandler: ((change: Configure) => void) | undefined;
  let shareHandler: (() => void) | undefined;
  let isHost = false;
  /** True while the host is typing, so incoming state can't yank the cursor. */
  let editingStake = false;

  shareBtn.addEventListener("click", () => shareHandler?.());

  function buildChips(
    container: HTMLElement,
    options: readonly number[],
    key: "totalRounds" | "livesPerRound",
  ): void {
    container.replaceChildren(
      ...options.map((value) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = String(value);
        chip.dataset.value = String(value);
        chip.addEventListener("click", () => {
          if (!isHost) return;
          configureHandler?.({ [key]: value });
        });
        return chip;
      }),
    );
  }

  buildChips(roundsEl, ROUND_OPTIONS, "totalRounds");
  buildChips(livesEl, LIVES_OPTIONS, "livesPerRound");

  stakeEl.maxLength = MAX_STAKE_LENGTH;
  stakeEl.addEventListener("focus", () => {
    editingStake = true;
  });
  stakeEl.addEventListener("blur", () => {
    editingStake = false;
    if (isHost) configureHandler?.({ stake: stakeEl.value });
  });
  stakeEl.addEventListener("change", () => {
    if (isHost) configureHandler?.({ stake: stakeEl.value });
  });

  function markSelected(container: HTMLElement, value: number): void {
    for (const chip of container.querySelectorAll<HTMLButtonElement>(".chip")) {
      chip.classList.toggle("is-on", chip.dataset.value === String(value));
      chip.disabled = !isHost;
    }
  }

  return {
    update(state, selfId, code) {
      el.hidden = false;
      isHost = state.hostId === selfId;

      codeEl.textContent = code || "····";
      markSelected(roundsEl, state.totalRounds);
      markSelected(livesEl, state.livesPerRound);

      // Never overwrite what the host is mid-way through typing.
      if (!editingStake && stakeEl.value !== state.stake) stakeEl.value = state.stake;
      stakeEl.readOnly = !isHost;

      hintEl.textContent = isHost
        ? "Read the code out, or share the link. Start when everyone's in."
        : "Waiting for the host to start.";
    },
    hide() {
      el.hidden = true;
    },
    onConfigure(handler) {
      configureHandler = handler;
    },
    onShare(handler) {
      shareHandler = handler;
    },
  };
}
