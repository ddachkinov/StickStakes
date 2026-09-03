import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  PLATFORMS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
} from "@stickstakes/shared";
import type { ControlZone } from "./input.js";

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

  /** Everything drawn between `beginWorld` and `endWorld` is in arena units. */
  function beginWorld(): void {
    ctx.save();
    ctx.translate(offsetX, offsetY);
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
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.arc(x + lean, headY, headR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + lean, neckY);
    ctx.lineTo(x, hipY);

    // Arms, swept toward the facing direction.
    const shoulderY = neckY + 5;
    ctx.moveTo(x - PLAYER_WIDTH * 0.42, shoulderY + 8);
    ctx.lineTo(x + lean * 0.5, shoulderY);
    ctx.lineTo(x + PLAYER_WIDTH * 0.42 + lean, shoulderY + 7);

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

    // Name tag. Your own is brighter, because finding yourself is the #1 problem.
    ctx.save();
    ctx.font = `${man.isSelf ? "700" : "500"} 11px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.globalAlpha = man.isSelf ? 0.95 : 0.55;
    ctx.fillStyle = man.isSelf ? color : "#e8ecf1";
    ctx.fillText(man.name, x, y - PLAYER_HEIGHT - 8);
    ctx.restore();
  }

  /** Screen-space overlay: the two thumb clusters. */
  function drawControls(
    zones: readonly ControlZone[],
    active: ReadonlySet<ControlZone["id"]>,
  ): void {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
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
