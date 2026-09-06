import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
} from "@stickstakes/shared";
import type {
  Hazard,
  ParallaxLayer,
  ParallaxObject,
  Solid,
  WorldMap,
} from "@stickstakes/shared";
import { STICK_MAX_OFFSET, type ControlZone, type StickState } from "./input.js";
import { drawHat } from "./figure.js";
import type { Particle } from "./fx.js";

/**
 * Where the parallax layers are looking. `x`/`y` are the camera's offset from
 * the arena centre — it trails your own fighter — and `t` is seconds, for the
 * drifting and spinning bits. Every layer multiplies this by its own `depth`,
 * so far things barely stir and foreground things race the fight.
 */
export interface WorldCamera {
  x: number;
  y: number;
  t: number;
}

/** Tiny deterministic PRNG so a scatter field (stars, rain) doesn't shimmer. */
function seeded(seed: number): () => number {
  let s = (seed || 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Wrap a drifting x back into a band a bit wider than the arena. */
function wrapX(x: number, pad: number): number {
  const span = ARENA_WIDTH + pad * 2;
  let r = (x + pad) % span;
  if (r < 0) r += span;
  return r - pad;
}

/**
 * Canvas renderer. The arena is a fixed 960x540 world that gets letterboxed
 * into whatever screen it lands on, so every phone sees the same fight.
 */

export interface Stickman {
  x: number;
  y: number;
  facing: number;
  grounded: boolean;
  color: string;
  /** Wardrobe hat id — one of the ids in shared `HATS`. */
  hat: string;
  name: string;
  isSelf: boolean;
  /** Lives left, and the round's maximum — drawn as pips above the name. */
  lives: number;
  maxLives: number;
  /** Show the pips at all (false in the lobby, where lives are meaningless). */
  showLives: boolean;
  /** 0..1 through the attack swing; 0 means not swinging. */
  swing: number;
  /** Fresh-spawn invulnerability, drawn as a flicker. */
  invulnerable: boolean;
  /** Damage taken this life, as a percentage. Drives the knockback, not death. */
  damage: number;
  /** In hitstun — drawn white, so a hit reads instantly. */
  stunned: boolean;
  /** Socket dropped, seat held for a reconnect — drawn faded. */
  disconnected?: boolean;
}

/**
 * Damage runs white → yellow → orange → red. The colour is the warning; the
 * number is the detail. You should be able to spot the player about to fly
 * without reading a digit.
 */
function damageColor(damage: number): string {
  if (damage >= 150) return "#ff5a5f";
  if (damage >= 100) return "#ff9f45";
  if (damage >= 50) return "#ffd166";
  return "#e8ecf1";
}

/** An upward chevron with a short stem — "jump", drawn in strokes. */
function drawJumpIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  ink: string,
): void {
  const s = r * 0.4;
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(2.5, r * 0.09);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - s, cy + s * 0.35);
  ctx.lineTo(cx, cy - s * 0.65);
  ctx.lineTo(cx + s, cy + s * 0.35);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.4);
  ctx.lineTo(cx, cy + s);
  ctx.stroke();
  ctx.restore();
}

/** A sharp four-point burst — "attack", the same shape as a hit spark. */
function drawAttackIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  ink: string,
): void {
  const outer = r * 0.52;
  const inner = outer * 0.38;
  ctx.save();
  ctx.fillStyle = ink;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 === 0 ? outer : inner;
    const px = cx + Math.cos(ang) * rad;
    const py = cy + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function require2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser has no 2d canvas context");
  return ctx;
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const ctx = require2d(canvas);

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let cssWidth = 0;
  let cssHeight = 0;

  /**
   * Per-frame allocation was the biggest avoidable cost in here. Every one of
   * these is built from immutable map data, so it is built once and kept:
   *
   *  - gradients keyed on the object (or the map) they decorate — `createLinear`
   *    / `createRadialGradient` is one of the pricier canvas calls, and none of
   *    these depend on canvas size (they are all in arena units);
   *  - scatter fields (`starfield`, `skyline`, `rain`, `embers`) whose seeded
   *    PRNG produced the same points every frame — now generated once into a
   *    typed array, with only the animated offset applied per frame.
   *
   * `WeakMap` so a map the player never revisits lets its caches go.
   */
  const bandGradients = new WeakMap<ParallaxObject, CanvasGradient>();
  const moonGlowGradients = new WeakMap<ParallaxObject, CanvasGradient>();
  const skyGradients = new WeakMap<WorldMap, CanvasGradient>();
  const zoneFills = new WeakMap<
    ControlZone,
    { readonly lit: CanvasGradient; readonly off: CanvasGradient }
  >();
  /** `[sx, sy, r, alpha]` per star. */
  const starFields = new WeakMap<ParallaxObject, Float32Array>();
  /** `[bx, by, w, h]` runs for the buildings, then the same for lit windows. */
  const skylineFields = new WeakMap<
    ParallaxObject,
    { readonly buildings: Float32Array; readonly windows: Float32Array }
  >();
  /** `[baseX, baseY]` per drop; the fall offset is applied per frame. */
  const rainFields = new WeakMap<ParallaxObject, Float32Array>();
  /** `[baseX, baseY, r, alphaFactor]` per ember; drift + rise applied per frame. */
  const emberFields = new WeakMap<ParallaxObject, Float32Array>();

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = window.innerWidth;
    cssHeight = window.innerHeight;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    // Fit the arena, centred, preserving aspect.
    scale = Math.min(cssWidth / ARENA_WIDTH, cssHeight / ARENA_HEIGHT);
    offsetX = (cssWidth - ARENA_WIDTH * scale) / 2;
    offsetY = (cssHeight - ARENA_HEIGHT * scale) / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return;
  }

  /**
   * Everything drawn between `beginWorld` and `endWorld` is in arena units.
   *
   * Screen shake is applied here, in SCREEN pixels rather than arena units, so
   * a hit kicks the camera the same visible distance on a phone as on a laptop
   * instead of scaling with the letterbox.
   */
  function beginWorld(shakeX = 0, shakeY = 0): void {
    ctx.save();
    ctx.translate(offsetX + shakeX, offsetY + shakeY);
    ctx.scale(scale, scale);
  }

  function endWorld(): void {
    ctx.restore();
  }

  function clear(): void {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "#0e1116";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  /** One decorative parallax object, already translated into its layer's frame. */
  function drawShape(o: ParallaxObject, t: number): void {
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.fillStyle = o.color;
    ctx.strokeStyle = o.color;

    switch (o.shape) {
      case "band": {
        if (o.accent && o.accent !== o.color) {
          let g = bandGradients.get(o);
          if (!g) {
            g = ctx.createLinearGradient(0, o.y, 0, o.y + o.h);
            g.addColorStop(0, o.color);
            g.addColorStop(1, o.accent);
            bandGradients.set(o, g);
          }
          ctx.fillStyle = g;
        }
        ctx.fillRect(o.x, o.y, o.w, o.h);
        break;
      }
      case "moon": {
        const r = o.w / 2;
        let glow = moonGlowGradients.get(o);
        if (!glow) {
          glow = ctx.createRadialGradient(o.x, o.y, r * 0.4, o.x, o.y, r * 2.4);
          glow.addColorStop(0, o.color);
          glow.addColorStop(1, "rgba(0,0,0,0)");
          moonGlowGradients.set(o, glow);
        }
        ctx.globalAlpha = (o.alpha ?? 1) * 0.4;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(o.x, o.y, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = o.alpha ?? 1;
        ctx.fillStyle = o.color;
        ctx.beginPath();
        ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (o.accent) {
          ctx.fillStyle = o.accent;
          ctx.globalAlpha = (o.alpha ?? 1) * 0.5;
          ctx.beginPath();
          ctx.arc(o.x + r * 0.35, o.y - r * 0.2, r * 0.28, 0, Math.PI * 2);
          ctx.arc(o.x - r * 0.3, o.y + r * 0.3, r * 0.16, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "mountain": {
        ctx.beginPath();
        ctx.moveTo(o.x - o.w / 2, o.y);
        ctx.lineTo(o.x, o.y - o.h);
        ctx.lineTo(o.x + o.w / 2, o.y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "mesa": {
        const top = o.w * 0.55;
        ctx.beginPath();
        ctx.moveTo(o.x - o.w / 2, o.y);
        ctx.lineTo(o.x - top / 2, o.y - o.h);
        ctx.lineTo(o.x + top / 2, o.y - o.h);
        ctx.lineTo(o.x + o.w / 2, o.y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "hill": {
        ctx.beginPath();
        ctx.moveTo(o.x - o.w / 2, o.y);
        ctx.quadraticCurveTo(o.x, o.y - o.h * 2, o.x + o.w / 2, o.y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "cloud": {
        const puffs: readonly [number, number, number][] = [
          [-o.w * 0.3, 0, o.h * 0.6],
          [0, -o.h * 0.2, o.h],
          [o.w * 0.32, 0, o.h * 0.7],
        ];
        for (const [dx, dy, r] of puffs) {
          ctx.beginPath();
          ctx.arc(o.x + dx, o.y + dy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "tree": {
        ctx.fillRect(o.x - o.w * 0.12, o.y - o.h, o.w * 0.24, o.h);
        ctx.beginPath();
        ctx.moveTo(o.x - o.w / 2, o.y - o.h * 0.5);
        ctx.lineTo(o.x, o.y - o.h * 1.5);
        ctx.lineTo(o.x + o.w / 2, o.y - o.h * 0.5);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "spire": {
        ctx.beginPath();
        ctx.moveTo(o.x - o.w / 2, o.y);
        ctx.lineTo(o.x - o.w * 0.12, o.y - o.h);
        ctx.lineTo(o.x + o.w * 0.12, o.y - o.h);
        ctx.lineTo(o.x + o.w / 2, o.y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "boulder": {
        ctx.beginPath();
        ctx.ellipse(o.x, o.y, o.w / 2, o.h / 2, 0, Math.PI, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(o.x - o.w * 0.18, o.y, o.w * 0.28, o.h * 0.42, 0, Math.PI, 0);
        ctx.fill();
        break;
      }
      case "building": {
        ctx.fillRect(o.x - o.w / 2, o.y - o.h, o.w, o.h);
        if (o.accent) {
          ctx.fillStyle = o.accent;
          for (let gy = o.y - o.h + 14; gy < o.y - 10; gy += 22) {
            for (let gx = o.x - o.w / 2 + 10; gx < o.x + o.w / 2 - 8; gx += 18) {
              if ((gx + gy) % 3 === 0) ctx.fillRect(gx, gy, 7, 10);
            }
          }
        }
        break;
      }
      case "skyline": {
        let field = skylineFields.get(o);
        if (!field) {
          const rnd = seeded(o.seed ?? 1);
          const buildings: number[] = [];
          const windows: number[] = [];
          let bx = o.x;
          while (bx < o.x + o.w) {
            const bw = 40 + rnd() * 70;
            const bh = o.h * (0.35 + rnd() * 0.65);
            buildings.push(bx, o.y - bh, bw - 6, bh);
            if (o.accent && o.accent !== o.color) {
              for (let wy = o.y - bh + 10; wy < o.y - 8; wy += 16) {
                for (let wx = bx + 6; wx < bx + bw - 12; wx += 12) {
                  if (rnd() > 0.62) windows.push(wx, wy, 4, 6);
                }
              }
            }
            bx += bw;
          }
          field = {
            buildings: new Float32Array(buildings),
            windows: new Float32Array(windows),
          };
          skylineFields.set(o, field);
        }
        const { buildings, windows } = field;
        ctx.fillStyle = o.color;
        for (let i = 0; i < buildings.length; i += 4) {
          ctx.fillRect(buildings[i]!, buildings[i + 1]!, buildings[i + 2]!, buildings[i + 3]!);
        }
        if (windows.length > 0) {
          ctx.fillStyle = o.accent!;
          for (let i = 0; i < windows.length; i += 4) {
            ctx.fillRect(windows[i]!, windows[i + 1]!, windows[i + 2]!, windows[i + 3]!);
          }
        }
        break;
      }
      case "starfield": {
        let pts = starFields.get(o);
        if (!pts) {
          const rnd = seeded(o.seed ?? 1);
          pts = new Float32Array(90 * 4);
          for (let i = 0; i < 90; i++) {
            pts[i * 4] = o.x + rnd() * o.w;
            pts[i * 4 + 1] = o.y + rnd() * o.h;
            pts[i * 4 + 2] = rnd() * 1.4 + 0.3;
            pts[i * 4 + 3] = 0.3 + rnd() * 0.7;
          }
          starFields.set(o, pts);
        }
        const base = o.alpha ?? 1;
        for (let i = 0; i < 90; i++) {
          const size = pts[i * 4 + 2]!;
          ctx.globalAlpha = base * pts[i * 4 + 3]!;
          ctx.fillRect(pts[i * 4]!, pts[i * 4 + 1]!, size, size);
        }
        break;
      }
      case "crane": {
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(o.x, o.y + o.h);
        ctx.lineTo(o.x, o.y);
        ctx.lineTo(o.x + o.w, o.y + o.h * 0.18);
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x + o.w * 0.28, o.y - o.h * 0.12);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(o.x + o.w * 0.78, o.y + o.h * 0.12);
        ctx.lineTo(o.x + o.w * 0.78, o.y + o.h * 0.42);
        ctx.stroke();
        break;
      }
      case "chain": {
        ctx.lineWidth = o.w;
        ctx.setLineDash([o.w * 1.6, o.w * 1.1]);
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x, o.y + o.h);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case "pipes": {
        ctx.lineWidth = 14;
        ctx.lineCap = "round";
        for (let i = 0; i < 3; i++) {
          const py = o.y + (i * o.h) / 3;
          ctx.beginPath();
          ctx.moveTo(o.x, py);
          ctx.lineTo(o.x + o.w * 0.7, py);
          ctx.lineTo(o.x + o.w, py + o.h * 0.25);
          ctx.stroke();
        }
        break;
      }
      case "arch": {
        ctx.beginPath();
        ctx.moveTo(o.x - o.w / 2, o.y);
        ctx.lineTo(o.x - o.w / 2, o.y - o.h * 0.5);
        ctx.quadraticCurveTo(o.x, o.y - o.h * 1.4, o.x + o.w / 2, o.y - o.h * 0.5);
        ctx.lineTo(o.x + o.w / 2, o.y);
        ctx.closePath();
        ctx.fill();
        if (o.accent) {
          ctx.globalAlpha = (o.alpha ?? 1) * 0.5;
          ctx.fillStyle = o.accent;
          ctx.beginPath();
          ctx.ellipse(o.x, o.y, o.w * 0.32, o.h * 0.32, 0, Math.PI, 0);
          ctx.fill();
        }
        break;
      }
      case "girderX": {
        ctx.fillRect(o.x, o.y, o.w, o.h);
        if (o.accent) {
          ctx.fillStyle = o.accent;
          for (let gx = o.x + 12; gx < o.x + o.w; gx += 46) {
            ctx.beginPath();
            ctx.moveTo(gx, o.y + 2);
            ctx.lineTo(gx + 20, o.y + o.h - 2);
            ctx.lineTo(gx + 40, o.y + 2);
            ctx.stroke();
          }
        }
        break;
      }
      case "rain": {
        let pts = rainFields.get(o);
        if (!pts) {
          const rnd = seeded(o.seed ?? 1);
          pts = new Float32Array(70 * 2);
          for (let i = 0; i < 70; i++) {
            pts[i * 2] = o.x + rnd() * o.w; // wrap + drift applied per frame
            pts[i * 2 + 1] = rnd() * o.h; // fall offset applied per frame
          }
          rainFields.set(o, pts);
        }
        const fall = t * 620;
        const drift = t * (o.drift ?? 0);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < 70; i++) {
          const rx = wrapX(pts[i * 2]! + drift, 60);
          const ry = (pts[i * 2 + 1]! + fall) % o.h;
          ctx.moveTo(rx, ry);
          ctx.lineTo(rx - 3, ry + 16);
        }
        ctx.stroke();
        break;
      }
      case "embers": {
        let pts = emberFields.get(o);
        if (!pts) {
          const rnd = seeded(o.seed ?? 1);
          pts = new Float32Array(46 * 4);
          for (let i = 0; i < 46; i++) {
            pts[i * 4] = o.x + rnd() * o.w;
            pts[i * 4 + 1] = rnd() * o.h;
            pts[i * 4 + 2] = rnd() * 1.8 + 0.6;
            pts[i * 4 + 3] = 0.4 + rnd() * 0.6;
          }
          emberFields.set(o, pts);
        }
        const rise = t * 46;
        const base = o.alpha ?? 1;
        for (let i = 0; i < 46; i++) {
          const ex = wrapX(pts[i * 4]! + Math.sin(t + i) * 12, 40);
          const ey = o.h - ((pts[i * 4 + 1]! + rise) % o.h);
          ctx.globalAlpha = base * pts[i * 4 + 3]!;
          ctx.beginPath();
          ctx.arc(ex, ey, pts[i * 4 + 2]!, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
    }
    ctx.restore();
  }

  /** One parallax layer: shift by depth × camera, then draw its objects. */
  function drawLayer(layer: ParallaxLayer, cam: WorldCamera): void {
    ctx.save();
    ctx.translate(-cam.x * layer.depth, -cam.y * layer.depth * 0.35);
    for (const o of layer.objects) {
      if (o.drift && o.shape !== "rain" && o.shape !== "embers") {
        const saved = o.x;
        // Non-field drifters (clouds) actually travel; field shapes handle
        // their own motion off `t` so their scatter stays put.
        drawShapeAt(o, saved + cam.t * o.drift, cam.t);
      } else {
        drawShape(o, cam.t);
      }
    }
    ctx.restore();
  }

  function drawShapeAt(o: ParallaxObject, x: number, t: number): void {
    drawShape({ ...o, x: wrapX(x, o.w + 80) }, t);
  }

  /** The map's solid geometry — platforms, beams, crates. */
  function drawSolids(map: WorldMap): void {
    for (const s of map.solids) {
      const fill =
        s.kind === "crate"
          ? "#6b5942"
          : s.kind === "girder"
            ? "#4a5568"
            : map.ink;
      ctx.fillStyle = fill;
      ctx.fillRect(s.x, s.y, s.width, s.height);

      // A lit top face reads as "you can stand here". One-way beams get a
      // thinner cap and a row of hangers so they look passable from below.
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(s.x, s.y, s.width, s.oneWay ? 2 : 4);

      if (s.oneWay) {
        ctx.strokeStyle = "rgba(255,255,255,0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let hx = s.x + 8; hx < s.x + s.width; hx += 22) {
          ctx.moveTo(hx, s.y + s.height);
          ctx.lineTo(hx, s.y + s.height + 4);
        }
        ctx.stroke();
      } else if (s.kind === "crate") {
        ctx.strokeStyle = "rgba(0,0,0,0.30)";
        ctx.lineWidth = 2;
        ctx.strokeRect(s.x + 3, s.y + 3, s.width - 6, s.height - 6);
      }
    }
  }

  /** Kill rectangles — spikes, saw blades. Drawn; never predicted. */
  function drawHazards(map: WorldMap, t: number): void {
    for (const h of map.hazards) drawHazard(h, t);
  }

  function drawHazard(h: Hazard, t: number): void {
    ctx.save();
    if (h.kind === "spikes") {
      ctx.fillStyle = h.color ?? "#c3ccd6";
      const n = Math.max(1, Math.round(h.width / 16));
      const step = h.width / n;
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(h.x + i * step, h.y + h.height);
        ctx.lineTo(h.x + i * step + step / 2, h.y);
        ctx.lineTo(h.x + (i + 1) * step, h.y + h.height);
        ctx.closePath();
        ctx.fill();
      }
    } else if (h.kind === "saw") {
      const cx = h.x + h.width / 2;
      const cy = h.y + h.height / 2;
      const r = Math.min(h.width, h.height) / 2;
      ctx.translate(cx, cy);
      ctx.rotate(t * 7);
      ctx.fillStyle = h.color ?? "#9aa4af";
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const rr = i % 2 === 0 ? r : r * 0.66;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#2b3441";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = h.color ?? "rgba(255,90,95,0.45)";
      ctx.fillRect(h.x, h.y, h.width, h.height);
    }
    ctx.restore();
  }

  /** Sky + background parallax + the solid stage. Call inside beginWorld. */
  function drawWorldBack(map: WorldMap, cam: WorldCamera): void {
    let sky = skyGradients.get(map);
    if (!sky) {
      sky = ctx.createLinearGradient(0, 0, 0, ARENA_HEIGHT);
      sky.addColorStop(0, map.sky[0]);
      sky.addColorStop(1, map.sky[1]);
      skyGradients.set(map, sky);
    }
    ctx.fillStyle = sky;
    ctx.fillRect(-60, -60, ARENA_WIDTH + 120, ARENA_HEIGHT + 120);

    for (const layer of map.background) drawLayer(layer, cam);

    drawSolids(map);
    drawHazards(map, cam.t);
  }

  /** Sparks and dust, in world space — call between beginWorld and endWorld. */
  function drawParticles(particles: readonly Particle[]): void {
    ctx.save();
    for (const p of particles) {
      // Fade out over the tail of the life, so nothing pops out of existence.
      ctx.globalAlpha = Math.min(1, (p.life / p.maxLife) * 1.6);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
  }

  function drawStickman(man: Stickman, t: number): void {
    const { x, y, facing, color } = man;
    const headR = PLAYER_WIDTH * 0.32;
    const headY = y - PLAYER_HEIGHT + headR;
    const neckY = headY + headR;
    const hipY = y - PLAYER_HEIGHT * 0.4;
    const lean = facing * 2;

    // Contact shadow: the cheapest possible "am I standing on something".
    if (man.grounded) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(x, y + 1, PLAYER_WIDTH * 0.55, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();

    // Fresh-spawn i-frames read as a fast flicker — the universal shorthand.
    // `t` is the render loop's own clock (seconds); using it instead of
    // `Date.now()` drops a call from the per-stickman draw path and keeps every
    // fighter's flicker sampled at the same instant within a frame.
    if (man.invulnerable) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * (1000 / 70)));
    }

    // A dropped player, seat held for a reconnect: faded to half, so the table
    // can see who's gone without the fighter vanishing.
    if (man.disconnected) ctx.globalAlpha *= 0.4;

    // Hitstun blanks the stickman white: you have been hit and you are not
    // driving until it clears.
    ctx.strokeStyle = man.stunned ? "#ffffff" : color;
    ctx.fillStyle = man.stunned ? "#ffffff" : color;
    ctx.lineWidth = man.stunned ? 3.8 : 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.arc(x + lean, headY, headR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + lean, neckY);
    ctx.lineTo(x, hipY);

    const shoulderY = neckY + 5;
    if (man.swing > 0) {
      // Swing: the lead arm punches out and back over the window, the trailing
      // arm counterweights. The server's hitbox is live across the middle of
      // this arc, so the reach you see is roughly the reach you get.
      const reach = Math.sin(man.swing * Math.PI); // 0 → 1 → 0
      ctx.moveTo(x - facing * PLAYER_WIDTH * 0.38, shoulderY + 9);
      ctx.lineTo(x + lean * 0.5, shoulderY);
      ctx.lineTo(x + facing * (PLAYER_WIDTH * 0.4 + reach * 20), shoulderY - reach * 5);
    } else {
      // Arms at rest, swept toward the facing direction.
      ctx.moveTo(x - PLAYER_WIDTH * 0.42, shoulderY + 8);
      ctx.lineTo(x + lean * 0.5, shoulderY);
      ctx.lineTo(x + PLAYER_WIDTH * 0.42 + lean, shoulderY + 7);
    }

    // Legs.
    ctx.moveTo(x - PLAYER_WIDTH * 0.34, y);
    ctx.lineTo(x, hipY);
    ctx.lineTo(x + PLAYER_WIDTH * 0.34, y);
    ctx.stroke();

    // Little nose-dot so you can tell which way you're pointing.
    ctx.beginPath();
    ctx.arc(x + lean + facing * headR * 0.75, headY, 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Hat last, so it sits on top of the head outline. Follows the white
    // hitstun flash with the rest of the silhouette.
    drawHat(ctx, x + lean, headY, headR, facing, man.stunned ? "#ffffff" : color, man.hat);

    ctx.restore();

    const labelY = y - PLAYER_HEIGHT - 8;

    /** Dark halo, so labels stay legible when two players crowd together. */
    const label = (text: string, ty: number, font: string, fill: string) => {
      ctx.save();
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(14,17,22,0.85)";
      ctx.strokeText(text, x, ty);
      ctx.fillStyle = fill;
      ctx.fillText(text, x, ty);
      ctx.restore();
    };

    // Only your own name goes over the arena. Fighters stand on top of each
    // other constantly, and four name tags in a scrum interleave into mush —
    // everyone else is identified by colour, with the roster as the key.
    if (man.isSelf) {
      label(man.name, labelY, "700 11px ui-sans-serif, system-ui, sans-serif", color);
    }

    // Damage percentage: the number you actually read mid-fight, so it gets the
    // weight and the colour. Sits clear of the name's ascenders (labelY - 11).
    if (man.showLives) {
      label(
        `${man.damage}%`,
        labelY - 13,
        "700 13px ui-sans-serif, system-ui, sans-serif",
        damageColor(man.damage),
      );
    }

    // Lives, as pips above the damage — readable without looking away.
    if (man.showLives && man.maxLives > 0) {
      const r = 2.6;
      const gap = 7.5;
      const startX = x - ((man.maxLives - 1) * gap) / 2;
      const pipY = labelY - 29;

      ctx.save();
      for (let i = 0; i < man.maxLives; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * gap, pipY, r, 0, Math.PI * 2);
        if (i < man.lives) {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.strokeStyle = "rgba(232,236,241,0.5)";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  /**
   * Screen-space overlay: the steering stick and the two buttons.
   *
   * The stick is drawn only while a thumb is on it — at rest the left half of
   * the screen is bare, so nothing sits between you and the fight.
   */
  function drawControls(
    zones: readonly ControlZone[],
    active: ReadonlySet<ControlZone["id"]>,
    stick: Readonly<StickState>,
  ): void {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (stick.active) {
      const dx = stick.x - stick.originX;

      // The origin, ringed (dashed) at exactly the distance the thumb can reach
      // from this fixed spot — the thumb is always on the ring or inside it.
      ctx.save();
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(stick.originX, stick.originY, STICK_MAX_OFFSET, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.stroke();
      ctx.restore();

      // A little pip pinning the origin itself.
      ctx.beginPath();
      ctx.arc(stick.originX, stick.originY, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.fill();

      if (Math.abs(dx) > 1) {
        // A bar out to the thumb, so the committed direction reads at a glance.
        ctx.beginPath();
        ctx.moveTo(stick.originX, stick.originY);
        ctx.lineTo(stick.x, stick.y);
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.stroke();

        // …and a chevron past the ring, pointing the way you're running.
        const dir = Math.sign(dx);
        const ax = stick.originX + dir * (STICK_MAX_OFFSET + 11);
        ctx.beginPath();
        ctx.moveTo(ax - dir * 5, stick.originY - 6);
        ctx.lineTo(ax + dir * 4, stick.originY);
        ctx.lineTo(ax - dir * 5, stick.originY + 6);
        ctx.lineWidth = 2.5;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = "rgba(255,255,255,0.32)";
        ctx.stroke();
      }

      // The thumb itself — a soft-lit disc.
      const grad = ctx.createRadialGradient(
        stick.x,
        stick.y - 7,
        2,
        stick.x,
        stick.y,
        22,
      );
      grad.addColorStop(0, "rgba(255,255,255,0.24)");
      grad.addColorStop(1, "rgba(255,255,255,0.08)");
      ctx.beginPath();
      ctx.arc(stick.x, stick.y, 22, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.34)";
      ctx.stroke();
    }

    for (const zone of zones) {
      const lit = active.has(zone.id);

      // Drop shadow lifts the button off the arena.
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 3;
      // Both button fills are fixed once `layout()` has placed the zone — build
      // the lit/unlit pair once and reuse. A fresh `zones` array from `layout()`
      // is a fresh key, so a resize rebuilds them.
      let fills = zoneFills.get(zone);
      if (!fills) {
        const make = (a: string, b: string): CanvasGradient => {
          const g = ctx.createRadialGradient(
            zone.cx,
            zone.cy - zone.r * 0.45,
            zone.r * 0.15,
            zone.cx,
            zone.cy,
            zone.r,
          );
          g.addColorStop(0, a);
          g.addColorStop(1, b);
          return g;
        };
        fills = {
          lit: make("rgba(255,122,126,0.36)", "rgba(255,122,126,0.14)"),
          off: make("rgba(255,255,255,0.12)", "rgba(255,255,255,0.05)"),
        };
        zoneFills.set(zone, fills);
      }
      const fill = lit ? fills.lit : fills.off;
      ctx.beginPath();
      ctx.arc(zone.cx, zone.cy, zone.r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(zone.cx, zone.cy, zone.r, 0, Math.PI * 2);
      ctx.lineWidth = lit ? 2 : 1.5;
      ctx.strokeStyle = lit ? "rgba(255,150,153,0.7)" : "rgba(255,255,255,0.16)";
      ctx.stroke();

      const ink = lit ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.5)";
      if (zone.id === "jump") drawJumpIcon(ctx, zone.cx, zone.cy, zone.r, ink);
      else drawAttackIcon(ctx, zone.cx, zone.cy, zone.r, ink);
    }
    ctx.restore();
  }

  return {
    resize,
    clear,
    beginWorld,
    endWorld,
    drawWorldBack,
    drawParticles,
    drawStickman,
    drawControls,
    get cssWidth() {
      return cssWidth;
    },
    get cssHeight() {
      return cssHeight;
    },
  };
}

export type Renderer = ReturnType<typeof createRenderer>;
