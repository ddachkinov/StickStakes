import { schema, t, type SchemaType } from "@colyseus/schema";
import { MAX_PLAYERS } from "./constants.js";
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

    x: t.number().default(0),
    y: t.number().default(0),
    vx: t.number().default(0),
    vy: t.number().default(0),
    facing: t.int8().default(1),
    grounded: t.boolean().default(false),
    coyote: t.uint8().default(0),
    jumpBuffer: t.uint8().default(0),
    jumpHeld: t.boolean().default(false),
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
