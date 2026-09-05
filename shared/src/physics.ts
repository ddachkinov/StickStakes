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
  KILL_PLANE_Y,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLATFORMS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SPAWN_POINTS,
  type Rect,
} from "./constants.js";
import { NEUTRAL_INPUT, type InputIntent, type PlayerBody } from "./types.js";

/**
 * The one physics step. The server runs it to produce truth; the client runs
 * the exact same function to predict its own stickman and to replay unacked
 * inputs after a correction. Keep it pure-ish and free of any `Math.random`,
 * `Date.now`, or wall-clock dt — determinism is the whole point of this file.
 */

/** x/y are the centre of the feet-anchored body: x = centre, y = bottom. */
export function spawnBody(spawnIndex: number): PlayerBody {
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length]!;
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

export function bodyAabb(body: PlayerBody): Rect {
  return {
    x: body.x - PLAYER_WIDTH / 2,
    y: body.y - PLAYER_HEIGHT,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
  };
}

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
): boolean {
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
  // Short hop: let go on the way up and the rise is cut. Gated on `jumping`,
  // because hitstun forces `cmd` neutral — without the gate every knocked-up
  // player would be read as "released jump" and have their pop cut away on
  // each tick until it was gone.
  if (body.jumping && !cmd.jump && body.vy < 0) body.vy *= JUMP_CUT_MULTIPLIER;
  body.jumpHeld = cmd.jump;

  // --- vertical: gravity, capped ---
  body.vy = Math.min(MAX_FALL_SPEED, body.vy + GRAVITY * dt);
  // Past the apex the jump is over; anything later is a fall or a hit.
  if (body.vy >= 0) body.jumping = false;

  // --- integrate and resolve, one axis at a time ---
  body.x += body.vx * dt;
  resolveHorizontal(body);

  const wasGrounded = body.grounded;
  body.y += body.vy * dt;
  body.grounded = false;
  resolveVertical(body);

  if (body.grounded) body.coyote = COYOTE_TICKS;
  else if (body.coyote > 0) body.coyote -= 1;
  else if (wasGrounded) body.coyote = 0;

  if (body.jumpBuffer > 0) body.jumpBuffer -= 1;

  return body.y > KILL_PLANE_Y;
}

function resolveHorizontal(body: PlayerBody): void {
  const box = bodyAabb(body);
  for (const platform of PLATFORMS) {
    if (!overlapsRect(box, platform)) continue;
    // Push out along the shallower horizontal side.
    const fromLeft = platform.x - (box.x + box.width);
    const fromRight = platform.x + platform.width - box.x;
    if (Math.abs(fromLeft) < Math.abs(fromRight)) body.x += fromLeft;
    else body.x += fromRight;
    body.vx = 0;
    box.x = body.x - PLAYER_WIDTH / 2;
  }
}

function resolveVertical(body: PlayerBody): void {
  const box = bodyAabb(body);
  for (const platform of PLATFORMS) {
    if (!overlapsRect(box, platform)) continue;
    if (body.vy >= 0) {
      // Falling onto the top face.
      body.y = platform.y;
      body.vy = 0;
      body.grounded = true;
    } else {
      // Rising into the underside.
      body.y = platform.y + platform.height + PLAYER_HEIGHT;
      body.vy = 0;
    }
    box.y = body.y - PLAYER_HEIGHT;
  }
}

/** Put a body back at its spawn point, in place. Used on both sides. */
export function respawnBody(body: PlayerBody, spawnIndex: number): void {
  copyBody(spawnBody(spawnIndex), body);
}

/**
 * The rectangle an attack sweeps, in front of the attacker. Lives here rather
 * than on the server so the client can draw it while tuning, and so a future
 * client-side hit prediction reads the exact same geometry.
 */
export function attackHitbox(body: PlayerBody): Rect {
  const forward = body.facing >= 0;
  const nose = body.x + (forward ? PLAYER_WIDTH * 0.3 : -PLAYER_WIDTH * 0.3);
  return {
    x: forward ? nose : nose - ATTACK_REACH,
    y: body.y - PLAYER_HEIGHT * 0.9,
    width: ATTACK_REACH,
    height: ATTACK_BOX_HEIGHT,
  };
}
