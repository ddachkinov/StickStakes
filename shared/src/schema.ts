import { schema, t, type SchemaType } from "@colyseus/schema";
import {
  LIVES_PER_ROUND,
  MAX_PLAYERS,
  ROUND_WINS_TO_TAKE_MATCH,
  TOTAL_ROUNDS,
} from "./constants.js";
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
    color: t.string().default("#ffffff"),
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
    /** Server tick until which the player is face-down after a death (0 = alive). */
    deadUntilTick: t.number().default(0),
    /** Server tick until which fresh-spawn i-frames last (0 = vulnerable). */
    invulnUntilTick: t.number().default(0),
    /**
     * Server tick the current attack swing ends on. Drives the animation for
     * every client; Track B will hang the hitbox on the same window.
     */
    attackUntilTick: t.number().default(0),

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
    frozen: t.boolean().default(false),
  },
  "Player",
);
export type Player = SchemaType<typeof Player>;

export const ArenaState = schema(
  {
    /** Ticks since the room was created. Handy for debug overlays. */
    tick: t.number().default(0),
    maxPlayers: t.uint8().default(MAX_PLAYERS),
    players: t.map(Player),

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
