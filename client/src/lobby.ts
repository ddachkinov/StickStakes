import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  LIVES_OPTIONS,
  MAX_STAKE_LENGTH,
  MIN_PLAYERS,
  PLAYER_COLORS,
  ROUND_OPTIONS,
  WORLD_MAPS,
  getMap,
  type ArenaState,
  type WorldMap,
} from "@stickstakes/shared";
import { createFighterShowcase } from "./figure.js";
import { loadWardrobe, mountWardrobe, type WardrobeChoice } from "./wardrobe.js";

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
  /** Fires when the player restyles their stickman from the lobby. */
  onCustomize(handler: (change: WardrobeChoice) => void): void;
  /** Fires when the player toggles their ready state; carries the new value. */
  onReady(handler: (ready: boolean) => void): void;
  /** Fires when the host presses the go button. */
  onStart(handler: () => void): void;
}

export interface Configure {
  totalRounds?: number;
  livesPerRound?: number;
  stake?: string;
  mapId?: string;
}

/**
 * A small static schematic of a map: its sky, then every solid (one-way beams
 * lighter, crates brown), then hazards in red / steel. Just enough to tell the
 * six worlds apart at a glance in the picker.
 */
function drawMapThumb(canvas: HTMLCanvasElement, map: WorldMap): void {
  // Bitmap resolution only — the on-screen size is left entirely to CSS
  // (`.map-preview`), so the thumb shrinks to fit its grid cell on a phone
  // instead of forcing the whole picker to overflow sideways. The bitmap is
  // kept a touch denser than any cell it lands in, so it still looks crisp.
  const w = 160;
  const h = w * (ARENA_HEIGHT / ARENA_WIDTH);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale((w * dpr) / ARENA_WIDTH, (h * dpr) / ARENA_HEIGHT);

  const sky = ctx.createLinearGradient(0, 0, 0, ARENA_HEIGHT);
  sky.addColorStop(0, map.sky[0]);
  sky.addColorStop(1, map.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

  for (const s of map.solids) {
    ctx.fillStyle =
      s.kind === "crate"
        ? "#8a7355"
        : s.oneWay
          ? "rgba(255,255,255,0.55)"
          : "rgba(255,255,255,0.82)";
    ctx.fillRect(s.x, s.y, Math.max(4, s.width), Math.max(5, s.height));
  }

  for (const hz of map.hazards) {
    ctx.fillStyle = hz.kind === "saw" ? "#d7dde3" : "#ff5a5f";
    ctx.fillRect(hz.x, hz.y, Math.max(8, hz.width), Math.max(8, hz.height));
  }
}

export function createLobbyPanel(root: ParentNode = document): LobbyPanel {
  const el = root.querySelector<HTMLElement>("#lobby")!;
  const codeEl = root.querySelector<HTMLElement>("#lobby-code-value")!;
  const shareBtn = root.querySelector<HTMLButtonElement>("#lobby-share")!;
  const roundsEl = root.querySelector<HTMLElement>("#setup-rounds")!;
  const livesEl = root.querySelector<HTMLElement>("#setup-lives")!;
  const mapEl = root.querySelector<HTMLElement>("#setup-map")!;
  const mapBlurbEl = root.querySelector<HTMLElement>("#setup-map-blurb")!;
  const stakeEl = root.querySelector<HTMLInputElement>("#setup-stake")!;
  const hintEl = root.querySelector<HTMLElement>("#lobby-hint")!;
  const readyBtn = root.querySelector<HTMLButtonElement>("#lobby-ready")!;
  const startBtn = root.querySelector<HTMLButtonElement>("#lobby-start")!;
  const readyCountEl = root.querySelector<HTMLElement>("#lobby-ready-count")!;
  const heroNameEl = root.querySelector<HTMLElement>("#lobby-hero-name")!;
  const heroTagEl = root.querySelector<HTMLElement>("#lobby-hero-tag")!;
  const fighterCanvas = root.querySelector<HTMLCanvasElement>("#lobby-fighter")!;
  const wardrobeColorsEl = root.querySelector<HTMLElement>("#lobby-wardrobe-colors")!;
  const wardrobeHatsEl = root.querySelector<HTMLElement>("#lobby-wardrobe-hats")!;

  let configureHandler: ((change: Configure) => void) | undefined;
  let customizeHandler: ((change: WardrobeChoice) => void) | undefined;
  let shareHandler: (() => void) | undefined;
  let readyHandler: ((ready: boolean) => void) | undefined;
  let startHandler: (() => void) | undefined;
  let isHost = false;
  /** Last ready state the server showed us, so the button can toggle it. */
  let selfReady = false;
  /** True while the host is typing, so incoming state can't yank the cursor. */
  let editingStake = false;

  shareBtn.addEventListener("click", () => shareHandler?.());
  readyBtn.addEventListener("click", () => readyHandler?.(!selfReady));
  startBtn.addEventListener("click", () => startHandler?.());

  // A calm idle stickman in the hero, wearing whatever the player has picked.
  const seedLook = loadWardrobe(PLAYER_COLORS[0]!);
  const showcase = createFighterShowcase(fighterCanvas, seedLook);

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

  // The world picker: a grid of chips, each a schematic preview of the map's
  // geometry over its own sky, with the name under it. Host-only, like the
  // rounds/lives controls.
  mapEl.replaceChildren(
    ...WORLD_MAPS.map((worldMap) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip map-chip";
      chip.dataset.value = worldMap.id;
      chip.title = worldMap.blurb;

      const preview = document.createElement("canvas");
      preview.className = "map-preview";
      drawMapThumb(preview, worldMap);

      const label = document.createElement("span");
      label.className = "map-chip-name";
      label.textContent = worldMap.name;

      chip.append(preview, label);
      chip.addEventListener("click", () => {
        if (!isHost) return;
        configureHandler?.({ mapId: worldMap.id });
      });
      return chip;
    }),
  );

  // Your look. Everyone gets this — it's per-player and cosmetic, not host-only
  // setup. Seeded from the same remembered pick the landing screen used, so it
  // already shows what you joined as.
  const wardrobe = mountWardrobe(wardrobeColorsEl, wardrobeHatsEl, seedLook);
  wardrobe.onChange((change) => {
    showcase.set(change.color, change.hat);
    customizeHandler?.(change);
  });
  showcase.set(seedLook.color, seedLook.hat);

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

  function markSelected(container: HTMLElement, value: number | string): void {
    for (const chip of container.querySelectorAll<HTMLButtonElement>(".chip")) {
      chip.classList.toggle("is-on", chip.dataset.value === String(value));
      chip.disabled = !isHost;
    }
  }

  /** Only write when the value actually moved — a lobby is a still screen. */
  function setText(node: { textContent: string | null }, value: string): void {
    if (node.textContent !== value) node.textContent = value;
  }

  /**
   * Everything `update()` paints, folded into one string. The lobby is called
   * from the 60 fps render loop but nothing on it moves between server patches,
   * so an unchanged signature skips ~1000 DOM writes/sec (three
   * `querySelectorAll` sweeps and a dozen `textContent` assignments) for a
   * screen that looks identical.
   */
  let lastSig = "";

  return {
    update(state, selfId, code) {
      el.hidden = false;

      const self = state.players.get(selfId);
      let readyCount = 0;
      for (const player of state.players.values()) if (player.ready) readyCount++;
      const total = state.players.size;

      const sig =
        `${code}|${state.hostId === selfId}|${state.totalRounds}|${state.livesPerRound}|` +
        `${state.mapId}|${state.stake}|${self?.color ?? ""}|${self?.hat ?? ""}|` +
        `${self?.name ?? ""}|${self?.ready ?? false}|${readyCount}/${total}`;
      if (sig === lastSig) return;
      lastSig = sig;

      isHost = state.hostId === selfId;

      // Show what the server actually has for us — the panel is built before
      // the landing screen resolves, so its first paint can be stale.
      if (self) wardrobe.sync({ color: self.color, hat: self.hat });

      // Keep the hero fighter in step with the pick (touched → the player's
      // choice; untouched → whatever the server synced above).
      const look = wardrobe.value();
      showcase.set(look.color, look.hat);
      setText(heroNameEl, self?.name || "You");

      setText(codeEl, code || "····");
      markSelected(roundsEl, state.totalRounds);
      markSelected(livesEl, state.livesPerRound);
      markSelected(mapEl, state.mapId);
      setText(mapBlurbEl, getMap(state.mapId).blurb);

      // Never overwrite what the host is mid-way through typing.
      if (!editingStake && stakeEl.value !== state.stake) stakeEl.value = state.stake;
      stakeEl.readOnly = !isHost;

      // Ready state: reflect the server's truth, and count the room.
      selfReady = self?.ready ?? false;
      setText(readyBtn, selfReady ? "Ready ✓" : "Ready up");
      readyBtn.classList.toggle("is-on", selfReady);

      const allReady = total > 0 && readyCount === total;
      const solo = total < MIN_PLAYERS;
      setText(
        readyCountEl,
        allReady ? "everyone's ready" : `${readyCount}/${total} ready`,
      );

      // The host's go button lives here, not in the banner — the banner is
      // covered by this panel on a phone. Shows only once the whole room
      // (host included) has readied up.
      const canStart = isHost && allReady;
      startBtn.hidden = !canStart;
      setText(startBtn, solo ? "Start solo" : "Start match");

      setText(heroTagEl, isHost ? "you're the host" : "you're in");

      setText(
        hintEl,
        isHost
          ? allReady
            ? solo
              ? "Flying solo — start whenever."
              : "Everyone's ready — start when you are."
            : "Share the code. Start unlocks once everyone's readied up."
          : selfReady
            ? "Waiting for the others and the host."
            : "Ready up when you're set.",
      );
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
    onCustomize(handler) {
      customizeHandler = handler;
    },
    onReady(handler) {
      readyHandler = handler;
    },
    onStart(handler) {
      startHandler = handler;
    },
  };
}
