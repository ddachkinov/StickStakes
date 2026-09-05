import { ARENA_HEIGHT, ARENA_WIDTH } from "@stickstakes/shared";
import type { Audio } from "./audio.js";
import { haptics } from "./haptics.js";

/**
 * Feel: screen shake, particles, sound and vibration, driven by game events.
 *
 * One module owns all of it so a single call — "a hit landed, this hard, here"
 * — decides everything the player sees, hears and feels. Nothing in here is
 * simulation: it is presentation, it runs only on the client, and dropping all
 * of it would leave the game identical to play.
 */

/**
 * Trauma-based shake: offset is trauma SQUARED, so a big hit reads as far more
 * than twice a small one.
 *
 * Squaring is also a trap for calibration. Trauma below ~0.5 produces less than
 * a quarter of the maximum, so "reasonable-sounding" values like 0.2 come out
 * at well under a pixel — present in the numbers, invisible on the glass. Every
 * value below is therefore chosen from the pixels it yields, not from how it
 * reads as a fraction: 0.55 → ~5px, 0.8 → ~12px, 1.0 → 18px.
 */
const TRAUMA_DECAY = 1.9; // per second
const MAX_SHAKE_PX = 18;
const MAX_TRAUMA = 1;

/**
 * The damage at which feedback maxes out. NOT `MAX_DAMAGE` — that is a 999
 * clamp, and scaling against it would make every real hit feel like nothing.
 * Knockback starts throwing people off the map somewhere around here.
 */
const FULL_FORCE_DAMAGE = 140;

const MAX_PARTICLES = 160;
const PARTICLE_GRAVITY = 900;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
}

/**
 * Anyone who has asked their OS to calm down gets a calm game: no shake, and
 * a fraction of the particles. Sound and haptics are unaffected — this
 * preference is about motion.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Counters for the dev overlay and the headless feel-test. Feedback is the one
 * part of the game with no server-side truth to assert against, so the cheapest
 * honest check is "did the cue actually fire, and how hard".
 */
export interface FxStats {
  hits: number;
  deaths: number;
  jumps: number;
  lands: number;
  swings: number;
  rounds: number;
  peakShake: number;
  peakParticles: number;
}

export function createFx(audio: Audio) {
  const stats: FxStats = {
    hits: 0,
    deaths: 0,
    jumps: 0,
    lands: 0,
    swings: 0,
    rounds: 0,
    peakShake: 0,
    peakParticles: 0,
  };
  const particles: Particle[] = [];
  let trauma = 0;
  let shakeX = 0;
  let shakeY = 0;
  let calm = prefersReducedMotion();

  if (typeof matchMedia === "function") {
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", (event) => {
      calm = event.matches;
    });
  }

  function addTrauma(amount: number): void {
    if (calm) return;
    trauma = Math.min(MAX_TRAUMA, trauma + amount);
  }

  function spawn(
    count: number,
    x: number,
    y: number,
    spread: number,
    speed: number,
    color: string,
    options: { gravity?: number; life?: number; size?: number; angle?: number } = {},
  ): void {
    const centre = options.angle ?? -Math.PI / 2; // default: upward
    const wanted = calm ? Math.ceil(count * 0.3) : count;
    for (let i = 0; i < wanted; i++) {
      // Oldest particle wins the slot: a cap means a big brawl degrades
      // gracefully instead of dropping frames on a mid-range phone.
      if (particles.length >= MAX_PARTICLES) particles.shift();
      const angle = centre + spread * (Math.random() * 2 - 1);
      const velocity = speed * (0.45 + Math.random() * 0.75);
      const life = (options.life ?? 0.5) * (0.6 + Math.random() * 0.8);
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life,
        maxLife: life,
        size: (options.size ?? 2.6) * (0.7 + Math.random() * 0.8),
        color,
        gravity: options.gravity ?? PARTICLE_GRAVITY,
      });
    }
  }

  /** Advance shake and particles. `dt` is real seconds, capped by the caller. */
  function update(dt: number): void {
    if (trauma > 0) {
      trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
      const magnitude = MAX_SHAKE_PX * trauma * trauma;
      shakeX = magnitude * (Math.random() * 2 - 1);
      shakeY = magnitude * (Math.random() * 2 - 1);
      stats.peakShake = Math.max(stats.peakShake, Math.abs(shakeX), Math.abs(shakeY));
    } else {
      shakeX = 0;
      shakeY = 0;
    }

    stats.peakParticles = Math.max(stats.peakParticles, particles.length);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Off the bottom of the world is gone for good; no point simulating it.
      if (p.y > ARENA_HEIGHT + 80 || p.x < -80 || p.x > ARENA_WIDTH + 80) particles.splice(i, 1);
    }
  }

  return {
    update,
    stats,
    get shakeX() {
      return shakeX;
    },
    get shakeY() {
      return shakeY;
    },
    get particles(): readonly Particle[] {
      return particles;
    },

    /**
     * Somebody got hit. `damage` is the victim's total AFTER the hit, which is
     * what knockback scales on — so the feedback grows exactly as the danger does.
     * `mine` gates the vibration: only your own phone should buzz.
     */
    hit(x: number, y: number, direction: number, damage: number, color: string, mine: boolean) {
      stats.hits++;
      const strength = Math.min(1, damage / FULL_FORCE_DAMAGE);
      addTrauma(0.55 + strength * 0.45); // ~5px at 0%, the full 18px at lethal

      // Sparks fly the way the victim is being launched, angled slightly up
      // to match the knockback arc.
      const cone = direction >= 0 ? -0.35 : Math.PI + 0.35;
      // Sized for a 6" screen: the arena letterboxes down to ~0.7 scale on a
      // phone, so anything smaller than this reads as noise rather than impact.
      spawn(6 + Math.round(strength * 8), x, y, 0.75, 190 + strength * 320, "#ffd166", {
        angle: cone,
        life: 0.38,
        size: 3.2,
      });
      spawn(3, x, y, 0.5, 120 + strength * 200, color, { angle: cone, life: 0.5, size: 3.6 });

      audio.play("hit", { gain: 0.65 + strength * 0.35, rate: 1.15 - strength * 0.35 });
      if (mine) haptics.hit(strength);
    },

    /** A fighter fell off or was knocked out. */
    death(x: number, y: number, color: string, mine: boolean) {
      stats.deaths++;
      addTrauma(0.8); // ~12px — somebody just lost a life
      spawn(18, x, y, Math.PI, 260, color, { angle: 0, life: 0.7, size: 3.2, gravity: 620 });
      audio.play("death");
      if (mine) haptics.death();
    },

    /** Feet hit the ground. Cheap dust, no shake — it happens constantly. */
    land(x: number, y: number, speed: number) {
      if (speed < 320) return; // only a real drop, not every little step down
      stats.lands++;
      const force = Math.min(1, speed / 1000);
      spawn(2 + Math.round(force * 4), x, y, 0.5, 60 + force * 90, "#7b8794", {
        life: 0.28,
        size: 2,
        gravity: 220,
      });
      audio.play("land", { gain: 0.35 + force * 0.5 });
    },

    swing() {
      stats.swings++;
      audio.play("swing", { gain: 0.55, rate: 0.95 + Math.random() * 0.2 });
    },

    jump() {
      stats.jumps++;
      audio.play("jump", { gain: 0.5 });
    },

    roundStart() {
      stats.rounds++;
      audio.play("roundStart");
    },

    roundEnd(mine: boolean) {
      addTrauma(0.6); // ~6px
      audio.play("roundEnd");
      if (mine) haptics.roundEnd();
    },

    matchOver(mine: boolean) {
      addTrauma(0.75); // ~10px
      audio.play("matchOver");
      if (mine) haptics.matchOver();
    },

    /** Wipe everything — used when a round restarts, so stale sparks don't linger. */
    clear() {
      particles.length = 0;
      trauma = 0;
      shakeX = 0;
      shakeY = 0;
    },
  };
}

export type Fx = ReturnType<typeof createFx>;
export type { Particle };
