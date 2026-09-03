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

/** Arena is a fixed-size world; the client letterboxes it into whatever screen it has. */
export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;

/** Fall past this and you respawn (later: you lose a life). */
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

export const SPAWN_POINTS: readonly { x: number; y: number }[] = [
  { x: 280, y: 200 },
  { x: 680, y: 200 },
  { x: 400, y: 120 },
  { x: 560, y: 120 },
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
