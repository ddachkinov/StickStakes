import { MAX_NAME_LENGTH, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@stickstakes/shared";

/**
 * The screen before the fight: pick a name, then create a game or join one by
 * code. Nothing else in the app runs until this resolves — `main()` awaits it.
 */

export interface LandingResult {
  name: string;
  /** Empty when creating a new game. */
  code: string;
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

  nameEl.value = localStorage.getItem(NAME_KEY) ?? "";
  codeEl.value = codeFromUrl();

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
    settle?.({ name: playerName(), code: "" });
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
    settle?.({ name: playerName(), code });
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
    },
  };
}
