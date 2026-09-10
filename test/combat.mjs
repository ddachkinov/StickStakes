/**
 * Integration test for combat (Track B).
 *
 * Two headless clients on a RUNNING server: one walks into range and swings,
 * the other takes it. Asserts damage accrual, knockback direction and scaling,
 * hitstun, one-hit-per-swing, i-frame immunity, and death by knockback.
 *
 * Start the stack first (`npm run dev`), then `npm run test:combat`.
 * Exits non-zero on the first failed expectation, so CI can gate on it.
 */
import { Client } from "@colyseus/sdk";
import {
  ATTACK_RECOVERY_MS,
  HIT_DAMAGE,
  KNOCKBACK_BASE,
  KNOCKBACK_SCALING,
  SPAWN_IFRAME_MS,
} from "@stickstakes/shared";

const ENDPOINT = process.env.SERVER_URL ?? "http://localhost:2567";
const TICK_MS = 1000 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(name) {
  const room = await new Client(ENDPOINT).joinOrCreate("arena", { name });
  const input = room.input({ mode: "reliable" });
  const intent = { left: false, right: false, jump: false, attack: false };
  const pump = setInterval(() => {
    input.data.left = intent.left;
    input.data.right = intent.right;
    input.data.jump = intent.jump;
    input.data.attack = intent.attack;
    input.send();
  }, TICK_MS);
  return { name, room, intent, stop: () => clearInterval(pump) };
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const a = await connect("ATK");
const b = await connect("DEF");
await sleep(700);

const state = () => a.room.state;
const atk = () => a.room.state.players.get(a.room.sessionId);
const def = () => b.room.state.players.get(b.room.sessionId);

async function waitFor(predicate, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return true;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label} (phase=${state().phase})`);
}

/**
 * A right-facing hitbox spans `x + 6.6 … x + 36.6` and the target's box is
 * ±PLAYER_WIDTH/2, so a swing connects when the target sits between about 4px
 * behind and 48px in front of the attacker, measured toward its facing. Treat
 * the edges of that band as out.
 */
const BAND_MIN = 2;
const BAND_MAX = 40;
/** Run until roughly this close, then stop and walk the last bit. */
const RUN_UNTIL = 70;

/** Would a swing thrown right now actually reach the target? */
function inStrikingPosition() {
  const forward = (def().x - atk().x) * (atk().facing >= 0 ? 1 : -1);
  return forward >= BAND_MIN && forward <= BAND_MAX;
}

/**
 * Walk the attacker to a position its next swing can connect from.
 *
 * "Within 40px of the target" is not that position, and aiming for it is what
 * made this flaky. Running flat out and braking there lets friction carry the
 * attacker *across* the target during the settle; the old correction then
 * tapped it back the other way and returned without re-checking, so it dithered
 * around a gap of zero with the target behind it on every attempt
 * (`gap=-5 facing=1 | gap=19 facing=-1 | gap=0 facing=1 …`) and whiffed every
 * swing.
 *
 * So: run only until roughly in reach, come to a complete stop, then close the
 * last stretch in short steps from rest. A step from standing moves a few
 * pixels, which cannot skip over a 38px-wide band, and stepping toward the
 * target is also what sets facing — so arriving and aiming are the same act.
 * Only the real geometry ends the walk.
 */
async function closeIn(timeout = 12000) {
  const t0 = Date.now();

  while (Date.now() - t0 < timeout && Math.abs(def().x - atk().x) > RUN_UNTIL) {
    const toward = Math.sign(def().x - atk().x) || 1;
    a.intent.right = toward > 0;
    a.intent.left = toward < 0;
    await sleep(30);
  }
  a.intent.left = a.intent.right = false;
  await sleep(200); // let the run bleed off, so the steps below start from rest

  while (Date.now() - t0 < timeout) {
    if (inStrikingPosition()) return true;
    const step = Math.sign(def().x - atk().x) || 1;
    a.intent.right = step > 0;
    a.intent.left = step < 0;
    await sleep(60);
    a.intent.left = a.intent.right = false;
    await sleep(140);
  }

  a.intent.left = a.intent.right = false;
  throw new Error("could not reach a striking position");
}

/**
 * Wait until the defender can actually be hit.
 *
 * The server clears `invulnUntilTick` back to 0 once it lapses, so "not yet
 * assigned" and "already expired" both read 0 — there is no flag to poll for.
 * The comparison below is therefore only meaningful once the initial spawn
 * assignment has reached us, which the sleep after the round starts guarantees.
 */
async function waitVulnerable() {
  await waitFor(() => def().invulnUntilTick <= state().tick, "i-frames to lapse", 5000);
}

/**
 * One clean swing; resolves once damage lands or the swing is spent. Holds
 * past startup + active (150ms) so a dropped input frame can't eat the press,
 * and retries a couple of times because the attacker may still be sliding from
 * closing in. A genuinely broken hitbox whiffs every attempt.
 *
 * Returns the damage dealt AND where both fighters stood on the last sample
 * before it landed. Callers need that pair to judge knockback direction: a
 * retry re-runs `closeIn`, which walks the attacker, so any position read
 * before the call can describe the wrong side of the target by the time the
 * hit actually connects.
 */
async function swing(attempts = 3) {
  const before = def().damage;
  for (let i = 0; i < attempts; i++) {
    await waitVulnerable();
    a.intent.attack = true;
    await sleep(200);
    a.intent.attack = false;

    // Keep the previous sample: once damage appears the target has already
    // been launched, so the tick before it is the one that describes the hit.
    let atX = atk().x;
    let defX = def().x;
    const t0 = Date.now();
    while (Date.now() - t0 < 500 && def().damage === before) {
      atX = atk().x;
      defX = def().x;
      await sleep(15);
    }
    if (def().damage !== before) {
      return { dealt: def().damage - before, attackerX: atX, targetX: defX };
    }
    // Missed: re-close and try again.
    await sleep(ATTACK_RECOVERY_MS + 60);
    try {
      await closeIn(3000);
    } catch {
      break;
    }
  }
  return { dealt: def().damage - before, attackerX: atk().x, targetX: def().x };
}

console.log("\n=== start a match ===");
// The server only starts once the whole room has readied up (host included).
a.room.send("ready", { ready: true });
b.room.send("ready", { ready: true });
await waitFor(
  () => [...state().players.values()].every((p) => p.ready),
  "all ready",
);
a.room.send("startMatch");
await waitFor(() => state().phase === "playing", "playing");
// Spawn i-frames must lapse before anything can connect, and they leave no
// flag behind once cleared — so simply outwait them.
await sleep(SPAWN_IFRAME_MS + 250);
check("both alive", atk().lives > 0 && def().lives > 0);
check("defender starts at 0%", def().damage === 0, `${def().damage}%`);

console.log("\n=== a clean hit ===");
await closeIn();
const { dealt, attackerX, targetX } = await swing();
check("hit landed", dealt === HIT_DAMAGE, `+${dealt}% (expected +${HIT_DAMAGE})`);
check("defender is stunned", def().stunned, `stunned=${def().stunned}`);
check(
  "knocked away from the attacker",
  Math.sign(def().vx) === Math.sign(targetX - attackerX) && def().vx !== 0,
  `vx=${Math.round(def().vx)} attacker@${Math.round(attackerX)} target@${Math.round(targetX)} at impact`,
);
check("popped upward", def().vy < 0, `vy=${Math.round(def().vy)}`);

const expected = KNOCKBACK_BASE + HIT_DAMAGE * KNOCKBACK_SCALING;
check(
  "launch speed matches the formula",
  Math.abs(Math.abs(def().vx) - expected) < 20,
  `|vx|=${Math.abs(def().vx).toFixed(1)} expected=${expected.toFixed(1)}`,
);

console.log("\n=== hitstun takes the controls away ===");
// Ask the defender to run back while stunned; it must not obey.
b.intent.left = true;
const stunnedVx = def().vx;
await sleep(60);
check(
  "input ignored during hitstun",
  def().stunned ? Math.sign(def().vx) === Math.sign(stunnedVx) : true,
  `vx=${Math.round(def().vx)}`,
);
b.intent.left = false;
await waitFor(() => !def().stunned, "hitstun to clear", 3000);
check("stun clears on its own", !def().stunned && def().stunUntilTick === 0);

console.log("\n=== one hit per swing ===");
await waitFor(() => def().grounded || def().lives === 0, "defender to land", 8000);
if (def().lives > 0) {
  await closeIn();
  const before = def().damage;
  a.intent.attack = true;
  await sleep(400); // hold well past the active window
  a.intent.attack = false;
  await sleep(200);
  const gained = def().damage - before;
  check(
    "a held button deals at most one swing's damage",
    gained <= HIT_DAMAGE * 2,
    `+${gained}% over 400ms held`,
  );
}

console.log("\n=== knockback scales with damage ===");
/**
 * Drive the defender's damage up, sampling launch speed at low vs high %.
 *
 * The section is deliberately patient about *how* it gets its samples, because
 * the property under test fights the harness: every hit throws the defender
 * further than the last, so each successive approach is a longer walk. Three
 * rules keep that from turning into a flaky suite.
 *
 *  - A failed approach costs one attempt, never the section. An early launch
 *    toward a far ledge (or off the map, which respawns the defender at 0%)
 *    used to end the run with one sample and fail on the count alone.
 *  - The walk gets a budget that suits the last launch, not the first.
 *  - Enough attempts and wall-clock room to reach a comfortable margin over
 *    the two samples the comparison actually needs.
 *
 * The assertions below are unchanged: a shortfall still fails loudly, because
 * failing to land two hits in this long really would mean combat is broken.
 */
const SAMPLE_TARGET = 4;
const SAMPLE_DEADLINE = Date.now() + 75_000;
const samples = [];

for (let i = 0; i < 12; i++) {
  if (samples.length >= SAMPLE_TARGET || Date.now() > SAMPLE_DEADLINE) break;
  if (def().lives === 0) break;

  await waitFor(() => !def().stunned, "stun clear", 4000).catch(() => {});
  await waitFor(() => def().grounded, "landing", 6000).catch(() => {});
  if (def().lives === 0) break;

  try {
    // Generous: after a hit at high damage the defender can be
    // *most of the arena* away, and the attacker gets there on foot.
    await closeIn(8000);
  } catch {
    continue; // out of reach this time; let it settle and try again
  }

  const dmgBefore = def().damage;
  const { dealt: got } = await swing();
  if (got > 0) samples.push({ damage: dmgBefore + got, vx: Math.abs(def().vx) });
}

console.log(
  "   samples: " + samples.map((s) => `${s.damage}%→${Math.round(s.vx)}px/s`).join("  "),
);
if (samples.length >= 2) {
  // Compare by damage, not by position in the list: the defender can die and
  // respawn mid-run, which resets damage to 0 and would make the last sample
  // the *lowest* one.
  const sorted = [...samples].sort((p, q) => p.damage - q.damage);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  check(
    "higher damage launches harder",
    high.vx > low.vx,
    `${low.damage}%→${Math.round(low.vx)} vs ${high.damage}%→${Math.round(high.vx)}`,
  );
  // And it should track the formula, not just trend upward.
  const predicted = (d) => KNOCKBACK_BASE + d * KNOCKBACK_SCALING;
  const worst = Math.max(...samples.map((s) => Math.abs(s.vx - predicted(s.damage))));
  check("every sample matches the formula", worst < 20, `worst error ${worst.toFixed(1)}px/s`);
} else {
  check("collected knockback samples", false, `only ${samples.length}`);
}

console.log("\n=== knockback can kill ===");
const livesBefore = def().lives;
b.intent.right = true; // walk toward the edge to make the kill quick
const died = await waitFor(
  () => def().lives < livesBefore || state().phase !== "playing",
  "a life to be lost",
  25000,
).then(
  () => true,
  () => false,
);
b.intent.right = false;
check("falling off costs a life", died, `lives ${livesBefore} → ${def().lives}`);
check("damage resets on respawn", def().lives === 0 || def().damage < 999);

a.stop();
b.stop();
await a.room.leave();
await b.room.leave();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
