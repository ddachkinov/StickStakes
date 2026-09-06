import {
  AIR_ACCEL,
  ATTACK_BOX_HEIGHT,
  ATTACK_REACH,
  AIR_FRICTION,
  COYOTE_TICKS,
  FIXED_DT,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_BUFFER_TICKS,
  JUMP_CUT_MULTIPLIER,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MIN_SOLID_EXTENT,
  MOVE_SPEED,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  type Rect,
} from "./constants.js";
import { activeMap, type Solid, type StepWorld } from "./maps.js";
import { NEUTRAL_INPUT, type InputIntent, type PlayerBody } from "./types.js";

/**
 * The floor on the one-way catch window: even a near-stationary drop onto a
 * platform gets this much slack so a body resting on the face isn't shaken
 * loose by rounding. Above this the window grows with the body's speed — but
 * only ever to one substep of travel (see `resolveVertical`), so it forgives a
 * single frame's overshoot and never yanks up a body that has dropped past.
 */
const ONE_WAY_GRACE = 2;

type SpawnList = readonly { x: number; y: number }[];

/**
 * The one physics step. The server runs it to produce truth; the client runs
 * the exact same function to predict its own stickman and to replay unacked
 * inputs after a correction. Keep it pure-ish and free of any `Math.random`,
 * `Date.now`, or wall-clock dt — determinism is the whole point of this file.
 */

/**
 * x/y are the centre of the feet-anchored body: x = centre, y = bottom.
 * The spawn list defaults to the active map's; the server passes its room's
 * map explicitly so many rooms can run different worlds at once.
 */
export function spawnBody(
  spawnIndex: number,
  spawns: SpawnList = activeMap().spawns,
): PlayerBody {
  const spawn = spawns[spawnIndex % spawns.length]!;
  return {
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing: 1,
    grounded: false,
    coyote: 0,
    jumpBuffer: 0,
    jumpHeld: false,
    jumping: false,
    frozen: false,
    stunned: false,
  };
}

export function copyBody(from: PlayerBody, into: PlayerBody): void {
  into.x = from.x;
  into.y = from.y;
  into.vx = from.vx;
  into.vy = from.vy;
  into.facing = from.facing;
  into.grounded = from.grounded;
  into.coyote = from.coyote;
  into.jumpBuffer = from.jumpBuffer;
  into.jumpHeld = from.jumpHeld;
  into.jumping = from.jumping;
  into.frozen = from.frozen;
  into.stunned = from.stunned;
}

/**
 * The body's collision box. Pass `out` to fill an existing rect instead of
 * allocating — the hot paths (`stepBody`'s substep loop, the server's per-tick
 * hazard and hit passes) do, so a 30 Hz room streams no garbage from here. The
 * default keeps the old allocating shape for tests and one-off callers.
 */
export function bodyAabb(
  body: PlayerBody,
  out: Rect = { x: 0, y: 0, width: 0, height: 0 },
): Rect {
  out.x = body.x - PLAYER_WIDTH / 2;
  out.y = body.y - PLAYER_HEIGHT;
  out.width = PLAYER_WIDTH;
  out.height = PLAYER_HEIGHT;
  return out;
}

/**
 * Scratch boxes for the resolve pass. `stepBody` runs synchronously on one
 * thread and the two resolvers never overlap in a call, so a module-level rect
 * each is safe and keeps the substep loop allocation-free.
 */
const HORIZ_BOX: Rect = { x: 0, y: 0, width: 0, height: 0 };
const VERT_BOX: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** Axis-aligned overlap test. Exported so the server can run hit detection. */
export function overlapsRect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Advance one stickman by exactly one tick.
 * Mutates `body` in place; returns true if the player fell off the world.
 */
export function stepBody(
  body: PlayerBody,
  input: InputIntent,
  dt: number = FIXED_DT,
  world: StepWorld = activeMap(),
): boolean {
  const solids = world.solids;
  // Frozen: held perfectly still, input ignored. Same branch on both sides, so
  // the client's prediction freezes in lock-step with the server's truth.
  if (body.frozen) {
    body.vx = 0;
    body.vy = 0;
    body.jumpBuffer = 0;
    body.coyote = 0;
    return false;
  }

  // Hitstun takes the controls away but leaves the physics running, so a
  // knocked player keeps flying along the arc the hit gave them.
  const cmd = body.stunned ? NEUTRAL_INPUT : input;

  const dir = (cmd.right ? 1 : 0) - (cmd.left ? 1 : 0);

  // --- horizontal: accelerate toward the target speed, else bleed off ---
  const accel = body.grounded ? GROUND_ACCEL : AIR_ACCEL;
  const friction = body.grounded ? GROUND_FRICTION : AIR_FRICTION;

  if (dir !== 0) {
    body.facing = dir > 0 ? 1 : -1;
    const target = dir * MOVE_SPEED;
    if (body.vx < target) body.vx = Math.min(target, body.vx + accel * dt);
    else if (body.vx > target) body.vx = Math.max(target, body.vx - accel * dt);
  } else if (body.vx !== 0) {
    const drop = friction * dt;
    body.vx = body.vx > 0 ? Math.max(0, body.vx - drop) : Math.min(0, body.vx + drop);
  }

  // --- jump: buffered press + coyote time, so mistimed thumbs still work ---
  const jumpPressed = cmd.jump && !body.jumpHeld;
  if (jumpPressed) body.jumpBuffer = JUMP_BUFFER_TICKS;

  if (body.jumpBuffer > 0 && body.coyote > 0) {
    body.vy = JUMP_VELOCITY;
    body.jumpBuffer = 0;
    body.coyote = 0;
    body.grounded = false;
    body.jumping = true;
  }
  // Short hop: cut the rise ONCE, on the tick the player releases a jump they
  // asked for. Edge-triggered — `jumpHeld` was true last tick, `cmd.jump` is
  // false now. The old test (`!cmd.jump`) re-fired every tick the button stayed
  // up, so JUMP_CUT_MULTIPLIER compounded (0.45 → 0.2 → 0.09 …) and killed the
  // rise in ~3 ticks instead of scaling it. Still gated on `jumping` so hitstun
  // (which forces `cmd` neutral) can't be read as a release and eat knockback.
  const releasedJump = body.jumping && body.jumpHeld && !cmd.jump;
  if (releasedJump && body.vy < 0) {
    body.vy *= JUMP_CUT_MULTIPLIER;
    body.jumping = false; // the pop is spent; never cut the same jump twice
  }
  body.jumpHeld = cmd.jump;

  // --- vertical: gravity, capped ---
  body.vy = Math.min(MAX_FALL_SPEED, body.vy + GRAVITY * dt);
  // Past the apex the jump is over; anything later is a fall or a hit.
  if (body.vy >= 0) body.jumping = false;

  // --- integrate and resolve, substepped so a fast body never skips a solid ---
  // One 30 Hz tick of hard knockback moves a body ~150 px; the thinnest solids
  // are ~12 px. Discrete "integrate the whole tick, then push out of overlap"
  // would step clean over them. Split the move so no substep travels more than
  // half MIN_SOLID_EXTENT and resolve after each — CCD without the sweep maths.
  const travel = Math.hypot(body.vx, body.vy) * dt;
  const substeps = Math.max(1, Math.ceil(travel / (MIN_SOLID_EXTENT / 2)));
  const subDt = dt / substeps;

  const wasGrounded = body.grounded;
  body.grounded = false;

  for (let s = 0; s < substeps; s++) {
    body.x += body.vx * subDt;
    resolveHorizontal(body, solids);

    // Feet before this substep's vertical move — a one-way platform only
    // catches a body at or above its top face, so you rise through it and
    // land on the way down.
    const prevFeet = body.y;
    body.y += body.vy * subDt;
    resolveVertical(body, solids, prevFeet, subDt);
  }

  if (body.grounded) body.coyote = COYOTE_TICKS;
  else if (body.coyote > 0) body.coyote -= 1;
  else if (wasGrounded) body.coyote = 0;

  if (body.jumpBuffer > 0) body.jumpBuffer -= 1;

  return body.y > world.killPlaneY;
}

function resolveHorizontal(body: PlayerBody, solids: readonly Solid[]): void {
  const box = bodyAabb(body, HORIZ_BOX);
  for (const solid of solids) {
    // One-way platforms never block sideways — you can run straight through
    // the thin beam and only meet it under your feet.
    if (solid.oneWay) continue;
    if (!overlapsRect(box, solid)) continue;
    // Push out along the shallower horizontal side.
    const fromLeft = solid.x - (box.x + box.width);
    const fromRight = solid.x + solid.width - box.x;
    if (Math.abs(fromLeft) < Math.abs(fromRight)) body.x += fromLeft;
    else body.x += fromRight;
    body.vx = 0;
    box.x = body.x - PLAYER_WIDTH / 2;
  }
}

function resolveVertical(
  body: PlayerBody,
  solids: readonly Solid[],
  prevFeet: number,
  dt: number,
): void {
  const box = bodyAabb(body, VERT_BOX);
  // Decide the direction ONCE, before any solid zeroes `body.vy`. Resolving
  // against `body.vy` inside the loop meant that after the first landing every
  // later overlapping solid also read as "falling", so a body wedged under a
  // beam got snapped down onto the solid above it.
  const falling = body.vy >= 0;
  // One-way catch window: one substep of vertical travel (never less than the
  // rounding floor). Forgives a single frame's overshoot; never re-grabs a
  // body that has genuinely dropped below the face.
  const oneWayGrace = Math.max(ONE_WAY_GRACE, Math.abs(body.vy) * dt);

  for (const solid of solids) {
    if (!overlapsRect(box, solid)) continue;

    if (solid.oneWay) {
      // Only ever catches a descending body whose feet were above the top face
      // last substep; rising through it, or already past it, does nothing.
      if (!falling) continue;
      if (prevFeet > solid.y + oneWayGrace) continue;
      body.y = solid.y;
      body.vy = 0;
      body.grounded = true;
      box.y = body.y - PLAYER_HEIGHT;
      continue;
    }

    if (falling) {
      // Falling onto the top face.
      body.y = solid.y;
      body.vy = 0;
      body.grounded = true;
    } else {
      // Rising into the underside.
      body.y = solid.y + solid.height + PLAYER_HEIGHT;
      body.vy = 0;
    }
    box.y = body.y - PLAYER_HEIGHT;
  }
}

/** Put a body back at its spawn point, in place. Used on both sides. */
export function respawnBody(
  body: PlayerBody,
  spawnIndex: number,
  spawns: SpawnList = activeMap().spawns,
): void {
  copyBody(spawnBody(spawnIndex, spawns), body);
}

/**
 * The rectangle an attack sweeps, in front of the attacker. Lives here rather
 * than on the server so the client can draw it while tuning, and so a future
 * client-side hit prediction reads the exact same geometry.
 */
export function attackHitbox(
  body: PlayerBody,
  out: Rect = { x: 0, y: 0, width: 0, height: 0 },
): Rect {
  const forward = body.facing >= 0;
  const nose = body.x + (forward ? PLAYER_WIDTH * 0.3 : -PLAYER_WIDTH * 0.3);
  out.x = forward ? nose : nose - ATTACK_REACH;
  out.y = body.y - PLAYER_HEIGHT * 0.9;
  out.width = ATTACK_REACH;
  out.height = ATTACK_BOX_HEIGHT;
  return out;
}
