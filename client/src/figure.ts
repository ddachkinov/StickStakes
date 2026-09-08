import { PLAYER_WIDTH } from "@stickstakes/shared";

/**
 * Shared stickman drawing.
 *
 * `drawHat` is the exact hat geometry the fight renderer uses, lifted here so
 * the lobby and result showcases wear the same hats as the arena — one source
 * of truth for what "party hat" looks like.
 *
 * `drawStickFigure` is a self-contained idle pose for the menus: a calm,
 * slightly breathing stance drawn straight onto a 2D context. It is NOT used
 * mid-fight — the arena renderer has its own swing/lean/label logic — so it can
 * stay purely decorative.
 */

/**
 * A wardrobe hat, drawn in local units around the head. `cy` is the head's
 * centre; the crown of the head is `cy - headR`. Purely presentation — hats
 * are never in the schema's physics fields and never touch a hitbox.
 */
export function drawHat(
  ctx: CanvasRenderingContext2D,
  hx: number,
  cy: number,
  headR: number,
  facing: number,
  color: string,
  hat: string,
): void {
  if (!hat || hat === "none") return;

  const topY = cy - headR;
  const w = headR * 2;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (hat) {
    case "top": {
      ctx.fillStyle = color;
      ctx.fillRect(hx - w * 0.85, topY - 0.5, w * 1.7, 3);
      ctx.fillRect(hx - w * 0.5, topY - headR * 1.25, w, headR * 1.25);
      break;
    }
    case "cap": {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hx, topY + 2, headR * 0.95, Math.PI, 0);
      ctx.fill();
      // The bill points wherever the stickman is facing.
      ctx.beginPath();
      ctx.moveTo(hx, topY + 2);
      ctx.lineTo(hx + facing * headR * 2.1, topY + 2);
      ctx.lineTo(hx + facing * headR * 0.3, topY - 1);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "beanie": {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hx, topY + 3, headR * 1.05, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(hx - headR * 1.05, topY + 2, headR * 2.1, 2.5);
      ctx.beginPath();
      ctx.arc(hx, topY - headR * 0.7, 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "band": {
      ctx.strokeStyle = "#ff5a5f";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hx - headR, topY + headR * 0.7);
      ctx.lineTo(hx + headR, topY + headR * 0.7);
      ctx.stroke();
      break;
    }
    case "crown": {
      ctx.fillStyle = "#ffd166";
      const b = topY + 2;
      ctx.beginPath();
      ctx.moveTo(hx - w * 0.6, b);
      ctx.lineTo(hx - w * 0.6, b - headR * 0.9);
      ctx.lineTo(hx - w * 0.3, b - headR * 0.3);
      ctx.lineTo(hx, b - headR * 1.15);
      ctx.lineTo(hx + w * 0.3, b - headR * 0.3);
      ctx.lineTo(hx + w * 0.6, b - headR * 0.9);
      ctx.lineTo(hx + w * 0.6, b);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "party": {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(hx - headR * 0.9, topY + 2);
      ctx.lineTo(hx + headR * 0.9, topY + 2);
      ctx.lineTo(hx, topY - headR * 2.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(hx, topY - headR * 2.2, 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "halo": {
      ctx.strokeStyle = "#ffe08a";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(hx, topY - headR * 0.85, headR * 1.1, headR * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "horns": {
      ctx.fillStyle = "#ff5a5f";
      for (const s of [-1, 1] as const) {
        ctx.beginPath();
        ctx.moveTo(hx + s * headR * 0.45, topY + 2);
        ctx.lineTo(hx + s * headR * 1.05, topY + 2);
        ctx.lineTo(hx + s * headR * 1.15, topY - headR * 0.9);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "antenna": {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hx, topY + 1);
      ctx.lineTo(hx, topY - headR * 1.4);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hx, topY - headR * 1.6, 2.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default:
      break;
  }

  ctx.restore();
}

export interface FigurePose {
  color: string;
  hat: string;
  /** Facing 1 (right) or -1 (left). */
  facing?: number;
  /** Seconds, for the idle breathing/sway. Pass 0 for a still pose. */
  t?: number;
  /** Overall figure height in local px. Width follows from the body ratio. */
  height?: number;
  /** Stroke weight for the limbs. Defaults scale with `height`. */
  lineWidth?: number;
}

/**
 * Draw an idle stickman centred on (`cx`, groundY at feet). A menu showcase
 * piece: it breathes, the arms sway a hair, the head bobs. No swing, no labels.
 */
export function drawStickFigure(
  ctx: CanvasRenderingContext2D,
  cx: number,
  feetY: number,
  pose: FigurePose,
): void {
  const h = pose.height ?? 120;
  const bodyW = h * (PLAYER_WIDTH / 56);
  const facing = pose.facing ?? 1;
  const t = pose.t ?? 0;

  const headR = bodyW * 0.32 * (h / (h)); // keep proportional to width
  const bob = Math.sin(t * 2.1) * (h * 0.012);
  const sway = Math.sin(t * 1.3) * 0.06;

  const y = feetY - bob;
  const headY = y - h + headR;
  const neckY = headY + headR;
  const hipY = y - h * 0.4;
  const lean = facing * 2 + sway * 6;

  ctx.save();

  // Contact shadow — grounds the figure on its platform.
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx, feetY + 2, bodyW * 0.62, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = pose.color;
  ctx.fillStyle = pose.color;
  ctx.lineWidth = pose.lineWidth ?? Math.max(3, h * 0.03);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Head.
  ctx.beginPath();
  ctx.arc(cx + lean, headY, headR, 0, Math.PI * 2);
  ctx.stroke();

  // Spine.
  ctx.beginPath();
  ctx.moveTo(cx + lean, neckY);
  ctx.lineTo(cx, hipY);

  // Arms at rest, a gentle sway toward the facing direction.
  const shoulderY = neckY + h * 0.09;
  const armSwing = Math.sin(t * 1.7) * (bodyW * 0.14);
  ctx.moveTo(cx - bodyW * 0.42 - armSwing, shoulderY + h * 0.14);
  ctx.lineTo(cx + lean * 0.5, shoulderY);
  ctx.lineTo(cx + bodyW * 0.42 + lean + armSwing, shoulderY + h * 0.12);

  // Legs.
  const stance = bodyW * 0.34;
  ctx.moveTo(cx - stance, y);
  ctx.lineTo(cx, hipY);
  ctx.lineTo(cx + stance, y);
  ctx.stroke();

  // Nose dot — which way it faces.
  ctx.beginPath();
  ctx.arc(cx + lean + facing * headR * 0.75, headY, headR * 0.14, 0, Math.PI * 2);
  ctx.fill();

  drawHat(ctx, cx + lean, headY, headR, facing, pose.color, pose.hat);

  ctx.restore();
}

export interface FighterShowcase {
  /** Update the look; the loop picks it up on the next frame. */
  set(color: string, hat: string): void;
  /** Stop the animation loop (on teardown). */
  stop(): void;
}

/**
 * Run a self-contained idle-fighter animation inside `canvas`, sized to its
 * own CSS box. Used by the landing, lobby, and result showcases so a player
 * always sees the stickman they are about to send into the ring.
 */
export function createFighterShowcase(
  canvas: HTMLCanvasElement,
  initial: { color: string; hat: string },
): FighterShowcase {
  const ctx = canvas.getContext("2d");
  let color = initial.color;
  let hat = initial.hat;
  let raf = 0;
  const start = performance.now();

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    // Skip the work entirely while the host panel is hidden (`display: none`
    // gives a null offsetParent) — the result showcase is off screen most of
    // the match.
    if (!ctx || canvas.offsetParent === null) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 240;
    const h = canvas.clientHeight || 135;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Stand on the same ground line the CSS stage draws (bottom 14%).
    const feetY = h * 0.86;
    const figureH = Math.min(h * 0.62, w * 0.5);
    drawStickFigure(ctx, w / 2, feetY, {
      color,
      hat,
      facing: 1,
      t: (now - start) / 1000,
      height: figureH,
    });
  }

  raf = requestAnimationFrame(frame);

  return {
    set(nextColor, nextHat) {
      color = nextColor;
      hat = nextHat;
    },
    stop() {
      cancelAnimationFrame(raf);
    },
  };
}
