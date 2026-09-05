/**
 * Integration test for the match state machine (Track A).
 *
 * Drives a full match against a RUNNING server with two headless clients.
 * Exercises the Track A state machine end to end: lobby → countdown → playing
 * → roundOver → … → matchOver, including life loss, elimination and scoring.
 *
 * Start the stack first (`npm run dev`), then `npm run test:match`.
 * Exits non-zero on the first failed expectation, so CI can gate on it.
 */
import { Client } from "@colyseus/sdk";

const ENDPOINT = process.env.SERVER_URL ?? "http://localhost:2567";
const TICK_MS = 1000 / 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(name) {
  const client = new Client(ENDPOINT);
  const room = await client.joinOrCreate("arena", { name });
  const input = room.input({ mode: "reliable" });
  const intent = { left: false, right: false, jump: false, attack: false };

  // The server waits for input rather than guessing, so every client must keep
  // sending every tick or its stickman simply never advances.
  const pump = setInterval(() => {
    input.data.left = intent.left;
    input.data.right = intent.right;
    input.data.jump = intent.jump;
    input.data.attack = intent.attack;
    input.send();
  }, TICK_MS);

  return { name, room, intent, stop: () => clearInterval(pump) };
}

const state = (c) => c.room.state;
const me = (c) => c.room.state.players.get(c.room.sessionId);
const phase = (c) => c.room.state.phase;

async function waitFor(c, predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label} (phase=${phase(c)})`);
}

function scoreline(c) {
  return Array.from(state(c).players.entries())
    .map(([, p]) => `${p.name} ${p.lives}♥ ${p.roundWins}★${p.spectating ? " (spec)" : ""}`)
    .join("  |  ");
}

const a = await connect("HOST");
const b = await connect("VICTIM");
await sleep(600);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

console.log("\n=== lobby ===");
check("both players in", state(a).players.size === 2, `size=${state(a).players.size}`);
check("phase is lobby", phase(a) === "lobby", phase(a));
check("A is host", state(a).hostId === a.room.sessionId);
check("nobody frozen in lobby", !me(a).frozen && !me(b).frozen);

console.log("\n=== non-host cannot start ===");
b.room.send("startMatch");
await sleep(400);
check("still lobby after B pressed start", phase(a) === "lobby", phase(a));

console.log("\n=== host starts ===");
// The server only starts once the whole room has readied up (host included).
a.room.send("ready", { ready: true });
b.room.send("ready", { ready: true });
await waitFor(a, () => [...state(a).players.values()].every((p) => p.ready), "all ready");
a.room.send("startMatch");
await waitFor(a, () => phase(a) === "countdown", "countdown");
check("phase is countdown", phase(a) === "countdown");
check("round is 1", state(a).round === 1, `round=${state(a).round}`);
check("lives dealt", me(a).lives === state(a).livesPerRound, `${me(a).lives} lives`);
check("frozen during countdown", me(a).frozen && me(b).frozen);
const spawnX = me(b).x;

await waitFor(a, () => phase(a) === "playing", "playing");
check("phase is playing", phase(a) === "playing");
check("unfrozen at fight start", !me(a).frozen && !me(b).frozen);
check("i-frames on spawn", me(a).invulnUntilTick > state(a).tick);

console.log("\n=== attack swing ===");
a.intent.attack = true;
await sleep(200);
check("swing window opened", me(a).attackUntilTick > 0, `until=${me(a).attackUntilTick}`);
a.intent.attack = false;

console.log("\n=== B walks off the edge until eliminated ===");
b.intent.right = true;

for (let life = state(a).livesPerRound; life > 0; life--) {
  await waitFor(a, () => me(b).lives === life - 1, `B down to ${life - 1} lives`, 20000);
  console.log(`       B lost a life → ${me(b).lives} left`);
  if (me(b).lives > 0) {
    // Should come back at spawn, briefly invulnerable.
    await waitFor(a, () => me(b).deadUntilTick === 0 && !me(b).frozen, "B respawned");
    // Tolerance, not precision: B is still holding "right", so it starts
    // walking the instant it respawns. What matters is that it is back at
    // the platform rather than still out past the edge (x > 960).
    check(
      `respawned at spawn (life ${me(b).lives})`,
      Math.abs(me(b).x - spawnX) < 30,
      `x=${Math.round(me(b).x)} spawn=${Math.round(spawnX)}`,
    );
  }
}
b.intent.right = false;

console.log("\n=== round 1 result ===");
await waitFor(a, () => phase(a) === "roundOver", "roundOver");
check("phase is roundOver", phase(a) === "roundOver");
check("A took the round", state(a).lastRoundWinnerId === a.room.sessionId);
check("A has 1 round win", me(a).roundWins === 1, `${me(a).roundWins}`);
check("B has 0 round wins", me(b).roundWins === 0);
check("everyone frozen", me(a).frozen && me(b).frozen);
console.log("       " + scoreline(a));

console.log("\n=== round 2 ===");
await waitFor(a, () => phase(a) === "countdown", "round 2 countdown", 12000);
check("round is 2", state(a).round === 2, `round=${state(a).round}`);
check("lives restored", me(b).lives === state(a).livesPerRound, `${me(b).lives}`);
check("round wins carried over", me(a).roundWins === 1);

await waitFor(a, () => phase(a) === "playing", "round 2 playing");
b.intent.right = true;
await waitFor(a, () => phase(a) === "matchOver", "matchOver", 30000);
b.intent.right = false;

console.log("\n=== match result ===");
check("phase is matchOver", phase(a) === "matchOver");
check("A won the match", state(a).matchWinnerId === a.room.sessionId);
check(
  "A reached the win target",
  me(a).roundWins >= state(a).roundWinsToTakeMatch,
  `${me(a).roundWins}/${state(a).roundWinsToTakeMatch}`,
);
console.log("       " + scoreline(a));

console.log("\n=== both clients agree ===");
check("phase agrees", phase(a) === phase(b), `${phase(a)} vs ${phase(b)}`);
check("winner agrees", state(a).matchWinnerId === state(b).matchWinnerId);

console.log("\n=== host can replay ===");
// Ready flags are cleared at match end, so the room has to ready up again.
a.room.send("ready", { ready: true });
b.room.send("ready", { ready: true });
await waitFor(a, () => [...state(a).players.values()].every((p) => p.ready), "all ready again");
a.room.send("startMatch");
await waitFor(a, () => phase(a) === "countdown", "replay countdown");
check("new match started", state(a).round === 1, `round=${state(a).round}`);
check("scores reset", me(a).roundWins === 0 && me(b).roundWins === 0);

a.stop();
b.stop();
await a.room.leave();
await b.room.leave();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
