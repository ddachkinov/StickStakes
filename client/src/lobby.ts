import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  HATS,
  LIVES_OPTIONS,
  LOBBY_COLORS,
  MAX_PLAYERS,
  MAX_STAKE_LENGTH,
  MIN_PLAYERS,
  PLAYER_COLORS,
  ROUND_OPTIONS,
  WORLD_MAPS,
  getMap,
  isHatId,
  lobbyColorIdFromHex,
  lobbyColorName,
  type ArenaState,
  type Player,
  type WorldMap,
} from "@stickstakes/shared";
import { createFighterShowcase, type FighterShowcase } from "./figure.js";
import { loadWardrobe, type WardrobeChoice } from "./wardrobe.js";

/**
 * The multiplayer lobby: a pre-match waiting room, not a settings page.
 *
 * Every connected player stands on the floor as their own stickman, wearing the
 * colour they've claimed. You pick a colour nobody else holds (the server keeps
 * that unique), dress your fighter, and ready up. The host's match rules live
 * behind the settings gear so the room itself stays about the players.
 *
 * The panel keeps almost no state of its own: it renders `ArenaState` on every
 * frame and only rebuilds the DOM when a cheap signature of that state changes.
 */

export interface LobbyPanel {
  update(state: ArenaState, selfId: string, code: string): void;
  hide(): void;
  onConfigure(handler: (change: Configure) => void): void;
  onShare(handler: () => void): void;
  /** Fires when the player restyles (hat only now — colour has its own path). */
  onCustomize(handler: (change: WardrobeChoice) => void): void;
  /** Fires when the player claims a palette colour by id. */
  onSetColor(handler: (colorId: string) => void): void;
  /** Fires when the player toggles their ready state; carries the new value. */
  onReady(handler: (ready: boolean) => void): void;
  /** Fires when the host presses the go button. */
  onStart(handler: () => void): void;
  /** Fires when the player confirms leaving the lobby. */
  onLeave(handler: () => void): void;
  /** The server bounced a colour request — someone else got there first. */
  notifyColorRejected(colorId: string): void;
}

export interface Configure {
  totalRounds?: number;
  livesPerRound?: number;
  stake?: string;
  mapId?: string;
}

/** Just enough of the audio surface for the settings toggle. */
interface AudioLike {
  readonly muted: boolean;
  toggleMute(): void;
}

const HAT_KEY = "stickstakes:hat";
const COLOR_ID_KEY = "stickstakes:colorId";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — nothing to persist to */
  }
}

/**
 * A small static schematic of a map: its sky, then every solid (one-way beams
 * lighter, crates brown), then hazards in red / steel. Enough to tell the
 * worlds apart at a glance in the host's rules picker.
 */
function drawMapThumb(canvas: HTMLCanvasElement, map: WorldMap): void {
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

/** One stickman on the floor: a live idle figure, a nameplate, a ready pip. */
interface Podium {
  root: HTMLElement;
  plate: HTMLElement;
  ready: HTMLElement;
  showcase: FighterShowcase;
  color: string;
  hat: string;
}

export function createLobbyPanel(
  root: ParentNode = document,
  opts: { audio?: AudioLike } = {},
): LobbyPanel {
  const el = root.querySelector<HTMLElement>("#lobby")!;
  const codeEl = root.querySelector<HTMLElement>("#lobby-code-value")!;
  const roomBtn = root.querySelector<HTMLButtonElement>("#lobby-room")!;
  const gearBtn = root.querySelector<HTMLButtonElement>("#lobby-gear")!;
  const floorEl = root.querySelector<HTMLElement>("#lobby-floor")!;
  const countBannerEl = root.querySelector<HTMLElement>("#lobby-count-banner")!;
  const statusEl = root.querySelector<HTMLElement>("#lobby-status")!;
  const readyBtn = root.querySelector<HTMLButtonElement>("#lobby-ready")!;
  const startBtn = root.querySelector<HTMLButtonElement>("#lobby-start")!;
  const wardrobeOpenBtn = root.querySelector<HTMLButtonElement>("#lobby-wardrobe-open")!;
  const rosterCountEl = root.querySelector<HTMLElement>("#lobby-roster-count")!;
  const rosterListEl = root.querySelector<HTMLElement>("#lobby-roster-list")!;
  const toastsEl = root.querySelector<HTMLElement>("#lobby-toasts")!;

  const fighterCanvas = root.querySelector<HTMLCanvasElement>("#lobby-fighter")!;
  const colorGridEl = root.querySelector<HTMLElement>("#lobby-color-grid")!;
  const hatsEl = root.querySelector<HTMLElement>("#lobby-wardrobe-hats")!;

  const wardrobeModal = root.querySelector<HTMLElement>("#lobby-wardrobe")!;
  const wardrobeCloseBtn = root.querySelector<HTMLButtonElement>("#lobby-wardrobe-close")!;
  const settingsModal = root.querySelector<HTMLElement>("#lobby-settings")!;
  const settingsCloseBtn = root.querySelector<HTMLButtonElement>("#lobby-settings-close")!;
  const soundToggle = root.querySelector<HTMLButtonElement>("#lobby-set-sound")!;
  const fullscreenToggle = root.querySelector<HTMLButtonElement>("#lobby-set-fullscreen")!;
  const leaveBtn = root.querySelector<HTMLButtonElement>("#lobby-leave")!;
  const leaveConfirm = root.querySelector<HTMLElement>("#lobby-leave-confirm")!;
  const leaveCancelBtn = root.querySelector<HTMLButtonElement>("#lobby-leave-cancel")!;
  const leaveGoBtn = root.querySelector<HTMLButtonElement>("#lobby-leave-go")!;

  const roundsEl = root.querySelector<HTMLElement>("#setup-rounds")!;
  const livesEl = root.querySelector<HTMLElement>("#setup-lives")!;
  const mapEl = root.querySelector<HTMLElement>("#setup-map")!;
  const mapBlurbEl = root.querySelector<HTMLElement>("#setup-map-blurb")!;
  const stakeEl = root.querySelector<HTMLInputElement>("#setup-stake")!;
  const rulesNoteEl = root.querySelector<HTMLElement>("#lobby-rules-note")!;

  let configureHandler: ((change: Configure) => void) | undefined;
  let customizeHandler: ((change: WardrobeChoice) => void) | undefined;
  let setColorHandler: ((colorId: string) => void) | undefined;
  let shareHandler: (() => void) | undefined;
  let readyHandler: ((ready: boolean) => void) | undefined;
  let startHandler: (() => void) | undefined;
  let leaveHandler: (() => void) | undefined;

  let isHost = false;
  let selfReady = false;
  let editingStake = false;

  // The look the player is wearing, seeded from what rode in on the join.
  const seed = loadWardrobe(PLAYER_COLORS[0]!);
  let look: WardrobeChoice = {
    color: seed.color,
    hat: isHatId(readStored(HAT_KEY)) ? readStored(HAT_KEY)! : seed.hat,
  };
  let selfColorId = readStored(COLOR_ID_KEY) ?? lobbyColorIdFromHex(seed.color);

  const heroShowcase = createFighterShowcase(fighterCanvas, look);

  // ---- toast diffing: remember what we last showed each player as ----
  interface Seen {
    name: string;
    ready: boolean;
    colorId: string;
  }
  let seenPlayers = new Map<string, Seen>();
  let seededToasts = false;
  let lastSignature = "";

  function toast(message: string, tone: "" | "good" | "warn" = ""): void {
    const node = document.createElement("div");
    node.className = tone ? `lobby-toast is-${tone}` : "lobby-toast";
    node.textContent = message;
    toastsEl.append(node);
    // Trigger the enter transition on the next frame.
    requestAnimationFrame(() => node.classList.add("is-in"));
    window.setTimeout(() => {
      node.classList.remove("is-in");
      window.setTimeout(() => node.remove(), 240);
    }, 2600);
    // Never let a flood of joins stack past a few.
    while (toastsEl.children.length > 4) toastsEl.firstElementChild?.remove();
  }

  // ------------------------------------------------------------- host rules

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
          if (isHost) configureHandler?.({ [key]: value });
        });
        return chip;
      }),
    );
  }

  buildChips(roundsEl, ROUND_OPTIONS, "totalRounds");
  buildChips(livesEl, LIVES_OPTIONS, "livesPerRound");

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
        if (isHost) configureHandler?.({ mapId: worldMap.id });
      });
      return chip;
    }),
  );

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

  // ------------------------------------------------------------- hat picker

  const hatButtons = HATS.map((hat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = hat.label;
    btn.dataset.hat = hat.id;
    btn.addEventListener("click", () => {
      look = { ...look, hat: hat.id };
      writeStored(HAT_KEY, hat.id);
      paintHats();
      heroShowcase.set(look.color, look.hat);
      customizeHandler?.({ ...look });
    });
    return btn;
  });
  hatsEl.replaceChildren(...hatButtons);

  function paintHats(): void {
    for (const btn of hatButtons) {
      btn.classList.toggle("is-on", btn.dataset.hat === look.hat);
    }
  }
  paintHats();

  // ----------------------------------------------------------- colour grid

  interface ColorCell {
    root: HTMLButtonElement;
    holder: HTMLElement;
  }
  const colorCells = new Map<string, ColorCell>();

  colorGridEl.replaceChildren(
    ...LOBBY_COLORS.map((color) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lobby-color";
      btn.dataset.colorId = color.id;
      btn.style.setProperty("--swatch", color.hex);

      const disc = document.createElement("span");
      disc.className = "lobby-color-disc";

      const name = document.createElement("span");
      name.className = "lobby-color-name";
      name.textContent = color.name;

      const holder = document.createElement("span");
      holder.className = "lobby-color-holder";

      btn.append(disc, name, holder);
      btn.addEventListener("click", () => {
        if (btn.classList.contains("is-taken") || btn.classList.contains("is-mine")) return;
        selfColorId = color.id;
        writeStored(COLOR_ID_KEY, color.id);
        setColorHandler?.(color.id);
      });
      colorCells.set(color.id, { root: btn, holder });
      return btn;
    }),
  );

  function paintColorGrid(state: ArenaState, selfId: string): void {
    const holderByColor = new Map<string, string>(); // colorId -> holder name
    for (const [sessionId, player] of state.players) {
      if (!player.colorId) continue;
      if (sessionId === selfId) continue;
      holderByColor.set(player.colorId, player.name || "Someone");
    }

    for (const [id, cell] of colorCells) {
      const mine = id === selfColorId;
      const takenBy = holderByColor.get(id);
      cell.root.classList.toggle("is-mine", mine);
      cell.root.classList.toggle("is-taken", !mine && !!takenBy);
      cell.root.disabled = !mine && !!takenBy;
      cell.holder.textContent = mine ? "You" : takenBy ? `🔒 ${takenBy}` : "";
      cell.root.setAttribute("aria-pressed", String(mine));
      cell.root.title = mine
        ? "Your current colour"
        : takenBy
          ? `Used by ${takenBy}`
          : `Select ${lobbyColorName(id)}`;
    }
  }

  // --------------------------------------------------------------- podiums

  const podiums = new Map<string, Podium>();

  function buildPodium(): Podium {
    const podRoot = document.createElement("div");
    podRoot.className = "lobby-podium";

    const stage = document.createElement("div");
    stage.className = "lobby-podium-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "lobby-podium-fig";
    stage.append(canvas);

    const plate = document.createElement("div");
    plate.className = "lobby-podium-plate";

    const ready = document.createElement("div");
    ready.className = "lobby-podium-ready";

    podRoot.append(stage, plate, ready);
    const showcase = createFighterShowcase(canvas, { color: "#ffffff", hat: "none" });
    return { root: podRoot, plate, ready, showcase, color: "", hat: "" };
  }

  function syncPodiums(state: ArenaState, selfId: string): void {
    const entries = Array.from(state.players.entries()).sort(
      ([, a], [, b]) => a.slot - b.slot,
    );
    const liveIds = new Set(entries.map(([id]) => id));

    for (const [id, pod] of podiums) {
      if (!liveIds.has(id)) {
        pod.showcase.stop();
        pod.root.remove();
        podiums.delete(id);
      }
    }

    for (const [id, player] of entries) {
      let pod = podiums.get(id);
      if (!pod) {
        pod = buildPodium();
        podiums.set(id, pod);
      }
      const isSelf = id === selfId;
      const isHostPlayer = id === state.hostId;

      pod.root.classList.toggle("is-self", isSelf);
      pod.root.dataset.self = isSelf ? "true" : "false";
      pod.root.classList.toggle("is-ready", player.ready);
      pod.root.style.setProperty("--pc", player.color);

      pod.plate.replaceChildren();
      const nameSpan = document.createElement("span");
      nameSpan.className = "lobby-podium-name";
      nameSpan.textContent = player.name;
      pod.plate.append(nameSpan);
      if (isSelf) {
        const you = document.createElement("span");
        you.className = "lobby-podium-tag is-you";
        you.textContent = "YOU";
        pod.plate.append(you);
      }
      if (isHostPlayer) {
        const host = document.createElement("span");
        host.className = "lobby-podium-tag is-host";
        host.textContent = "HOST";
        pod.plate.append(host);
      }

      pod.ready.textContent = player.ready ? "READY ✓" : "not ready";
      pod.ready.classList.toggle("is-on", player.ready);

      if (pod.color !== player.color || pod.hat !== player.hat) {
        pod.color = player.color;
        pod.hat = player.hat;
        pod.showcase.set(player.color, player.hat);
      }
    }

    // Re-append in slot order, self pulled toward the centre so the floor reads
    // as a shared space with you in the middle of it rather than off to a side.
    const ordered = entries.map(([id]) => podiums.get(id)!);
    const selfIdx = entries.findIndex(([id]) => id === selfId);
    if (selfIdx > -1) {
      const selfPod = ordered.splice(selfIdx, 1)[0];
      if (selfPod) ordered.splice(Math.floor(ordered.length / 2), 0, selfPod);
    }
    for (const pod of ordered) floorEl.append(pod.root);
  }

  // ------------------------------------------------------------- roster list

  function syncRoster(state: ArenaState, selfId: string): void {
    const entries = Array.from(state.players.entries()).sort(
      ([, a], [, b]) => a.slot - b.slot,
    );
    rosterCountEl.textContent = `${entries.length}/${MAX_PLAYERS}`;

    rosterListEl.replaceChildren(
      ...entries.map(([sessionId, player]: [string, Player]) => {
        const li = document.createElement("li");
        li.className = "lobby-roster-item";
        li.classList.toggle("is-self", sessionId === selfId);
        li.style.setProperty("--pc", player.color);

        const dot = document.createElement("span");
        dot.className = "lobby-roster-dot";

        const name = document.createElement("span");
        name.className = "lobby-roster-name";
        name.textContent = sessionId === selfId ? `${player.name} (you)` : player.name;

        const colorName = document.createElement("span");
        colorName.className = "lobby-roster-color";
        colorName.textContent = lobbyColorName(player.colorId) || "—";

        const ready = document.createElement("span");
        ready.className = player.ready ? "lobby-roster-ready is-on" : "lobby-roster-ready";
        ready.textContent = player.ready ? "READY" : "NOT READY";

        li.append(dot, name, colorName, ready);
        return li;
      }),
    );
  }

  // ------------------------------------------------------------- toast diff

  function emitToasts(state: ArenaState, selfId: string): void {
    const next = new Map<string, Seen>();
    for (const [sessionId, player] of state.players) {
      next.set(sessionId, {
        name: player.name,
        ready: player.ready,
        colorId: player.colorId,
      });
    }

    if (seededToasts) {
      for (const [id, cur] of next) {
        const prev = seenPlayers.get(id);
        if (!prev) {
          if (id !== selfId) toast(`${cur.name} joined the lobby`);
          continue;
        }
        if (id === selfId) continue;
        if (!prev.ready && cur.ready) toast(`✓ ${cur.name} is ready`, "good");
        if (prev.colorId !== cur.colorId && cur.colorId) {
          toast(`${cur.name} is now ${lobbyColorName(cur.colorId)}`);
        }
      }
      for (const [id, prev] of seenPlayers) {
        if (!next.has(id) && id !== selfId) toast(`${prev.name} left the lobby`);
      }
    }

    seenPlayers = next;
    seededToasts = true;
  }

  // --------------------------------------------------------------- modals

  function openModal(modal: HTMLElement): void {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("is-open"));
  }
  function closeModal(modal: HTMLElement): void {
    modal.classList.remove("is-open");
    window.setTimeout(() => {
      modal.hidden = true;
    }, 200);
  }

  wardrobeOpenBtn.addEventListener("click", () => openModal(wardrobeModal));
  wardrobeCloseBtn.addEventListener("click", () => closeModal(wardrobeModal));
  gearBtn.addEventListener("click", () => openModal(settingsModal));
  settingsCloseBtn.addEventListener("click", () => closeModal(settingsModal));
  for (const modal of [wardrobeModal, settingsModal, leaveConfirm]) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  }

  roomBtn.addEventListener("click", () => shareHandler?.());
  readyBtn.addEventListener("click", () => readyHandler?.(!selfReady));
  startBtn.addEventListener("click", () => startHandler?.());

  leaveBtn.addEventListener("click", () => {
    closeModal(settingsModal);
    openModal(leaveConfirm);
  });
  leaveCancelBtn.addEventListener("click", () => closeModal(leaveConfirm));
  leaveGoBtn.addEventListener("click", () => {
    closeModal(leaveConfirm);
    leaveHandler?.();
  });

  function paintSound(): void {
    const on = !opts.audio?.muted;
    soundToggle.textContent = on ? "On" : "Off";
    soundToggle.setAttribute("aria-pressed", String(on));
  }
  soundToggle.addEventListener("click", () => {
    opts.audio?.toggleMute();
    paintSound();
  });
  paintSound();

  function paintFullscreen(): void {
    const on = !!document.fullscreenElement;
    fullscreenToggle.textContent = on ? "On" : "Off";
    fullscreenToggle.setAttribute("aria-pressed", String(on));
  }
  fullscreenToggle.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
    window.setTimeout(paintFullscreen, 120);
  });
  document.addEventListener("fullscreenchange", paintFullscreen);
  paintFullscreen();

  // ---------------------------------------------------------------- update

  return {
    update(state, selfId, code) {
      el.hidden = false;
      isHost = state.hostId === selfId;

      const self = state.players.get(selfId);

      // Follow server truth for our own colour/look until we've clearly chosen
      // otherwise this session (a claim writes `selfColorId` immediately).
      if (self) {
        if (self.colorId && self.colorId !== selfColorId) {
          selfColorId = self.colorId;
          writeStored(COLOR_ID_KEY, self.colorId);
        }
        if (self.color !== look.color || self.hat !== look.hat) {
          look = { color: self.color, hat: self.hat };
          heroShowcase.set(look.color, look.hat);
          paintHats();
        }
      }

      selfReady = self?.ready ?? false;

      let readyCount = 0;
      for (const player of state.players.values()) if (player.ready) readyCount++;
      const total = state.players.size;
      const allReady = total > 0 && readyCount === total;
      const solo = total < MIN_PLAYERS;

      // A cheap signature of everything the DOM depends on. Rebuild only when it
      // moves — `update` runs every animation frame.
      const sig =
        Array.from(state.players.entries())
          .map(
            ([id, p]) =>
              `${id}:${p.name}:${p.colorId}:${p.color}:${p.hat}:${p.ready ? 1 : 0}`,
          )
          .join("|") +
        `#${selfId}#${state.hostId}#${code}#${state.totalRounds}#${state.livesPerRound}` +
        `#${state.mapId}#${state.stake}#${selfColorId}`;

      // Toasts always run (they do their own change detection and are cheap).
      emitToasts(state, selfId);

      if (sig === lastSignature) return;
      lastSignature = sig;

      codeEl.textContent = code ? `#${code}` : "#····";

      syncPodiums(state, selfId);
      syncRoster(state, selfId);
      paintColorGrid(state, selfId);

      // Host rules mirror the server; non-hosts see them locked.
      markSelected(roundsEl, state.totalRounds);
      markSelected(livesEl, state.livesPerRound);
      markSelected(mapEl, state.mapId);
      mapBlurbEl.textContent = getMap(state.mapId).blurb;
      if (!editingStake && stakeEl.value !== state.stake) stakeEl.value = state.stake;
      stakeEl.readOnly = !isHost;
      rulesNoteEl.textContent = isHost
        ? "You're the host — these apply to everyone."
        : "The host sets the rules for this room.";

      // Ready button.
      readyBtn.textContent = selfReady ? "Ready ✓" : "Ready up";
      readyBtn.classList.toggle("is-on", selfReady);

      // Host start button — live only once the whole room has readied up.
      const canStart = isHost && allReady;
      startBtn.hidden = !canStart;
      startBtn.textContent = solo ? "Start solo" : "Start match";

      // Status line + the "everyone ready" banner over the floor.
      if (allReady) {
        countBannerEl.hidden = false;
        countBannerEl.textContent = solo
          ? "Flying solo — start when ready"
          : "Everyone's ready!";
        countBannerEl.classList.add("is-hot");
      } else {
        countBannerEl.hidden = true;
        countBannerEl.classList.remove("is-hot");
      }

      statusEl.textContent = allReady
        ? isHost
          ? "Start the match whenever you are."
          : "Waiting for the host to start…"
        : `${readyCount}/${total} ready`;

      rosterCountEl.textContent = `${total}/${MAX_PLAYERS}`;
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
    onSetColor(handler) {
      setColorHandler = handler;
    },
    onReady(handler) {
      readyHandler = handler;
    },
    onStart(handler) {
      startHandler = handler;
    },
    onLeave(handler) {
      leaveHandler = handler;
    },
    notifyColorRejected(colorId) {
      const cell = colorCells.get(colorId);
      if (cell) {
        cell.root.classList.add("is-rejected");
        window.setTimeout(() => cell.root.classList.remove("is-rejected"), 700);
      }
      // The next `update()` resyncs `selfColorId` to whatever the server still
      // has for us; nothing to undo here beyond the flash.
      toast(`${lobbyColorName(colorId)} was just taken`, "warn");
    },
  };
}
