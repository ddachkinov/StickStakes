import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  PLATFORMS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
} from "@stickstakes/shared";
import { STICK_MAX_OFFSET, type ControlZone, type StickState } from "./input.js";
import type { Particle } from "./fx.js";

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

  function drawArena(): void {
    // Backdrop, so the playable area reads apart from the letterbox bars.
    const sky = ctx.createLinearGradient(0, 0, 0, ARENA_HEIGHT);
    sky.addColorStop(0, "#151b25");
    sky.addColorStop(1, "#0f1319");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    for (const platform of PLATFORMS) {
      ctx.fillStyle = "#2b3441";
      ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
      ctx.fillStyle = "#3d4a5c";
      ctx.fillRect(platform.x, platform.y, platform.width, 4);
    }
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

  function drawStickman(man: Stickman): void {
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
    if (man.invulnerable) ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(Date.now() / 70));

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

      // The origin, ringed at exactly the distance the thumb can reach before
      // the origin starts trailing it — so the thumb is always on or inside it.
      ctx.beginPath();
      ctx.arc(stick.originX, stick.originY, STICK_MAX_OFFSET, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.stroke();

      // A bar out to the thumb, so the committed direction reads at a glance.
      if (Math.abs(dx) > 1) {
        ctx.beginPath();
        ctx.moveTo(stick.originX, stick.originY);
        ctx.lineTo(stick.x, stick.y);
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.stroke();
      }

      // The thumb itself.
      ctx.beginPath();
      ctx.arc(stick.x, stick.y, 21, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.stroke();
    }

    for (const zone of zones) {
      const lit = active.has(zone.id);
      ctx.beginPath();
      ctx.arc(zone.cx, zone.cy, zone.r, 0, Math.PI * 2);
      ctx.fillStyle = lit ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = lit ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.14)";
      ctx.stroke();

      ctx.fillStyle = lit ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)";
      ctx.font = `${Math.round(zone.r * 0.6)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(zone.label, zone.cx, zone.cy + 1);
    }
    ctx.restore();
  }

  return {
    resize,
    clear,
    beginWorld,
    endWorld,
    drawArena,
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
