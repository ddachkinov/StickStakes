import type { InputIntent } from "@stickstakes/shared";

/**
 * Two thumbs, two ideas: the left half of the screen steers, the right half
 * has exactly two buttons. Hitboxes are deliberately huge — people play this
 * one-handed, standing up, holding a menu in the other hand.
 */

export interface ControlZone {
  id: "left" | "right" | "jump" | "attack";
  label: string;
  /** Screen-space circle, in CSS pixels. */
  cx: number;
  cy: number;
  r: number;
}

export interface InputSource {
  /** Current intent. Read once per fixed step, never mutated by the caller. */
  readonly intent: InputIntent;
  /** Screen-space buttons for the renderer to draw. Recomputed on resize. */
  readonly zones: readonly ControlZone[];
  /** Which zones are lit right now, for touch feedback. */
  readonly active: ReadonlySet<ControlZone["id"]>;
  layout(width: number, height: number): void;
  destroy(): void;
}

export function createInput(target: HTMLElement): InputSource {
  const intent: InputIntent = { left: false, right: false, jump: false, attack: false };

  let zones: ControlZone[] = [];
  const active = new Set<ControlZone["id"]>();
  /** Which zone each active touch is currently inside. */
  const touches = new Map<number, ControlZone["id"]>();
  const keys = new Set<string>();

  function layout(width: number, height: number): void {
    // Scale the controls with the screen, but keep them thumb-sized on a phone.
    const unit = Math.min(width, height);
    const r = Math.max(38, Math.min(72, unit * 0.13));
    const pad = r * 0.75;
    const y = height - pad - r;

    zones = [
      { id: "left", label: "◀", cx: pad + r, cy: y, r },
      { id: "right", label: "▶", cx: pad + r * 3.3, cy: y, r },
      { id: "attack", label: "✦", cx: width - pad - r * 3.3, cy: y, r },
      { id: "jump", label: "▲", cx: width - pad - r, cy: y, r },
    ];
  }

  function zoneAt(x: number, y: number): ControlZone | undefined {
    let best: ControlZone | undefined;
    let bestDist = Infinity;
    for (const zone of zones) {
      const dx = x - zone.cx;
      const dy = y - zone.cy;
      const dist = Math.hypot(dx, dy);
      // 1.35x the drawn radius: forgiving, and forgiving is the point.
      if (dist < zone.r * 1.35 && dist < bestDist) {
        best = zone;
        bestDist = dist;
      }
    }
    return best;
  }

  function recompute(): void {
    active.clear();
    for (const id of touches.values()) active.add(id);

    intent.left = active.has("left") || keys.has("ArrowLeft") || keys.has("KeyA");
    intent.right = active.has("right") || keys.has("ArrowRight") || keys.has("KeyD");
    intent.jump =
      active.has("jump") || keys.has("Space") || keys.has("ArrowUp") || keys.has("KeyW");
    intent.attack = active.has("attack") || keys.has("KeyJ") || keys.has("ShiftLeft");
  }

  function onPointerDown(event: PointerEvent): void {
    const zone = zoneAt(event.clientX, event.clientY);
    if (!zone) return;
    target.setPointerCapture?.(event.pointerId);
    touches.set(event.pointerId, zone.id);
    recompute();
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!touches.has(event.pointerId)) return;
    // Sliding between left and right must not require lifting the thumb.
    const zone = zoneAt(event.clientX, event.clientY);
    if (zone) touches.set(event.pointerId, zone.id);
    else touches.delete(event.pointerId);
    recompute();
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!touches.delete(event.pointerId)) return;
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
    touches.clear();
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
