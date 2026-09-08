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
 * ------------------------------------------------------------------- weapons
 *
 * A pickup that swaps the punch for a ranged shot. One weapon exists on the map
 * at a time; the timer for the next one only starts once the current one has
 * been grabbed, so the arena is never littered with guns. A picked-up weapon
 * lasts `WEAPON_HOLD_MS` and then the fighter is back to fists.
 *
 * Everything here is server-authoritative — the weapon, the projectiles and the
 * pickup all live in synced state and the client only ever draws them, exactly
 * like a hazard. None of it reaches `stepBody`, so prediction is unaffected.
 */

/** The random gap between one weapon being taken and the next one appearing. */
export const WEAPON_SPAWN_MIN_MS = 30_000;
export const WEAPON_SPAWN_MAX_MS = 60_000;
/** How long a fighter keeps a weapon after picking it up. */
export const WEAPON_HOLD_MS = 20_000;
/** Centre-to-centre distance at which a fighter walking over a weapon grabs it. */
export const WEAPON_PICKUP_RADIUS = 30;
/** Only spawn a weapon on a solid at least this wide, so it never lands on a sliver. */
export const WEAPON_MIN_SURFACE_WIDTH = 60;
/** How far above the surface the pickup floats (it also bobs a little). */
export const WEAPON_HOVER = 16;

/**
 * The shot. Travels flat in the direction the fighter faces — "where you're
 * looking", with this control scheme — and deals a punch's worth of damage on
 * contact. Fast enough to feel hitscan across the 960-wide arena but still a
 * real travelling object you can watch and, in theory, walk out of.
 */
export const SHOT_SPEED = 720;
export const SHOT_DAMAGE = HIT_DAMAGE;
/** Minimum gap between shots while a weapon is held. */
export const SHOT_COOLDOWN_MS = 300;
/** Visual/collision half-size of a projectile, in arena units. */
export const SHOT_RADIUS = 3;

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
/**
 * How far a full-hold jump lifts the feet, in arena units — the hard ceiling on
 * a climbable step. It falls out of `JUMP_VELOCITY`, `GRAVITY` and the fixed
 * timestep (semi-implicit Euler, so a touch under the `v²/2g` analytic value);
 * measured, not derived, at ~97. Map tiers should sit well below it — aim for
 * ≤ 84 so a jump with any horizontal offset still lands — and `test/maps.mjs`
 * simulates real jumps between every platform pair and fails if one can't be
 * reached.
 */
export const MAX_JUMP_RISE = 97;
/** The comfortable step a map should design to, leaving headroom for a gap that is also horizontal. */
export const COMFORTABLE_JUMP_RISE = 84;
export const MAX_FALL_SPEED = 1300;
/** Ticks of grace after walking off a ledge during which jump still works. */
export const COYOTE_TICKS = 4;
/** Ticks a jump press stays buffered while airborne. */
export const JUMP_BUFFER_TICKS = 5;

/**
 * Stickman colours, handed out in join order. Ten of them, ordered so the
 * earliest joiners get the most distinguishable pairs — with ten sticks in a
 * scrum, telling yours apart is the whole game. This is only the *default*:
 * a player can override it from the wardrobe (see below).
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

/**
 * ------------------------------------------------------------------ wardrobe
 *
 * Player customisation. Purely cosmetic — none of this reaches `stepBody`, so
 * a skin or a hat can never change a hitbox or the physics. Both the picked
 * colour and the hat id ride in on the join options and can be changed later
 * with a `customize` message; the server validates every value against the
 * lists here rather than trusting the client.
 */

/** The swatches the wardrobe offers. A custom hex picker sits alongside these. */
export const WARDROBE_COLORS: readonly string[] = [
  "#ff5a5f", // red
  "#ff9f45", // orange
  "#ffd166", // amber
  "#a3e635", // lime
  "#8ce99a", // green
  "#6ee7d7", // teal
  "#4cc9f0", // cyan
  "#5b8cff", // blue
  "#c792ea", // violet
  "#f78fb3", // pink
  "#e0a458", // tan
  "#b0bec5", // slate
  "#8d99ae", // steel
  "#2ec4b6", // jade
  "#f4f4f5", // white
  "#4a4e69", // ink
];

/**
 * ---------------------------------------------------------------- lobby colours
 *
 * The pre-match identity palette, one entry per pickable colour. Unlike the
 * freeform wardrobe swatches above, THIS list is the authoritative set the
 * lobby hands out: one colour belongs to exactly one player at a time
 * (Among Us style). The server owns availability — it is always derived from
 * the players actually in the room, never a separate list that can drift.
 *
 * Twelve colours for a ten-player room, so there is always slack. Every hex is
 * chosen to read clearly against the dark arena and to stay distinct from its
 * neighbours in a ten-stick scrum.
 */
export interface LobbyColor {
  /** Stable id put on the wire (`player.colorId`). */
  id: string;
  /** Human name, shown in the picker and in "X is now Blue" toasts. */
  name: string;
  /** The `#rrggbb` the stickman is actually drawn in. */
  hex: string;
}

export const LOBBY_COLORS: readonly LobbyColor[] = [
  { id: "red", name: "Red", hex: "#ff5a5f" },
  { id: "orange", name: "Orange", hex: "#ff9f45" },
  { id: "yellow", name: "Yellow", hex: "#ffd166" },
  { id: "lime", name: "Lime", hex: "#a3e635" },
  { id: "green", name: "Green", hex: "#4ade80" },
  { id: "cyan", name: "Cyan", hex: "#4cc9f0" },
  { id: "blue", name: "Blue", hex: "#5b8cff" },
  { id: "purple", name: "Purple", hex: "#c792ea" },
  { id: "pink", name: "Pink", hex: "#f78fb3" },
  { id: "brown", name: "Brown", hex: "#c08457" },
  { id: "white", name: "White", hex: "#f4f4f5" },
  { id: "slate", name: "Slate", hex: "#7c8695" },
];

const LOBBY_COLOR_BY_ID: ReadonlyMap<string, LobbyColor> = new Map(
  LOBBY_COLORS.map((c) => [c.id, c]),
);

const LOBBY_COLOR_BY_HEX: ReadonlyMap<string, LobbyColor> = new Map(
  LOBBY_COLORS.map((c) => [c.hex, c]),
);

/** Is this one of the lobby palette ids? */
export function isLobbyColorId(value: unknown): value is string {
  return typeof value === "string" && LOBBY_COLOR_BY_ID.has(value);
}

/** The hex a lobby colour id draws as, or the first palette hex as a fallback. */
export function lobbyColorHex(id: string): string {
  return LOBBY_COLOR_BY_ID.get(id)?.hex ?? LOBBY_COLORS[0]!.hex;
}

/** The display name for a lobby colour id, or "" if it isn't one. */
export function lobbyColorName(id: string): string {
  return LOBBY_COLOR_BY_ID.get(id)?.name ?? "";
}

/**
 * Best-effort id for a `#rrggbb`: an exact palette match, else "". Used to turn
 * a remembered wardrobe hex (or a join option) into a palette identity.
 */
export function lobbyColorIdFromHex(value: unknown): string {
  if (typeof value !== "string") return "";
  return LOBBY_COLOR_BY_HEX.get(value.toLowerCase())?.id ?? "";
}

/** A six-digit `#rrggbb`. The wardrobe's custom picker only ever emits this. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Is this a colour we're willing to put on the wire and draw? */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** A valid `#rrggbb` (lower-cased), or the fallback if the input is junk. */
export function normalizeHexColor(value: unknown, fallback: string): string {
  return isHexColor(value) ? value.toLowerCase() : fallback;
}

export interface HatOption {
  id: string;
  label: string;
}

/**
 * The hats. `none` is a real option and the default. Each id is drawn by the
 * client renderer; the server only ever stores and validates the id.
 */
export const HATS: readonly HatOption[] = [
  { id: "none", label: "None" },
  { id: "top", label: "Top hat" },
  { id: "cap", label: "Cap" },
  { id: "beanie", label: "Beanie" },
  { id: "band", label: "Headband" },
  { id: "crown", label: "Crown" },
  { id: "party", label: "Party" },
  { id: "halo", label: "Halo" },
  { id: "horns", label: "Horns" },
  { id: "antenna", label: "Antenna" },
];

export const DEFAULT_HAT = "none";

const HAT_IDS: ReadonlySet<string> = new Set(HATS.map((hat) => hat.id));

/** Is this one of the hats we know how to draw? */
export function isHatId(value: unknown): value is string {
  return typeof value === "string" && HAT_IDS.has(value);
}
