import type { InputIntent } from "@stickstakes/shared";

/**
 * Two thumbs, two ideas.
 *
 * LEFT half: an invisible floating stick. Put a thumb down anywhere in it and
 * that spot becomes the origin; drag right of the origin to run right, left to
 * run left. Nothing is drawn until you touch it, so the whole left half of the
 * arena stays visible while you play.
 *
 * RIGHT half: two real buttons, jump and attack. That's the lot — two buttons,
 * maximum, with deliberately huge hitboxes, because people play this one-handed
 * while standing up.
 */

export interface ControlZone {
  id: "jump" | "attack";
  label: string;
  /** Screen-space circle, in CSS pixels. */
  cx: number;
  cy: number;
  r: number;
}

/** Live state of the floating stick, for the renderer's touch feedback. */
export interface StickState {
  active: boolean;
  /** Where the thumb landed (and where it trails to, once dragged far). */
  originX: number;
  originY: number;
  /** Where the thumb is now. */
  x: number;
  y: number;
}

export interface InputSource {
  /** Current intent. Read once per fixed step, never mutated by the caller. */
  readonly intent: InputIntent;
  /** Screen-space buttons for the renderer to draw. Recomputed on resize. */
  readonly zones: readonly ControlZone[];
  /** Which buttons are lit right now, for touch feedback. */
  readonly active: ReadonlySet<ControlZone["id"]>;
  readonly stick: Readonly<StickState>;
  layout(width: number, height: number): void;
  destroy(): void;
}

/** Thumb travel from the origin before the stickman commits to a direction. */
const STICK_DEADZONE = 9;
/**
 * Past this, the origin trails the thumb. Without it, a long drag to the right
 * would need an equally long drag back before you could turn around; with it,
 * reversing always costs the same short flick.
 *
 * Exported because it is also the radius the renderer draws the stick at — the
 * ring is exactly the distance the thumb can get from the origin.
 */
export const STICK_MAX_OFFSET = 46;

export function createInput(target: HTMLElement): InputSource {
  const intent: InputIntent = { left: false, right: false, jump: false, attack: false };

  let zones: ControlZone[] = [];
  /** Right edge of the steering half, in CSS pixels. */
  let stickRegionWidth = 0;

  const active = new Set<ControlZone["id"]>();
  /** Which button each active touch is currently inside. */
  const buttonTouches = new Map<number, ControlZone["id"]>();
  const keys = new Set<string>();

  const stick: StickState = { active: false, originX: 0, originY: 0, x: 0, y: 0 };
  /** The one pointer that owns the stick, if any. */
  let stickPointer: number | null = null;

  function layout(width: number, height: number): void {
    // Scale the buttons with the screen, but keep them thumb-sized on a phone.
    const unit = Math.min(width, height);
    const r = Math.max(38, Math.min(72, unit * 0.13));
    const pad = r * 0.75;
    const y = height - pad - r;

    zones = [
      { id: "attack", label: "✦", cx: width - pad - r * 3.3, cy: y, r },
      { id: "jump", label: "▲", cx: width - pad - r, cy: y, r },
    ];

    // Steer from the left half — but never let it reach under a button.
    const leftmostButton = Math.min(...zones.map((z) => z.cx - z.r * 1.35));
    stickRegionWidth = Math.min(width * 0.5, leftmostButton);
  }

  function zoneAt(x: number, y: number): ControlZone | undefined {
    let best: ControlZone | undefined;
    let bestDist = Infinity;
    for (const zone of zones) {
      const dist = Math.hypot(x - zone.cx, y - zone.cy);
      // 1.35x the drawn radius: forgiving, and forgiving is the point.
      if (dist < zone.r * 1.35 && dist < bestDist) {
        best = zone;
        bestDist = dist;
      }
    }
    return best;
  }

  function releaseStick(): void {
    stickPointer = null;
    stick.active = false;
  }

  function recompute(): void {
    active.clear();
    for (const id of buttonTouches.values()) active.add(id);

    // The stick only ever reports a direction — movement speed is the server's
    // business, and the wire input is a pair of booleans either way.
    let stickLeft = false;
    let stickRight = false;
    if (stick.active) {
      const dx = stick.x - stick.originX;
      if (dx > STICK_DEADZONE) stickRight = true;
      else if (dx < -STICK_DEADZONE) stickLeft = true;
    }

    intent.left = stickLeft || keys.has("ArrowLeft") || keys.has("KeyA");
    intent.right = stickRight || keys.has("ArrowRight") || keys.has("KeyD");
    intent.jump =
      active.has("jump") || keys.has("Space") || keys.has("ArrowUp") || keys.has("KeyW");
    intent.attack = active.has("attack") || keys.has("KeyJ") || keys.has("ShiftLeft");
  }

  function onPointerDown(event: PointerEvent): void {
    const zone = zoneAt(event.clientX, event.clientY);
    if (zone) {
      target.setPointerCapture?.(event.pointerId);
      buttonTouches.set(event.pointerId, zone.id);
      recompute();
      event.preventDefault();
      return;
    }

    // Anywhere in the steering half becomes the stick's origin. First touch
    // wins; a second thumb over there is ignored rather than hijacking it.
    if (stickPointer === null && event.clientX <= stickRegionWidth) {
      target.setPointerCapture?.(event.pointerId);
      stickPointer = event.pointerId;
      stick.active = true;
      stick.originX = event.clientX;
      stick.originY = event.clientY;
      stick.x = event.clientX;
      stick.y = event.clientY;
      recompute();
      event.preventDefault();
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId === stickPointer) {
      stick.x = event.clientX;
      stick.y = event.clientY;

      // Drag far enough and the origin follows, so you can run the full width
      // of the arena on one thumb and still turn around instantly.
      const dx = stick.x - stick.originX;
      if (dx > STICK_MAX_OFFSET) stick.originX = stick.x - STICK_MAX_OFFSET;
      else if (dx < -STICK_MAX_OFFSET) stick.originX = stick.x + STICK_MAX_OFFSET;
      stick.originY = stick.y;

      recompute();
      event.preventDefault();
      return;
    }

    if (!buttonTouches.has(event.pointerId)) return;
    // Sliding between jump and attack must not require lifting the thumb.
    const zone = zoneAt(event.clientX, event.clientY);
    if (zone) buttonTouches.set(event.pointerId, zone.id);
    else buttonTouches.delete(event.pointerId);
    recompute();
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId === stickPointer) {
      releaseStick();
      recompute();
      event.preventDefault();
      return;
    }
    if (!buttonTouches.delete(event.pointerId)) return;
    recompute();
    event.preventDefault();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return;
    keys.add(event.code);
    recompute();
  }

  function onKeyUp(event: KeyboardEvent): void {
    keys.delete(event.code);
    recompute();
  }

  /** A backgrounded tab must not leave a key or thumb stuck down. */
  function releaseAll(): void {
    keys.clear();
    buttonTouches.clear();
    releaseStick();
    recompute();
  }

  target.addEventListener("pointerdown", onPointerDown);
  target.addEventListener("pointermove", onPointerMove);
  target.addEventListener("pointerup", onPointerUp);
  target.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);

  layout(window.innerWidth, window.innerHeight);

  return {
    intent,
    get zones() {
      return zones;
    },
    active,
    stick,
    layout,
    destroy() {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
    },
  };
}
