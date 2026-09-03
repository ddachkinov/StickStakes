/**
 * What a phone is allowed to tell the server: intent, never position.
 * The server's wire schema (`FightInput`) is declared to match this shape,
 * so the same physics step reads client-staged input and decoded input alike.
 */
export interface InputIntent {
  left: boolean;
  right: boolean;
  jump: boolean;
  attack: boolean;
}

export const NEUTRAL_INPUT: InputIntent = {
  left: false,
  right: false,
  jump: false,
  attack: false,
};

/**
 * The mutable physics body of one stickman.
 *
 * Deliberately flat scalars: the server's `Player` schema declares exactly
 * these fields, so a decoded schema instance *is* a `PlayerBody` and both
 * sides can hand it to the same `stepBody()`.
 */
export interface PlayerBody {
  /** Horizontal centre. */
  x: number;
  /** Feet, i.e. the bottom edge of the body box. */
  y: number;
  vx: number;
  vy: number;
  /** 1 = facing right, -1 = facing left. */
  facing: number;
  grounded: boolean;
  /** Ticks of ledge grace left. */
  coyote: number;
  /** Ticks an early jump press stays queued. */
  jumpBuffer: number;
  /** Jump held on the previous tick, so a press can be distinguished from a hold. */
  jumpHeld: boolean;
}

/** The scalar fields a client reconciler mirrors from server truth. */
export const BODY_FIELDS = [
  "x",
  "y",
  "vx",
  "vy",
  "facing",
  "grounded",
  "coyote",
  "jumpBuffer",
  "jumpHeld",
] as const satisfies readonly (keyof PlayerBody)[];
