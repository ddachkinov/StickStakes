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
export const MAX_PLAYERS = 10;

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

/** Default match rules. The host can change these from the lobby. */
export const TOTAL_ROUNDS = 3;
export const LIVES_PER_ROUND = 3;
/** What the host is allowed to pick, so the server can validate the message. */
export const ROUND_OPTIONS: readonly number[] = [1, 3, 5, 7];
export const LIVES_OPTIONS: readonly number[] = [1, 2, 3, 5];
/** Best-of: first to this many round wins takes the match. */
export const roundWinsToTakeMatch = (totalRounds: number): number =>
  Math.ceil(totalRounds / 2);
export const ROUND_WINS_TO_TAKE_MATCH = roundWinsToTakeMatch(TOTAL_ROUNDS);

/**
 * Room codes. Four characters from an alphabet with no I/O/0/1, because these
 * get read aloud across a noisy table. 24^4 ≈ 331k combinations.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 4;

/** The stake is a joke tracker, never money. Kept short enough to read big. */
export const MAX_STAKE_LENGTH = 80;
export const MAX_NAME_LENGTH = 12;
export const DEFAULT_STAKE = "Loser buys the winner lunch";

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
 * Within the swing: wind-up, then the frames that can actually connect. A
 * startup gap is what makes an attack a commitment rather than a free button.
 */
export const ATTACK_STARTUP_MS = 60;
export const ATTACK_ACTIVE_MS = 90;

/** Hitbox in front of the attacker, in arena units. */
export const ATTACK_REACH = 30;
export const ATTACK_BOX_HEIGHT = 36;

/**
 * Damage and knockback.
 *
 * There are no health bars — you die by leaving the arena. Damage is purely a
 * knockback multiplier: a fresh stickman barely budges, one at 120% flies. That
 * is what makes a comeback possible and what makes "he's at 140, don't let him
 * touch you" a real thing to shout across a table.
 */
export const HIT_DAMAGE = 9;
export const MAX_DAMAGE = 999;

/** Launch speed = base + damage × scaling, in px/s. */
export const KNOCKBACK_BASE = 200;
export const KNOCKBACK_SCALING = 4.2;
/** Every hit pops you up a little, and harder hits pop higher. */
export const KNOCKBACK_LIFT = 90;
export const KNOCKBACK_UP_RATIO = 0.42;

/** Hitstun: no control while you fly. Grows with damage, but capped. */
export const HITSTUN_BASE_MS = 180;
export const HITSTUN_PER_DAMAGE_MS = 1.6;
export const HITSTUN_MAX_MS = 700;

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
  { x: 90, y: 400, width: 780, height: 28 },
];

/**
 * Standing positions on the platform surface, not drop points above it —
 * players are frozen at spawn during the countdown, and a stickman hovering
 * in mid-air for three seconds looks broken.
 *
 * Ordered so that the first few players spread to the far corners and later
 * ones fill in between: a two-player match starts at opposite ends, not
 * shoulder to shoulder.
 */
export const SPAWN_POINTS: readonly { x: number; y: number }[] = [
  { x: 150, y: 400 },
  { x: 810, y: 400 },
  { x: 330, y: 400 },
  { x: 630, y: 400 },
  { x: 240, y: 400 },
  { x: 720, y: 400 },
  { x: 480, y: 400 },
  { x: 390, y: 400 },
  { x: 570, y: 400 },
  { x: 285, y: 400 },
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

/**
 * Stickman colours, handed out in join order. Ten of them, ordered so the
 * earliest joiners get the most distinguishable pairs — with ten sticks in a
 * scrum, telling yours apart is the whole game.
 */
export const PLAYER_COLORS: readonly string[] = [
  "#ff5a5f", // red
  "#4cc9f0", // cyan
  "#ffd166", // yellow
  "#8ce99a", // green
  "#c792ea", // violet
  "#ff9f45", // orange
  "#f78fb3", // pink
  "#6ee7d7", // teal
  "#b0bec5", // slate
  "#a3e635", // lime
];
