/**
 * Every number both the server and the client need to agree on.
 * If a value lives here, neither side is allowed to keep its own copy.
 */

/** Authoritative simulation rate. The server advances the world exactly this often. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
/** Fixed timestep, in seconds. Physics never sees a variable dt. */
export const FIXED_DT = 1 / TICK_RATE;

/** How far behind the newest snapshot the client renders remote players. */
export const INTERPOLATION_DELAY_MS = 100;

export const ROOM_NAME = "arena";
export const MAX_PLAYERS = 4;

/** Below this many players the match can't start (or pauses if it drops). */
export const MIN_PLAYERS = 2;

/**
 * The match state machine, shared verbatim by both sides so the client can
 * switch screens off `state.phase` without a lookup table.
 *
 *   lobby      → waiting; host can start once MIN_PLAYERS are in
 *   countdown  → everyone frozen at spawn, "3 · 2 · 1 · FIGHT"
 *   playing    → the fight; deaths cost a life
 *   roundOver  → a round has a winner; showing the card
 *   matchOver  → someone reached the round-win target; final standings
 */
export type MatchPhase = "lobby" | "countdown" | "playing" | "roundOver" | "matchOver";

/** Default match rules. Track C's setup screen will let the host change these. */
export const TOTAL_ROUNDS = 3;
export const LIVES_PER_ROUND = 3;
/** Best-of: first to this many round wins takes the match. */
export const ROUND_WINS_TO_TAKE_MATCH = Math.ceil(TOTAL_ROUNDS / 2);

/** Phase durations, in milliseconds. */
export const COUNTDOWN_MS = 3000;
export const ROUND_OVER_MS = 4000;
/** Dead but with lives left: this long face-down before respawning. */
export const RESPAWN_DELAY_MS = 1200;
/** Grace period after respawning during which you can't be killed or knocked. */
export const SPAWN_IFRAME_MS = 1500;

/**
 * How long an attack swing lasts, and the recovery before another is allowed.
 * Today this drives an animation only; Track B hangs the hitbox on the same
 * window, so the timing is already the thing that will matter.
 */
export const ATTACK_SWING_MS = 220;
export const ATTACK_RECOVERY_MS = 260;

/**
 * All match timing is expressed in server ticks rather than wall-clock, so the
 * client can render every countdown from the synced `tick` field alone — no
 * clock alignment, no per-tick timer messages.
 */
export const msToTicks = (ms: number): number => Math.round(ms / TICK_MS);
export const ticksToMs = (ticks: number): number => ticks * TICK_MS;

/** Arena is a fixed-size world; the client letterboxes it into whatever screen it has. */
export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;

/** Fall past this and you lose a life. */
export const KILL_PLANE_Y = ARENA_HEIGHT + 240;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One arena, one platform. Everything else is air. */
export const PLATFORMS: readonly Rect[] = [
  { x: 160, y: 400, width: 640, height: 28 },
];

/**
 * Standing positions on the platform surface, not drop points above it —
 * players are frozen at spawn during the countdown, and a stickman hovering
 * in mid-air for three seconds looks broken.
 */
export const SPAWN_POINTS: readonly { x: number; y: number }[] = [
  { x: 260, y: 400 },
  { x: 700, y: 400 },
  { x: 400, y: 400 },
  { x: 560, y: 400 },
];

export const PLAYER_WIDTH = 22;
export const PLAYER_HEIGHT = 56;

/** Movement feel. Tuned for thumbs, not keyboards. */
export const MOVE_SPEED = 260;
export const GROUND_ACCEL = 2600;
export const AIR_ACCEL = 1400;
export const GROUND_FRICTION = 2200;
export const AIR_FRICTION = 260;
export const GRAVITY = 1900;
export const JUMP_VELOCITY = -640;
/** Releasing jump early cuts the rise, so taps are short hops. */
export const JUMP_CUT_MULTIPLIER = 0.45;
export const MAX_FALL_SPEED = 1300;
/** Ticks of grace after walking off a ledge during which jump still works. */
export const COYOTE_TICKS = 4;
/** Ticks a jump press stays buffered while airborne. */
export const JUMP_BUFFER_TICKS = 5;

/** Stickman colours, handed out in join order. */
export const PLAYER_COLORS: readonly string[] = [
  "#ff5a5f",
  "#4cc9f0",
  "#ffd166",
  "#8ce99a",
];
