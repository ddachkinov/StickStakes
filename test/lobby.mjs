/**
 * Integration test for room codes and host setup (Track C).
 *
 * Asserts against a RUNNING server: codes are short and unique, joining by
 * code lands you in the right room, a bad code fails cleanly, the room fills
 * to exactly MAX_PLAYERS, and `configure` is host-only and validated.
 *
 * Start the stack first (`npm run dev`), then `npm run test:lobby`.
 * Exits non-zero on the first failed expectation, so CI can gate on it.
 */
import { Client } from "@colyseus/sdk";
import {
  DEFAULT_STAKE,
  MAX_PLAYERS,
  MAX_STAKE_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_NAME,
} from "@stickstakes/shared";

const ENDPOINT = process.env.SERVER_URL ?? "http://localhost:2567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new Client(ENDPOINT);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const opened = [];
const track = (room) => (opened.push(room), room);

console.log("\n=== codes ===");
const rooms = [];
for (let i = 0; i < 3; i++) {
  rooms.push(track(await client.create(ROOM_NAME, { name: `HOST${i}` })));
}
await sleep(400);

const codes = rooms.map((r) => r.roomId);
const codePattern = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
check("codes use the speakable alphabet", codes.every((c) => codePattern.test(c)), codes.join(" "));
check("codes are unique", new Set(codes).size === codes.length);

console.log("\n=== joining ===");
const code = codes[1];
const guest = track(await client.joinById(code, { name: "GUEST" }));
await sleep(400);
check("joinById lands in the right room", guest.roomId === code, `${guest.roomId} vs ${code}`);
check("host sees the guest", rooms[1].state.players.size === 2, `${rooms[1].state.players.size}`);

let badCodeError = "";
try {
  await client.joinById("ZZZZ", { name: "NOPE" });
} catch (error) {
  badCodeError = String(error.message ?? error);
}
check("an unknown code is refused", /not found/i.test(badCodeError), badCodeError.slice(0, 60));

console.log("\n=== capacity ===");
for (let i = 0; opened.length < MAX_PLAYERS + 2 && i < MAX_PLAYERS; i++) {
  try {
    track(await client.joinById(code, { name: `P${i}` }));
  } catch {
    break;
  }
}
await sleep(600);
check(
  `the room fills to exactly ${MAX_PLAYERS}`,
  rooms[1].state.players.size === MAX_PLAYERS,
  `${rooms[1].state.players.size}/${MAX_PLAYERS}`,
);

let overflowError = "";
try {
  await client.joinById(code, { name: "OVERFLOW" });
} catch (error) {
  overflowError = String(error.message ?? error);
}
check("one more is refused", overflowError !== "", overflowError.slice(0, 40));

console.log("\n=== host setup ===");
rooms[1].send("configure", {
  totalRounds: 5,
  livesPerRound: 2,
  stake: "Loser pays for the rakia",
});
await sleep(400);
check("rounds applied", rooms[1].state.totalRounds === 5, `${rooms[1].state.totalRounds}`);
check("lives applied", rooms[1].state.livesPerRound === 2, `${rooms[1].state.livesPerRound}`);
check("win target recomputed", rooms[1].state.roundWinsToTakeMatch === 3,
  `${rooms[1].state.roundWinsToTakeMatch}`);
check("stake applied", rooms[1].state.stake === "Loser pays for the rakia");
check("everyone sees the same stake", guest.state.stake === rooms[1].state.stake);

console.log("\n=== only the host may configure ===");
guest.send("configure", { totalRounds: 7, livesPerRound: 5, stake: "HACKED" });
await sleep(400);
check("a guest's setup is ignored",
  rooms[1].state.totalRounds === 5 && rooms[1].state.stake === "Loser pays for the rakia",
  `rounds=${rooms[1].state.totalRounds} stake="${rooms[1].state.stake}"`);

console.log("\n=== values are validated, not trusted ===");
rooms[1].send("configure", { totalRounds: 999, livesPerRound: 200, stake: "x".repeat(500) });
await sleep(400);
check("out-of-range rounds rejected", rooms[1].state.totalRounds === 5, `${rooms[1].state.totalRounds}`);
check("out-of-range lives rejected", rooms[1].state.livesPerRound === 2, `${rooms[1].state.livesPerRound}`);
check("an oversized stake is truncated",
  rooms[1].state.stake.length === MAX_STAKE_LENGTH, `${rooms[1].state.stake.length} chars`);

rooms[1].send("configure", { stake: "   " });
await sleep(300);
check("a blank stake falls back to the default", rooms[1].state.stake === DEFAULT_STAKE,
  `"${rooms[1].state.stake}"`);

console.log("\n=== rename ===");
guest.send("rename", { name: "Dimitar Dachkinov is far too long" });
await sleep(400);
const renamed = rooms[1].state.players.get(guest.sessionId)?.name ?? "";
check("rename applied and clamped", renamed === "Dimitar Dach", `"${renamed}"`);

console.log("\n=== wardrobe ===");
// A fresh room — the one above is filled to capacity.
const wHost = track(await client.create(ROOM_NAME, { name: "PLAIN" }));
await sleep(200);
const dressed = track(
  await client.joinById(wHost.roomId, { name: "STYLE", color: "#ABCDEF", hat: "crown" }),
);
await sleep(400);
const dressedOnHost = () => wHost.state.players.get(dressed.sessionId);
check("join colour applied and lower-cased", dressedOnHost()?.color === "#abcdef", dressedOnHost()?.color);
check("join hat applied", dressedOnHost()?.hat === "crown", dressedOnHost()?.hat);

dressed.send("customize", { color: "not-a-colour", hat: "sombrero" });
await sleep(300);
check(
  "junk customise is dropped, not applied",
  dressedOnHost()?.color === "#abcdef" && dressedOnHost()?.hat === "crown",
  `color=${dressedOnHost()?.color} hat=${dressedOnHost()?.hat}`,
);

dressed.send("customize", { color: "#112233", hat: "party" });
await sleep(300);
check(
  "a valid customise restyles the player",
  dressedOnHost()?.color === "#112233" && dressedOnHost()?.hat === "party",
  `color=${dressedOnHost()?.color} hat=${dressedOnHost()?.hat}`,
);

wHost.send("customize", { hat: "halo" });
await sleep(300);
check("customise only touches the sender", dressedOnHost()?.hat === "party", `${dressedOnHost()?.hat}`);

console.log("\n=== ready gate ===");
const rHost = track(await client.create(ROOM_NAME, { name: "RHOST" }));
await sleep(200);
const rGuest = track(await client.joinById(rHost.roomId, { name: "RGUEST" }));
await sleep(400);

rHost.send("startMatch");
await sleep(400);
check("host can't start while nobody is ready", rHost.state.phase === "lobby", rHost.state.phase);

rHost.send("ready", { ready: true });
await sleep(300);
rHost.send("startMatch");
await sleep(400);
check("host still can't start with a guest not ready", rHost.state.phase === "lobby", rHost.state.phase);

rGuest.send("ready", { ready: true });
await sleep(300);
check("both players show ready",
  [...rHost.state.players.values()].every((p) => p.ready),
  [...rHost.state.players.values()].map((p) => p.ready).join(","));

rHost.send("startMatch");
await sleep(400);
check("host starts once everyone is ready", rHost.state.phase === "countdown", rHost.state.phase);

await sleep(200);
check("ready flags are cleared for the new match",
  [...rHost.state.players.values()].every((p) => !p.ready),
  [...rHost.state.players.values()].map((p) => p.ready).join(","));

for (const room of opened) {
  try {
    await room.leave();
  } catch {
    /* already gone */
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
