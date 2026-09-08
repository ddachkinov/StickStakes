import { schema, t, type SchemaType } from "@colyseus/schema";
import {
  DEFAULT_HAT,
  DEFAULT_STAKE,
  LIVES_PER_ROUND,
  MAX_PLAYERS,
  ROUND_WINS_TO_TAKE_MATCH,
  TOTAL_ROUNDS,
} from "./constants.js";
import { DEFAULT_MAP_ID } from "./maps.js";
import type { PlayerBody } from "./types.js";

/**
 * The wire input. One of these per simulation tick, per phone.
 * Intent only — a client never sends a position.
 */
export const FightInput = schema(
  {
    left: t.boolean().default(false),
    right: t.boolean().default(false),
    jump: t.boolean().default(false),
    attack: t.boolean().default(false),
  },
  "FightInput",
);
export type FightInput = SchemaType<typeof FightInput>;

/**
 * One stickman. The scalar fields below are exactly `PlayerBody`, which is
 * what lets the server and the client run the identical `stepBody()` over
 * the same object (see the `satisfies` check at the bottom of this file).
 */
export const Player = schema(
  {
    name: t.string().default(""),
    /**
     * Skin colour. Defaults to the join-order colour from `PLAYER_COLORS`, but
     * the player can override it with any `#rrggbb` from the wardrobe. Cosmetic
     * only — never read by the physics step.
     */
    color: t.string().default("#ffffff"),
    /**
     * Lobby identity colour — one of `LOBBY_COLORS` ids, or "" for a legacy /
     * off-palette look. The server keeps this unique across the room: no two
     * players ever hold the same id at once. `color` above is kept in step with
     * it whenever it changes from the lobby.
     */
    colorId: t.string().default(""),
    /** Wardrobe hat id — one of `HATS`. Cosmetic only; the client draws it. */
    hat: t.string().default(DEFAULT_HAT),
    /** Join order, also the spawn point index. */
    slot: t.uint8().default(0),

    // --- match state ---
    /** Lives left this round. 0 = eliminated until the next round. */
    lives: t.uint8().default(0),
    /** Rounds this player has taken so far this match. */
    roundWins: t.uint8().default(0),
    /**
     * Joined after the match started: sits out (frozen, hidden) until the
     * next round begins, then joins as a normal fighter.
     */
    spectating: t.boolean().default(true),
    /**
     * Lobby-only: has this player readied up? The host's start is gated until
     * everyone has. Cleared for everyone at the start of each match, so the
     * next match (or "play again") needs a fresh round of readies.
     */
    ready: t.boolean().default(false),
    /** Server tick until which the player is face-down after a death (0 = alive). */
    deadUntilTick: t.number().default(0),
    /** Server tick until which fresh-spawn i-frames last (0 = vulnerable). */
    invulnUntilTick: t.number().default(0),
    /**
     * Server tick the current attack swing ends on. Drives both the animation
     * and the window during which the hitbox is live.
     */
    attackUntilTick: t.number().default(0),
    /**
     * Server tick until which this fighter is holding a weapon (0 = fists).
     * While armed, the attack button fires a shot instead of throwing a punch,
     * and the punch hitbox is suppressed.
     */
    armedUntilTick: t.number().default(0),
    /** Earliest server tick the armed fighter may fire the next shot. */
    shotReadyTick: t.number().default(0),
    /**
     * Damage taken this life, as a percentage. Not health — you never die from
     * it. It is purely the knockback multiplier: at 0% a hit nudges you, at
     * 120% the same hit throws you off the map. Resets on every respawn.
     */
    damage: t.uint16().default(0),
    /** Server tick hitstun ends on (0 = in control). */
    stunUntilTick: t.number().default(0),

    // --- physics body: exactly PlayerBody, so both sides run the same step ---
    x: t.number().default(0),
    y: t.number().default(0),
    vx: t.number().default(0),
    vy: t.number().default(0),
    facing: t.int8().default(1),
    grounded: t.boolean().default(false),
    coyote: t.uint8().default(0),
    jumpBuffer: t.uint8().default(0),
    jumpHeld: t.boolean().default(false),
    jumping: t.boolean().default(false),
    frozen: t.boolean().default(false),
    stunned: t.boolean().default(false),
  },
  "Player",
);
export type Player = SchemaType<typeof Player>;

/**
 * One weapon shot in flight. Server-owned: the room spawns these when an armed
 * fighter fires, steps them every tick, and resolves their hits. The client
 * only draws them, so `id` is here purely to give the renderer something stable
 * to key a per-projectile trail on if it ever wants one.
 */
export const Projectile = schema(
  {
    id: t.uint32().default(0),
    /** Session id of the fighter who fired it — never hits its own owner. */
    ownerId: t.string().default(""),
    x: t.number().default(0),
    y: t.number().default(0),
    vx: t.number().default(0),
    vy: t.number().default(0),
  },
  "Projectile",
);
export type Projectile = SchemaType<typeof Projectile>;

export const ArenaState = schema(
  {
    /** Ticks since the room was created. Handy for debug overlays. */
    tick: t.number().default(0),
    maxPlayers: t.uint8().default(MAX_PLAYERS),
    players: t.map(Player),

    // --- weapons ---
    /** A weapon is lying on the map, waiting to be picked up. */
    weaponActive: t.boolean().default(false),
    /** Where it sits (centre of the pickup), in arena units. */
    weaponX: t.number().default(0),
    weaponY: t.number().default(0),
    /** Every shot currently in flight. */
    projectiles: t.array(Projectile),

    // --- match ---
    /** One of MatchPhase; a plain string so the client can `switch` on it. */
    phase: t.string().default("lobby"),
    /** Session id of the host — the only client whose start/replay buttons work. */
    hostId: t.string().default(""),
    /** 1-based; which round of the match is being played or was just played. */
    round: t.uint8().default(0),
    totalRounds: t.uint8().default(TOTAL_ROUNDS),
    livesPerRound: t.uint8().default(LIVES_PER_ROUND),
    roundWinsToTakeMatch: t.uint8().default(ROUND_WINS_TO_TAKE_MATCH),
    /**
     * Server tick at which the current timed phase (countdown / roundOver)
     * ends; 0 in untimed phases. The client shows the countdown as
     * `(phaseEndsAtTick - tick) * TICK_MS` — keyed to the synced `tick` above,
     * so it needs no wall-clock alignment and no per-tick timer messages.
     */
    phaseEndsAtTick: t.number().default(0),
    /** Winner of the round just finished (session id), or "" for a draw / none. */
    lastRoundWinnerId: t.string().default(""),
    /** Winner of the match (session id) once phase is matchOver, else "". */
    matchWinnerId: t.string().default(""),

    /**
     * Which world the fight happens on — one of the ids in shared `WORLD_MAPS`.
     * The host sets it from the lobby; both sides resolve it with `getMap()`
     * and step against that map's `solids`. Cosmetic layers aside, this is the
     * only thing that changes the arena geometry.
     */
    mapId: t.string().default(DEFAULT_MAP_ID),

    /**
     * What's riding on this match, in the host's own words.
     *
     * This is a joke tracker and nothing else: free text that the end screen
     * repeats back. No amounts, no accounts, no payments — the moment real
     * money moves through here it becomes a gambling product with the
     * app-store and payment-services rules that implies.
     */
    stake: t.string().default(DEFAULT_STAKE),
  },
  "ArenaState",
);
export type ArenaState = SchemaType<typeof ArenaState>;

/**
 * Compile-time guarantee that a decoded `Player` can be fed to the shared
 * physics step. If someone renames a field on either side, this line breaks
 * before anything reaches a phone.
 */
export type PlayerIsABody = Player extends PlayerBody ? true : never;
const _assertPlayerIsABody: PlayerIsABody = true;
void _assertPlayerIsABody;
