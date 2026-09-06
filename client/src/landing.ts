import {
  MAX_NAME_LENGTH,
  PLAYER_COLORS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "@stickstakes/shared";
import { createFighterShowcase } from "./figure.js";
import { loadWardrobe, mountWardrobe } from "./wardrobe.js";

/**
 * The screen before the fight: pick a name and a look, then create a game or
 * join one by code. Nothing else in the app runs until this resolves —
 * `main()` awaits it.
 */

export interface LandingResult {
  name: string;
  /** Empty when creating a new game. */
  code: string;
  /** Wardrobe pick, carried into the join options. */
  color: string;
  hat: string;
}

const NAME_KEY = "stickstakes:name";

/** Strip anything that isn't in the code alphabet, and upper-case the rest. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((ch) => ROOM_CODE_ALPHABET.includes(ch))
    .join("")
    .slice(0, ROOM_CODE_LENGTH);
}

/** A code sitting in the URL (`?code=ABCD`) — the shareable-link path in. */
export function codeFromUrl(): string {
  return normalizeCode(new URLSearchParams(location.search).get("code") ?? "");
}

export interface Landing {
  /** Resolves once the player has chosen create-or-join. */
  choose(): Promise<LandingResult>;
  /** Put the screen back up with an error — a bad code, a full room. */
  reject(message: string): void;
  hide(): void;
}

export function createLanding(root: ParentNode = document): Landing {
  const el = root.querySelector<HTMLElement>("#landing")!;
  const form = root.querySelector<HTMLFormElement>("#landing-card")!;
  const nameEl = root.querySelector<HTMLInputElement>("#landing-name")!;
  const codeEl = root.querySelector<HTMLInputElement>("#landing-code")!;
  const createBtn = root.querySelector<HTMLButtonElement>("#landing-create")!;
  const joinBtn = root.querySelector<HTMLButtonElement>("#landing-join")!;
  const errorEl = root.querySelector<HTMLElement>("#landing-error")!;
  const wardrobeColorsEl = root.querySelector<HTMLElement>("#wardrobe-colors")!;
  const wardrobeHatsEl = root.querySelector<HTMLElement>("#wardrobe-hats")!;
  const fighterCanvas = root.querySelector<HTMLCanvasElement>("#landing-fighter")!;

  nameEl.value = localStorage.getItem(NAME_KEY) ?? "";
  codeEl.value = codeFromUrl();

  // Default to the first slot colour until the player picks; `mountWardrobe`
  // reads any remembered choice out of localStorage over the top of it.
  const initialLook = loadWardrobe(PLAYER_COLORS[0]!);
  const wardrobe = mountWardrobe(wardrobeColorsEl, wardrobeHatsEl, initialLook);

  // A live preview of the fighter you're about to join as.
  const showcase = createFighterShowcase(fighterCanvas, wardrobe.value());
  wardrobe.onChange((choice) => showcase.set(choice.color, choice.hat));

  // Keep the code field always in the alphabet, so a typed "0" or "l" can't
  // silently become an unjoinable code.
  codeEl.addEventListener("input", () => {
    const cleaned = normalizeCode(codeEl.value);
    if (cleaned !== codeEl.value) codeEl.value = cleaned;
  });

  let settle: ((result: LandingResult) => void) | undefined;

  function playerName(): string {
    const typed = nameEl.value.trim().slice(0, MAX_NAME_LENGTH);
    const name = typed || `P${Math.floor(Math.random() * 90 + 10)}`;
    localStorage.setItem(NAME_KEY, name);
    return name;
  }

  function busy(on: boolean): void {
    createBtn.disabled = on;
    joinBtn.disabled = on;
    el.classList.toggle("is-busy", on);
  }

  createBtn.addEventListener("click", () => {
    errorEl.textContent = "";
    busy(true);
    const { color, hat } = wardrobe.value();
    settle?.({ name: playerName(), code: "", color, hat });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = normalizeCode(codeEl.value);
    if (code.length !== ROOM_CODE_LENGTH) {
      errorEl.textContent = `A room code is ${ROOM_CODE_LENGTH} letters.`;
      codeEl.focus();
      return;
    }
    errorEl.textContent = "";
    busy(true);
    const { color, hat } = wardrobe.value();
    settle?.({ name: playerName(), code, color, hat });
  });

  return {
    choose() {
      el.hidden = false;
      busy(false);
      // A link with a code in it means they were invited — put the cursor
      // where they need it, which is usually "just press Join".
      (codeEl.value ? joinBtn : nameEl).focus?.();
      return new Promise<LandingResult>((resolve) => {
        settle = resolve;
      });
    },
    reject(message) {
      el.hidden = false;
      busy(false);
      errorEl.textContent = message;
    },
    hide() {
      el.hidden = true;
      // The landing screen is done for the session — stop its animation loop.
      showcase.stop();
    },
  };
}
