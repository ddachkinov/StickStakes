/**
 * Integration test for Track E — the feedback layer.
 *
 * Feedback is the one part of the game with no server-side truth to assert
 * against, so this drives a REAL fight and checks that a real browser reacted:
 * hits counted, sparks spawned, the camera actually moved, sound unlocked.
 *
 * A headless browser hosts the room; two SDK clients join by code and fight in
 * front of it. That way the fighting logic stays plain node (fast, reliable)
 * while the thing under test is the actual client running the actual renderer.
 *
 * Start the stack first (`npm run dev`), then `npm run test:feel`.
 * Exits non-zero on the first failed expectation, so CI can gate on it.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { Client } from "@colyseus/sdk";
import { ATTACK_RECOVERY_MS, SPAWN_IFRAME_MS } from "@stickstakes/shared";

const ENDPOINT = process.env.SERVER_URL ?? "http://localhost:2567";
const PAGE_URL = process.env.CLIENT_URL ?? "http://localhost:5173/";
const TICK_MS = 1000 / 30;

/**
 * `playwright-core` deliberately ships no browser, so nobody pays a 500MB
 * download just to run the game. Point CHROME_PATH at a binary, or let this
 * find the Chrome/Edge that is almost certainly already installed.
 */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((path) => path && existsSync(path));
}

const CHROME = findBrowser();
if (!CHROME) {
  const message =
    "no Chrome/Chromium found — set CHROME_PATH to run the feel test";
  if (process.env.FEEL_REQUIRE_BROWSER === "1") {
    console.error(`\nFAIL: ${message}\n`);
    process.exit(1);
  }
  console.log(`\nSKIPPED: ${message}\n`);
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// --- the watching client: a real browser running the real renderer ----------
const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({
  viewport: { width: 812, height: 375 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#landing-create", { timeout: 20000 });
await page.fill("#landing-name", "WATCH");
await page.click("#landing-create"); // also the gesture that unlocks audio
await page.waitForFunction(() => location.search.includes("code="), { timeout: 20000 });
const code = await page.evaluate(() => new URLSearchParams(location.search).get("code"));
console.log(`\n=== watching room ${code} ===`);

const feel = () => page.evaluate(() => globalThis.__ss.feel());
check("dev feel hook is present", (await feel()) !== null);

// --- the fighters: plain SDK clients, same as the combat test ---------------
async function connect(name) {
  const room = await new Client(ENDPOINT).joinById(code, { name });
  const input = room.input({ mode: "reliable" });
  const intent = { left: false, right: false, jump: false, attack: false };
  const pump = setInterval(() => {
    input.data.left = intent.left;
    input.data.right = intent.right;
    input.data.jump = intent.jump;
    input.data.attack = intent.attack;
    input.send();
  }, TICK_MS);
  return { room, intent, stop: () => clearInterval(pump) };
}

const a = await connect("ATK");
const b = await connect("DEF");
await sleep(700);

const state = () => a.room.state;
const atk = () => state().players.get(a.room.sessionId);
const def = () => state().players.get(b.room.sessionId);

async function waitFor(predicate, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return true;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label} (phase=${state().phase})`);
}

console.log("\n=== a round starts ===");
// The server only starts once the whole room — the watching page included —
// has readied up.
a.room.send("ready", { ready: true });
b.room.send("ready", { ready: true });
await page.evaluate(() => globalThis.__ss.ready(true));
await waitFor(
  () => [...state().players.values()].every((p) => p.ready),
  "all ready",
);
await page.evaluate(() => globalThis.__ss.start());
await waitFor(() => state().phase === "playing", "playing");
await sleep(SPAWN_IFRAME_MS + 400);
check("round start was announced", (await feel()).rounds >= 1, `rounds=${(await feel()).rounds}`);

console.log("\n=== jumping and landing ===");
const beforeJump = await feel();
b.intent.jump = true;
await sleep(160);
b.intent.jump = false;
await waitFor(() => def().grounded, "defender to land", 4000);
await sleep(200);
const afterJump = await feel();
check("a jump was heard", afterJump.jumps > beforeJump.jumps, `${beforeJump.jumps} → ${afterJump.jumps}`);
check("the landing raised dust", afterJump.lands > beforeJump.lands, `${beforeJump.lands} → ${afterJump.lands}`);

console.log("\n=== a hit ===");
// Walk the attacker into range, then swing until damage lands.
const BRAKE_GAP = 40;
async function closeIn(timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const gap = def().x - atk().x;
    if (Math.abs(gap) <= BRAKE_GAP) {
      a.intent.left = a.intent.right = false;
      await sleep(200);
      const settled = def().x - atk().x;
      if (Math.sign(settled) !== Math.sign(atk().facing) && settled !== 0) {
        a.intent.right = settled > 0;
        a.intent.left = settled < 0;
        await sleep(70);
        a.intent.left = a.intent.right = false;
        await sleep(160);
      }
      return;
    }
    a.intent.right = gap > 0;
    a.intent.left = gap < 0;
    await sleep(30);
  }
  a.intent.left = a.intent.right = false;
  throw new Error("could not close to attack range");
}

await closeIn();
const beforeHit = await feel();

/*
 * Swing until the WATCHING CLIENT reports a hit, rather than until a specific
 * player's damage moves. The watcher is itself a fighter in this room, so a
 * swing can legitimately land on it instead of DEF — and for a test about
 * FEEDBACK, "a hit was rendered" is the real subject. Whether the right target
 * took it is combat's business, and test:combat already owns that.
 */
let connected = false;
for (let i = 0; i < 6 && !connected; i++) {
  a.intent.attack = true;
  await sleep(200);
  a.intent.attack = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 500 && !connected) {
    connected = (await feel()).hits > beforeHit.hits;
    await sleep(15);
  }
  if (!connected) {
    await sleep(ATTACK_RECOVERY_MS + 60);
    await closeIn(3000);
  }
}
check("the fight actually connected", connected);

// Sample fast: sparks and shake both decay within a few hundred ms.
let sawParticles = 0;
let sawShake = 0;
for (let i = 0; i < 25; i++) {
  const f = await feel();
  sawParticles = Math.max(sawParticles, f.particles);
  sawShake = Math.max(sawShake, Math.abs(f.shakeX));
  await sleep(20);
}
const afterHit = await feel();

check("the swing was heard", afterHit.swings > beforeHit.swings, `${beforeHit.swings} → ${afterHit.swings}`);
check("the hit registered", afterHit.hits > beforeHit.hits, `${beforeHit.hits} → ${afterHit.hits}`);
check("sparks were spawned", sawParticles > 0, `${sawParticles} live at peak`);
/*
 * Measured from `peakShake`, which the fx layer records every frame, rather
 * than from these 20ms polls: the offset is re-randomised each frame and
 * decays in under a third of a second, so polling systematically undersamples
 * the peak and would let a genuinely weak shake pass.
 *
 * And "non-zero" is not the bar. Trauma is squared, so an under-calibrated
 * value is present in the numbers and invisible on the glass — a hit has to
 * actually MOVE the camera.
 */
check(
  "the camera shook visibly",
  afterHit.peakShake > 3,
  `peak=${afterHit.peakShake.toFixed(2)}px (polled |shakeX| peaked at ${sawShake.toFixed(2)})`,
);
check("shake stays within its cap", afterHit.peakShake <= 18.001, `peak=${afterHit.peakShake.toFixed(2)}px`);

console.log("\n=== shake settles again ===");
await sleep(1600);
const settled = await feel();
check("the camera came back to rest", Math.abs(settled.shakeX) < 0.01, `shakeX=${settled.shakeX}`);
check("sparks were cleaned up", settled.particles === 0, `${settled.particles} left`);

console.log("\n=== audio ===");
const audioState = await page.evaluate(() => {
  const ctx = globalThis.__ss.audio;
  return { muted: ctx.muted };
});
check("audio is unmuted by default", audioState.muted === false);
await page.click("#mute");
check("mute toggles", (await page.evaluate(() => globalThis.__ss.audio.muted)) === true);
check(
  "the mute choice is remembered",
  (await page.evaluate(() => localStorage.getItem("stickstakes:muted"))) === "1",
);
await page.click("#mute");
check("unmute toggles back", (await page.evaluate(() => globalThis.__ss.audio.muted)) === false);

console.log("\n=== a death ===");
const beforeDeath = await feel();
b.intent.left = true; // walk the defender off the left edge
await waitFor(() => def().lives < state().livesPerRound || state().phase !== "playing", "a death", 20000);
b.intent.left = false;
await sleep(400);
const afterDeath = await feel();
check("the death registered", afterDeath.deaths > beforeDeath.deaths, `${beforeDeath.deaths} → ${afterDeath.deaths}`);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

a.stop();
b.stop();
await browser.close();

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
