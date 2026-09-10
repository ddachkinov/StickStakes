/**
 * Integration test for the pause menu's server side.
 *
 * Everything the menu can ask the room to do, asserted against a RUNNING
 * server: the solo pause that really does stop the world, the host's two
 * bail-outs from a live match (restart, back to the lobby), and the rule that
 * a fighter who walks out mid-match cannot walk back in until it is over.
 *
 * Start the stack first (`npm run dev`), then `npm run test:menu`.
 * Exits non-zero on the first failed expectation, so CI can gate on it.
 */
import { Client } from "@colyseus/sdk";
import { LEFT_MID_MATCH_MESSAGE, ROOM_NAME } from "@stickstakes/shared";

const ENDPOINT = process.env.SERVER_URL ?? "http://localhost:2567";
const TICK_MS = 1000 / 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

/**
 * A headless player, complete with the input pump the server waits on: no
 * input means no simulation for that stickman, so a client that stops sending
 * looks exactly like a paused one and would make this whole suite lie.
 */
async function connect(join, { name, token }) {
  const room = await join(new Client(ENDPOINT), { name, token });
  const input = room.input({ mode: "reliable" });
  const intent = { left: false, right: false, jump: false, attack: false };

  const pump = setInterval(() => {
    input.data.left = intent.left;
    input.data.right = intent.right;
    input.data.jump = intent.jump;
    input.data.attack = intent.attack;
    input.send();
  }, TICK_MS);

  // The first state patch lands a beat after the join resolves; every check
  // below reads state, so wait for ourselves to show up in it.
  for (let i = 0; i < 100 && !room.state?.players?.has(room.sessionId); i++) {
    await sleep(50);
  }

  return { name, room, intent, stop: () => clearInterval(pump) };
}

const create = (options) =>
  connect((client, o) => client.create(ROOM_NAME, o), options);
const joinById = (code, options) =>
  connect((client, o) => client.joinById(code, o), options);

const state = (c) => c.room.state;
const phase = (c) => c.room.state.phase;
const me = (c) => c.room.state.players.get(c.room.sessionId);

async function waitFor(c, predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label} (phase=${phase(c)})`);
}

/** Ready everyone up and start; resolves once the round is actually running. */
async function startMatch(host, others = []) {
  for (const c of [host, ...others]) c.room.send("ready", { ready: true });
  await waitFor(
    host,
    () => [...state(host).players.values()].every((p) => p.ready),
    "everyone ready",
  );
  host.room.send("startMatch");
  await waitFor(host, () => phase(host) === "playing", "playing");
}

const opened = [];
const track = (c) => (opened.push(c), c);

// ------------------------------------------------------------- solo pause

console.log("\n=== solo pause ===");
const solo = track(await create({ name: "SOLO", token: "tok-solo" }));
await startMatch(solo);

// Walk right for a moment, so there is real motion for the pause to stop.
solo.intent.right = true;
await sleep(400);
const movingX = me(solo).x;
await sleep(200);
check("the stickman is moving", me(solo).x !== movingX, `${movingX} → ${me(solo).x}`);

solo.room.send("pause", { paused: true });
await waitFor(solo, () => state(solo).paused, "paused");
check("solo pause is granted", state(solo).paused === true);
check("the pause freezes the body", me(solo).frozen === true);

const pausedX = me(solo).x;
const pausedTick = state(solo).tick;
const pausedDeadline = state(solo).phaseEndsAtTick;
await sleep(700);
check("nothing moves while paused", me(solo).x === pausedX, `${pausedX} → ${me(solo).x}`);
check("the clock still runs", state(solo).tick > pausedTick, `${pausedTick} → ${state(solo).tick}`);
check(
  "phase deadlines are held with it",
  // `playing` has no deadline; a held one keeps the same distance from `tick`.
  state(solo).phaseEndsAtTick === pausedDeadline ||
    state(solo).phaseEndsAtTick - state(solo).tick === pausedDeadline - pausedTick,
);

solo.room.send("pause", { paused: false });
await waitFor(solo, () => !state(solo).paused, "resumed");
check("the body is let go again", me(solo).frozen === false);
await sleep(400);
check("and it moves again", me(solo).x !== pausedX, `${pausedX} → ${me(solo).x}`);

solo.intent.right = false;

// ------------------------------------------------- pause is solo-only

console.log("\n=== company ends the pause ===");
const soloCode = solo.room.roomId;
const guest = track(await joinById(soloCode, { name: "GUEST", token: "tok-guest" }));
await sleep(400);

solo.room.send("pause", { paused: true });
await sleep(400);
check("two in the room means no pause", state(solo).paused === false);
check("the guest agrees", state(guest).paused === false);

// ---------------------------------------------------- host-only bail-outs

console.log("\n=== restart is host-only ===");
const roundBefore = state(solo).round;
guest.room.send("restartMatch");
await sleep(400);
check(
  "a guest's restart is ignored",
  state(solo).round === roundBefore && phase(solo) === "playing",
  `round=${state(solo).round} phase=${phase(solo)}`,
);

solo.room.send("restartMatch");
await waitFor(solo, () => phase(solo) === "countdown", "restart countdown");
check("the host can restart", state(solo).round === 1, `round=${state(solo).round}`);
check(
  "everyone is back in the fight",
  [...state(solo).players.values()].every((p) => !p.spectating && p.lives > 0),
);

console.log("\n=== back to the lobby is host-only ===");
await waitFor(solo, () => phase(solo) === "playing", "playing again");
guest.room.send("endMatch");
await sleep(400);
check("a guest cannot end the match", phase(solo) === "playing", phase(solo));

solo.room.send("endMatch");
await waitFor(solo, () => phase(solo) === "lobby", "back in the lobby");
check("the host can end the match", phase(solo) === "lobby");
check("the guest is there too", phase(guest) === "lobby");
check(
  "everyone is un-readied for the next one",
  [...state(solo).players.values()].every((p) => !p.ready && !p.spectating),
);
check("the round counter is reset", state(solo).round === 0, `round=${state(solo).round}`);

// ------------------------------------------------------- the quit lockout

console.log("\n=== quitting a live match ===");
await startMatch(solo, [guest]);
check("a fresh match is running", phase(solo) === "playing", phase(solo));

guest.stop();
await guest.room.leave();
await waitFor(solo, () => state(solo).players.size === 1, "the quitter is gone");

let rejoinError = "";
try {
  const sneak = await joinById(soloCode, { name: "GUEST", token: "tok-guest" });
  track(sneak);
} catch (error) {
  rejoinError = String(error?.message ?? error);
}
check(
  "the quitter is turned away",
  rejoinError.includes(LEFT_MID_MATCH_MESSAGE),
  rejoinError.slice(0, 80) || "(joined anyway)",
);

const stranger = track(await joinById(soloCode, { name: "NEW", token: "tok-stranger" }));
await sleep(400);
check("someone new still gets in", state(solo).players.size === 2, `${state(solo).players.size}`);
check("as a spectator until the next round", me(stranger).spectating === true);

console.log("\n=== the lobby reopens the door ===");
solo.room.send("endMatch");
await waitFor(solo, () => phase(solo) === "lobby", "lobby again");

const returned = track(await joinById(soloCode, { name: "GUEST", token: "tok-guest" }));
await sleep(400);
check("the quitter can come back once it's over", state(returned).players.has(returned.room.sessionId));

// Tidy up on the way out. A room that was already closed under us (the
// refused rejoin, the guest that quit) never settles its `leave()`, so give
// the whole teardown a deadline rather than hanging the suite on it.
for (const c of opened) c.stop();
await Promise.race([
  Promise.allSettled(opened.map((c) => c.room.leave())),
  sleep(2000),
]);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
