import {
  DEFAULT_HAT,
  HATS,
  WARDROBE_COLORS,
  isHatId,
  isHexColor,
} from "@stickstakes/shared";

/**
 * The wardrobe: a skin colour and a hat, both cosmetic. The same control is
 * mounted twice — once on the landing screen (so your pick rides in on the
 * join) and once in the lobby (so you can change it while you wait). Both write
 * through to `localStorage`, so the next visit remembers you.
 */

export interface WardrobeChoice {
  color: string;
  hat: string;
}

const COLOR_KEY = "stickstakes:color";
const HAT_KEY = "stickstakes:hat";

/** Last saved pick, or a sensible default. `fallbackColor` is the slot colour. */
export function loadWardrobe(fallbackColor: string): WardrobeChoice {
  let color = fallbackColor;
  let hat = DEFAULT_HAT;
  try {
    const savedColor = localStorage.getItem(COLOR_KEY);
    if (isHexColor(savedColor)) color = savedColor.toLowerCase();
    const savedHat = localStorage.getItem(HAT_KEY);
    if (isHatId(savedHat)) hat = savedHat;
  } catch {
    /* private mode — just use the defaults */
  }
  return { color, hat };
}

function saveWardrobe(choice: WardrobeChoice): void {
  try {
    localStorage.setItem(COLOR_KEY, choice.color);
    localStorage.setItem(HAT_KEY, choice.hat);
  } catch {
    /* private mode — nothing to persist to */
  }
}

export interface WardrobeControl {
  value(): WardrobeChoice;
  onChange(handler: (choice: WardrobeChoice) => void): void;
  /**
   * Reflect an outside pick (e.g. server truth for this player) without
   * firing `onChange` or writing to storage. A no-op once the player has
   * touched the control, so it never yanks a choice out from under them.
   */
  sync(choice: WardrobeChoice): void;
}

/**
 * Build the swatch grid into `colorsEl` and the hat chips into `hatsEl`.
 * Fires `onChange` with the full pick whenever either changes, and persists.
 */
export function mountWardrobe(
  colorsEl: HTMLElement,
  hatsEl: HTMLElement,
  initial: WardrobeChoice,
): WardrobeControl {
  const current: WardrobeChoice = { ...initial };
  let handler: ((choice: WardrobeChoice) => void) | undefined;
  let touched = false;

  const swatches = WARDROBE_COLORS.map((color) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.style.background = color;
    btn.setAttribute("aria-label", color);
    btn.addEventListener("click", () => {
      current.color = color;
      commit();
    });
    return { btn, color };
  });

  // Full-range picker for anyone who wants a colour not on the grid.
  const custom = document.createElement("input");
  custom.type = "color";
  custom.className = "wardrobe-custom";
  custom.title = "Custom colour";
  custom.addEventListener("input", () => {
    current.color = custom.value.toLowerCase();
    commit();
  });

  colorsEl.replaceChildren(...swatches.map((s) => s.btn), custom);

  const hats = HATS.map((hat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = hat.label;
    btn.addEventListener("click", () => {
      current.hat = hat.id;
      commit();
    });
    return { btn, id: hat.id };
  });
  hatsEl.replaceChildren(...hats.map((h) => h.btn));

  function paint(): void {
    const onGrid = WARDROBE_COLORS.includes(current.color);
    for (const s of swatches) s.btn.classList.toggle("is-on", s.color === current.color);
    custom.classList.toggle("is-on", !onGrid);
    // A native colour input must hold a valid #rrggbb at all times.
    custom.value = isHexColor(current.color) ? current.color : "#ffffff";
    for (const h of hats) h.btn.classList.toggle("is-on", h.id === current.hat);
  }

  function commit(): void {
    touched = true;
    paint();
    saveWardrobe(current);
    handler?.({ ...current });
  }

  paint();

  return {
    value: () => ({ ...current }),
    onChange: (fn) => {
      handler = fn;
    },
    sync: (choice) => {
      if (touched) return;
      if (isHexColor(choice.color)) current.color = choice.color.toLowerCase();
      if (isHatId(choice.hat)) current.hat = choice.hat;
      paint();
    },
  };
}
