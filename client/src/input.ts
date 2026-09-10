import type { InputIntent } from "@stickstakes/shared";

/**
 * Two thumbs, two ideas.
 *
 * LEFT half: an invisible stick that plants itself wherever your thumb first
 * lands. That spot is the origin and it stays put — drag right of it to run
 * right, left to run left. Nothing is drawn until you touch it, so the whole
 * left half of the arena stays visible while you play.
 *
 * RIGHT half: two real buttons, jump and attack. That's the lot — two buttons,
 * maximum, with deliberately huge hitboxes, because people play this one-handed
 * while standing up.
 *
 * The hard part is not planting the stick, it is being *certain* it comes back
 * up. A missed `pointerup` leaves a direction latched and the stickman walks
 * into a wall until you touch the screen again — so every path that can take a
 * pointer away from us (lost capture, a backgrounded tab, a re-used pointer id,
 * an overlay opening) releases it explicitly. See `sweep()`.
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
  /**
   * Off while a panel or the pause menu owns the screen: every held control is
   * dropped and nothing new can be planted until it comes back on.
   */
  setEnabled(on: boolean): void;
  /**
   * Called once a frame. Drops any control whose pointer has quietly gone away
   * — the browser is not obliged to deliver the `pointerup` we are waiting for.
   */
  sweep(): void;
  /** Let go of everything, right now. */
  releaseAll(): void;
  destroy(): void;
}

/** Thumb travel from the origin before the stickman commits to a direction. */
const STICK_DEADZONE = 9;
/**
 * How far the thumb can get from the origin before its reported position is
 * clamped back onto this radius. The origin itself never moves once planted,
 * so the stick stays where you first touched down instead of sliding across
 * the screen — reversing is always the same short flick back through centre.
 *
 * Exported because it is also the radius the renderer draws the stick at — the
 * ring is exactly the distance the thumb can get from the origin.
 */
export const STICK_MAX_OFFSET = 46;

/** Is this key event the player driving, or someone typing their name? */
function isTyping(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  if (!el || el === document.body) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

export function createInput(target: HTMLElement): InputSource {
  const intent: InputIntent = { left: false, right: false, jump: false, attack: false };

  let zones: ControlZone[] = [];
  /** Right edge of the steering half, in CSS pixels. */
  let stickRegionWidth = 0;
  /** False while a panel owns the screen; no control may be held. */
  let enabled = true;

  const active = new Set<ControlZone["id"]>();
  /** Which button each active touch is currently inside. */
  const buttonTouches = new Map<number, ControlZone["id"]>();
  const keys = new Set<string>();
  /**
   * Pointers the browser confirmed we captured. Only these can be swept: for a
   * captured pointer, "capture is gone" means "the pointer is gone", which is
   * exactly the signal `sweep()` needs. A pointer we could not capture is left
   * alone — releasing it on a timer would drop a thumb that is simply resting.
   */
  const captured = new Set<number>();

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
    if (stickPointer !== null) captured.delete(stickPointer);
    stickPointer = null;
    stick.active = false;
    // Collapse the stick onto its origin too, so a stale offset can never be
    // read back by anything that looks at the state without checking `active`.
    stick.x = stick.originX;
    stick.y = stick.originY;
  }

  /** Forget one pointer, whichever control it happened to own. */
  function releasePointer(pointerId: number): boolean {
    let had = false;
    if (pointerId === stickPointer) {
      releaseStick();
      had = true;
    }
    if (buttonTouches.delete(pointerId)) had = true;
    captured.delete(pointerId);
    return had;
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

  /**
   * Take ownership of a pointer. Capture is what makes a drag off the edge of
   * the element keep working — and, once granted, it doubles as a liveness
   * check: the browser drops capture when the pointer goes away, whether or not
   * it bothers to deliver the `pointerup`.
   */
  function capture(pointerId: number): void {
    try {
      target.setPointerCapture?.(pointerId);
      if (target.hasPointerCapture?.(pointerId)) captured.add(pointerId);
    } catch {
      // Pointer already gone, or capture refused. Not sweepable; the ordinary
      // up / cancel / visibility paths still cover it.
    }
  }

  /** Does the browser still say this captured pointer is ours? */
  function stillHeld(pointerId: number): boolean {
    if (!captured.has(pointerId)) return true; // nothing reliable to test
    try {
      return target.hasPointerCapture(pointerId);
    } catch {
      return false;
    }
  }

  /**
   * The safety net. A `pointerup` can go missing — an OS gesture eats it, the
   * page is backgrounded mid-drag, a browser drops capture silently — and the
   * cost of missing one is a stickman that runs in one direction forever. So
   * once a frame, check that every control we think is held is still real.
   */
  function sweep(): void {
    if (captured.size === 0) return;
    let changed = false;

    if (stickPointer !== null && !stillHeld(stickPointer)) {
      releaseStick();
      changed = true;
    }
    for (const pointerId of [...buttonTouches.keys()]) {
      if (stillHeld(pointerId)) continue;
      buttonTouches.delete(pointerId);
      captured.delete(pointerId);
      changed = true;
    }

    if (changed) recompute();
  }

  function onPointerDown(event: PointerEvent): void {
    if (!enabled) return;

    // A pointer id we already hold is coming down again: the matching up never
    // arrived. Drop the stale hold rather than ignoring the new touch, which
    // would leave the old direction latched with nothing on screen to explain
    // it. Pointer ids are recycled on mobile, so this happens for real.
    releasePointer(event.pointerId);

    const zone = zoneAt(event.clientX, event.clientY);
    if (zone) {
      capture(event.pointerId);
      buttonTouches.set(event.pointerId, zone.id);
      recompute();
      event.preventDefault();
      return;
    }

    // Anywhere in the steering half becomes the stick's origin. First touch
    // wins; a second thumb over there is ignored rather than hijacking it.
    if (stickPointer === null && event.clientX <= stickRegionWidth) {
      capture(event.pointerId);
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
      // The origin is pinned where the thumb first landed. Track the thumb,
      // but never let the reported position leave the ring — a drag to the far
      // edge of the screen still reads as "full right", from the same spot.
      const dx = event.clientX - stick.originX;
      const dy = event.clientY - stick.originY;
      const dist = Math.hypot(dx, dy);
      if (dist > STICK_MAX_OFFSET) {
        const scale = STICK_MAX_OFFSET / dist;
        stick.x = stick.originX + dx * scale;
        stick.y = stick.originY + dy * scale;
      } else {
        stick.x = event.clientX;
        stick.y = event.clientY;
      }

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
    if (!releasePointer(event.pointerId)) return;
    recompute();
    event.preventDefault();
  }

  /**
   * Capture went away without an up: the browser has taken the pointer back
   * (an OS gesture, an overlay, the element losing the pointer entirely). It
   * is not coming back, so let go now instead of waiting for `sweep()`.
   */
  function onLostCapture(event: PointerEvent): void {
    if (!releasePointer(event.pointerId)) return;
    recompute();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || isTyping(event)) return;
    keys.add(event.code);
    recompute();
  }

  function onKeyUp(event: KeyboardEvent): void {
    // No `isTyping` guard here on purpose: a key that got as far as `keys` has
    // to be removable, even if focus moved into a text field while it was down.
    if (!keys.delete(event.code)) return;
    recompute();
  }

  /** A backgrounded tab must not leave a key or thumb stuck down. */
  function releaseAll(): void {
    keys.clear();
    buttonTouches.clear();
    captured.clear();
    releaseStick();
    recompute();
  }

  /**
   * Hidden, frozen, or on the way out. `visibilitychange` is the one that
   * actually fires when a phone goes to the home screen mid-drag — `blur`
   * alone is not enough, and that is where stuck sticks come from.
   */
  function onVisibility(): void {
    if (document.visibilityState === "hidden") releaseAll();
  }

  target.addEventListener("pointerdown", onPointerDown);
  target.addEventListener("pointermove", onPointerMove);
  target.addEventListener("pointerup", onPointerUp);
  target.addEventListener("pointercancel", onPointerUp);
  target.addEventListener("lostpointercapture", onLostCapture);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);
  window.addEventListener("pagehide", releaseAll);
  document.addEventListener("visibilitychange", onVisibility);

  layout(window.innerWidth, window.innerHeight);

  return {
    intent,
    get zones() {
      return zones;
    },
    active,
    stick,
    layout,
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      // Going off drops everything; coming back on starts from nothing held,
      // so a thumb that was down while a panel was up has to lift and re-plant.
      releaseAll();
    },
    sweep,
    releaseAll,
    destroy() {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
      target.removeEventListener("lostpointercapture", onLostCapture);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("pagehide", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
