/**
 * Integration test for weapons.
 *
 * Two headless clients on a RUNNING server: one walks over a spawned weapon,
 * picks it up, and shoots the other. Asserts the pickup arms the fighter and
 * clears the map weapon, that the attack button now fires a travelling
 * projectile (not a punch) for a punch's worth of damage and knockback, that
 * a second weapon does not appear while one is held, and that the weapon
 * expires after WEAPON_HOLD_MS and the fighter is back to fists.
 *
 * The 30–60s spawn timer would make this untestable, so it leans on the
 * server's `__spawnWeapon` debug hook — registered only when NODE_ENV isn't
 * "production", exactly like the client's feel-test hook. Start the stack with
 * `npm run dev` (not `npm start`), then `npm run test:weapons`.
 */
import { Client } from "@colyseus/sdk";
import {
  SHOT_DAMAGE,
  SPAWN_IFRAME_MS,
  WEAPON_HOLD_MS,
  msToTicks,
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

const a = await connect("GRAB");
const b = await connect("TGT");
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

/** Walk A to a target arena-x and brake, letting friction settle. */
async function walkTo(targetX, tol = 10, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const gap = targetX - atk().x;
    if (Math.abs(gap) <= tol) {
      a.intent.left = a.intent.right = false;
      await sleep(200);
      return true;
    }
    a.intent.right = gap > 0;
    a.intent.left = gap < 0;
    await sleep(30);
  }
  a.intent.left = a.intent.right = false;
  throw new Error(`could not walk to x=${Math.round(targetX)} (at ${Math.round(atk().x)})`);
}

console.log("\n=== start a match ===");
a.room.send("ready", { ready: true });
b.room.send("ready", { ready: true });
await waitFor(
  () => [...state().players.values()].every((p) => p.ready),
  "all ready",
);
a.room.send("startMatch");
await waitFor(() => state().phase === "playing", "playing");
await sleep(SPAWN_IFRAME_MS + 250);
check("both alive", atk().lives > 0 && def().lives > 0);
check("nobody armed at the start", !atk().armedUntilTick && !def().armedUntilTick);
check("no weapon on the map yet", !state().weaponActive);

console.log("\n=== a weapon drops ===");
a.room.send("__spawnWeapon");
await waitFor(() => state().weaponActive, "a weapon to spawn", 4000);
const wx = state().weaponX;
check("weapon has a position on the map", Number.isFinite(wx) && state().weaponY > 0);

console.log("\n=== walk over it to pick it up ===");
await walkTo(wx, 8);
await waitFor(() => atk().armedUntilTick > state().tick, "the pickup to arm A", 4000);
check("A is armed after walking over the weapon", atk().armedUntilTick > state().tick);
check("the map weapon is gone once grabbed", !state().weaponActive);
const holdTicks = atk().armedUntilTick - state().tick;
const wantHold = msToTicks(WEAPON_HOLD_MS);
check(
  "the hold lasts ~WEAPON_HOLD_MS",
  Math.abs(holdTicks - wantHold) <= 20,
  `${holdTicks} ticks (expected ~${wantHold})`,
);

console.log("\n=== no second weapon while one is held ===");
a.room.send("__spawnWeapon");
await sleep(500);
check("a held weapon blocks the next spawn", !state().weaponActive);

console.log("\n=== the button now fires a shot, not a punch ===");
// Close to a clean firing line: same ground height, B a little way ahead.
const gap = def().x - atk().x;
await walkTo(atk().x + gap * 0.55, 12);
// Make sure A faces B (walkTo may have braked facing either way).
a.intent.right = def().x > atk().x;
a.intent.left = def().x < atk().x;
await sleep(80);
a.intent.left = a.intent.right = false;
await sleep(120);

const dmgBefore = def().damage;
let sawProjectile = false;
// The direction the last in-flight shot was travelling — knockback should send
// the target along the bullet, whatever both fighters do meanwhile.
let shotDir = 0;
a.intent.attack = true;
for (let i = 0; i < 60 && def().damage === dmgBefore; i++) {
  const flying = state().projectiles;
  if (flying.length > 0) {
    sawProjectile = true;
    shotDir = Math.sign(flying[flying.length - 1].vx) || shotDir;
  }
  await sleep(TICK_MS);
}
a.intent.attack = false;
check("firing spawns a projectile", sawProjectile, `projectiles seen in flight`);
check("A went on shot cooldown", atk().shotReadyTick > state().tick);

await waitFor(() => def().damage > dmgBefore, "the shot to connect", 3000);
const dealt = def().damage - dmgBefore;
check(
  "a shot deals about a punch's damage",
  dealt >= SHOT_DAMAGE && dealt <= SHOT_DAMAGE * 3,
  `+${dealt}% (SHOT_DAMAGE=${SHOT_DAMAGE})`,
);
check(
  "the shot knocks the target along the bullet's path",
  shotDir !== 0 && Math.sign(def().vx) === shotDir && def().vx !== 0,
  `vx=${Math.round(def().vx)} shotDir=${shotDir}`,
);

console.log("\n=== the weapon expires back to fists ===");
a.intent.left = a.intent.right = false;
await waitFor(
  () => atk().armedUntilTick === 0,
  "the weapon to run out",
  WEAPON_HOLD_MS + 6000,
);
check("A is unarmed once the hold lapses", atk().armedUntilTick === 0 && atk().shotReadyTick === 0);

console.log("\n=== the cycle resumes: another weapon can drop ===");
a.room.send("__spawnWeapon");
await waitFor(() => state().weaponActive, "a fresh weapon to spawn", 4000).then(
  () => check("a new weapon spawns after the last one is spent", true),
  () => check("a new weapon spawns after the last one is spent", false),
);

a.stop();
b.stop();
await a.room.leave();
await b.room.leave();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
