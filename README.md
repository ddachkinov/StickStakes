# StickStakes

A stickman brawler for settling who pays. Somebody loses, and the scoreboard
says who is buying lunch. Play it at <https://play.groundpoint.net>.

Up to 10 players from a four-letter room code, on whatever phones are already
on the table. See [`PLAN.md`](./PLAN.md) for the product idea; this file is the
state of the code.

**Want to hack on it?** [`CONTRIBUTING.md`](./CONTRIBUTING.md) is the short
version: clone, `npm install`, `npm run dev`, open two tabs. No database, no
API keys, no Docker — Node 22 and nothing else.

> It is a joke tracker, not a betting app. No payments, no wallets, no money
> moves anywhere. The stake is free text and the result is a scoreboard.

## Repo shape

```
shared/   types, constants, the physics step BOTH sides run, and the wire schema
server/   Colyseus room, authoritative 30Hz fixed timestep
client/   Vite + canvas renderer + touch controls
scripts/  dev tunnel + QR for phone testing, and the maintainer deploy script
test/     integration suites that run against a live server
```

`shared/` is the load-bearing one. `stepBody()` lives there and is called by the
server inside its fixed timestep *and* by the client's reconciler when it
replays unacknowledged inputs. The server's `Player` schema declares exactly the
fields of `PlayerBody`, so a decoded schema instance can be handed straight to
the shared step — there is a compile-time assertion in `shared/src/schema.ts`
that breaks the build if the two ever drift apart.

## Running it

```bash
npm install
npm run dev            # shared (tsc --watch) + server :2567 + client :5173
```

Open <http://localhost:5173> in two tabs and you have two stickmen. Keyboard:
arrows or WASD to move, space to jump, J to attack.

On touch, the left half of the screen is a floating stick: put a thumb down
anywhere in it and that spot becomes the origin, then drag right or left to run.
Drag far enough and the origin trails your thumb, so you can cross the whole
arena on one stroke and still turn around with a short flick. Nothing is drawn
there until you touch it. The right half keeps two real buttons, jump and
attack; both thumbs work at once.

### On a phone

```bash
npm run dev:phone      # same as `dev`, plus a Cloudflare quick tunnel + QR code
```

Scan the QR. You get HTTPS for free — which the fullscreen API, vibration,
screen-wake-lock and PWA install all require — and friends can join over
cellular, which matters when you are testing in a restaurant. Vite HMR works
through the tunnel. Quick-tunnel hostnames are random and change on every
restart, so the QR is regenerated each session.

Dev builds load [eruda](https://github.com/liriliri/eruda), so there is a
floating devtools console on the phone itself — no tethering to a laptop.

Other scripts: `npm run build`, `npm run typecheck`, `npm start` (server only),
`npm run tunnel` (tunnel alone, against an already-running client).

### Testing

Every suite runs against a RUNNING server, because the things worth asserting
here are the ones that only exist once two clients and an authoritative tick are
talking to each other.

```bash
npm run dev    # in one terminal
npm test       # in another — lobby, match, combat, feel
```

- **`test:lobby`** — room codes are short and unique, joining by code lands you
  in the right room, a bad code fails cleanly, the room fills to exactly
  `MAX_PLAYERS`, and `configure` is host-only and validated.
- **`test:match`** — plays a whole match to completion and asserts the state
  machine: host-only start, countdown freeze, life loss, respawn, elimination,
  round scoring, the match winner, and replay.
- **`test:combat`** — damage accrual, knockback direction and scaling against
  the formula, hitstun, one hit per swing, i-frames, and death by knockback.
- **`test:feel`** — drives a real fight in front of a real headless browser and
  asserts the *feedback* fired: hits counted, sparks spawned, the camera
  actually moved, audio unlocked, mute remembered. Feedback has no server-side
  truth to check against, so this is the only honest way to test it.

Each exits non-zero on the first failed expectation. They all run in CI on every
pull request (`.github/workflows/ci.yml`), alongside typecheck and a production
build — so a contributor gets feedback without waiting on a review, and `main`
can require the checks to pass before a merge.

`test:feel` needs a Chromium. It uses `playwright-core`, which ships no browser,
so nobody pays a 500MB download just to run the game — it finds an installed
Chrome or Edge automatically, or you can point `CHROME_PATH` at one. Without a
browser it SKIPS rather than fails; set `FEEL_REQUIRE_BROWSER=1` in CI to make a
missing browser an error instead.

Point any suite at a different server with `SERVER_URL` — useful for running the
whole thing against a production build (`npm start`) rather than the dev stack.

> On Windows, Vite'''s file watcher sometimes misses a whole-file rewrite, so the
> browser keeps serving the previous CSS or HTML. If a change appears not to
> apply, restart the dev server rather than hunting for a bug in your code.

## The match loop

```
lobby ──host starts──> countdown ──> playing ──> roundOver ─┬─> countdown
  ^                                                          └─> matchOver
  └──────────────────── host plays again ────────────────────────┘
```

Three rounds, three lives each, first to two rounds takes the match. Fall off and
you lose a life, come back after ~1.2s with brief i-frames; at zero lives you sit
out the rest of the round. The round ends when one fighter is left standing.

The first player to join is the host and the only one whose start/replay button
does anything — the server checks the session id rather than trusting the client.
Join mid-match and you spectate until the next round. Alone in the room, a round
never ends, which makes it a practice mode you can test on one phone.

All match timing is in **server ticks**, not wall-clock: `phaseEndsAtTick` is
compared against the synced `tick`, so countdowns need no clock alignment and no
per-tick timer messages.

`frozen` is a synced field on each player that both the server step and the
client reconciler honour, so a countdown or a death freezes prediction in
lock-step with the server instead of rubber-banding against it.

## Getting into a game

The landing screen asks for a name, then either creates a game or joins one by
code. Creating gives you a **4-letter room code** — that's the room's actual
Colyseus id, replaced in `onCreate` and collision-checked against the
matchmaker, so `joinById(code)` needs no lookup table. The alphabet has no
I/O/0/1 in it, because these get read aloud across a noisy table.

The code also goes in the URL (`?code=ABCD`), so the host can share a link
instead of dictating letters, and a reload rejoins the same game.

Up to 10 players. The host — the first to join — sets rounds, lives, and the
**stake**: free text saying what's actually riding on the match. Everyone sees
it in the lobby, and the end screen repeats it back under the winner's name,
with final standings, a share button, and a split-the-bill helper.

That layer is a **joke tracker and nothing else**. No amounts are stored, sent
or settled; the split helper divides a number the user types and shows the
answer. The moment real money moves through it, it becomes a gambling product
with the app-store and payment-services rules that implies.

## Combat

No health bars — you die by leaving the arena. Damage is purely a **knockback
multiplier**: launch speed is \`KNOCKBACK_BASE + damage × KNOCKBACK_SCALING\`, so
a fresh stickman barely budges and one at 120% flies off the map. That is what
makes a comeback possible, and what makes "he's at 140, don't let him touch you"
a real thing to shout across a table. Damage resets on every respawn.

A swing runs **startup → active → recovery**; only the active frames carry a
hitbox, so an attack is a commitment rather than a free button. A hit deals
damage, launches the target away from the attacker, and applies hitstun.

Hitstun is a synced \`stunned\` flag distinct from \`frozen\`: it takes the controls
away but leaves physics running, so you keep flying along the arc the hit gave
you. Because both sides honour it inside \`stepBody\`, the client reconciler
replays a knockback exactly as the server produced it.

Each target can be hit at most once per swing, so holding the button down does
not machine-gun damage. Fresh-spawn i-frames make you briefly unhittable.

## How the netcode fits together

One URL, one origin. The client always reaches Colyseus through a same-origin
`/colyseus` prefix that Vite proxies in dev, so a phone only ever learns one
hostname and there is no CORS and no mixed content behind an HTTPS tunnel.

- The server runs `setFixedTimestep(..., 30)`. One input frame == one fixed step
  == one broadcast tick. It consumes exactly one buffered input per player per
  step (`inputs.get(sid).next()`) — draining the buffer and applying only the
  newest would acknowledge inputs that were never simulated, and the client's
  replay would then disagree.
- Clients send **intent only** (`left`/`right`/`jump`/`attack`). No client ever
  sends a position.
- Remote stickmen are drawn ~100ms behind the newest snapshot and interpolated
  (`predict.attachAll("players", { x: "lerp", y: "lerp" })`).
- Your own stickman is reconciled: each input is applied locally the instant it
  is sent, and when server truth arrives the client rewinds to it and replays
  whatever is still in flight, through the same `stepBody`.

Both prediction and interpolation are read through one idiom,
`predict.value(player, "x")` — reconciled for you, interpolated for everyone
else.

## Feel

Presentation only — none of this touches the simulation, and deleting all of it
would leave a game that plays identically.

- **Screen shake** is trauma-based: the offset is trauma *squared*, so a heavy
  hit reads as far more than twice a light one. The squaring is a calibration
  trap, though — trauma below ~0.5 lands under a pixel, present in the numbers
  and invisible on the glass. The values in `client/src/fx.ts` are chosen from
  the pixels they produce, and `test:feel` asserts a hit moves the camera more
  than 3px rather than merely "not zero".
- **Particles** are pooled and capped, so a four-player brawl degrades by
  dropping the oldest spark instead of dropping frames. Hit sparks fly along the
  knockback arc; landing raises dust only on a real drop.
- **`prefers-reduced-motion`** removes shake entirely and cuts particles to a
  third. Sound and vibration are unaffected — that preference is about motion.
- **Vibration** fires only for things that happened to *you*. Buzzing on every
  remote hit turns a four-player fight into a permanently rattling phone.
  Android honours it; iOS Safari ignores it silently, so it degrades to nothing.

### Sound, and swapping in real recordings

Every cue is synthesised from oscillators and noise in `client/src/audio.ts`, so
the game ships with audio, zero asset bytes and no licences. That is a
placeholder, not a destination: drop a file into `client/public/sounds/` and name
it in that folder's `index.json` and it replaces the synth for that cue, with no
change to any calling code. See `client/public/sounds/README.md`.

Audio cannot start until the browser has seen a real gesture, so the first tap
or keypress unlocks it. The 🔊 button mutes, and remembers.

## Deploying

One container is the whole game: it serves the built client at `/` and runs the
authoritative room on the same origin, so the link you hand someone is a single
hostname over HTTPS/WSS.

```bash
npm run build          # shared -> server -> client
npm start              # serves client/dist AND the game on :2567
```

`npm start` is exactly what the server runs, so you can reproduce production
locally before pushing.

> **One process. Not negotiable.** Rooms live in the process's memory, because
> Colyseus defaults to `LocalPresence` + `LocalDriver`. Run two and a room
> created by one is invisible to the other, so roughly half of all code joins
> fail with "not found" — a bug that looks random and is miserable to chase.
> This is why `ecosystem.config.cjs` pins `exec_mode: "fork"` with
> `instances: 1`; pm2's cluster mode would break the game outright. Scaling past
> one process means adding `@colyseus/redis-presence` and
> `@colyseus/redis-driver` first.

### The VPS (play.groundpoint.net)

nginx terminates TLS and proxies everything to the Node process on
`127.0.0.1:2567`, which serves both the built client and the game.

```bash
npm run deploy   # push main, then run /srv/stickstakes/deploy.sh over ssh
npm run logs     # tail pm2 logs
```

**Both are maintainer-only.** They need an SSH host alias `gp` that only the
maintainer has; `npm run deploy` checks for it and exits with an explanation
rather than a wall of ssh errors, and refuses to run from a branch other than
`main` (the VPS pulls `main` with `--ff-only`, so deploying a side branch would
be a no-op at best). Contributors deploy nothing — merged pull requests go live
when the maintainer deploys.

`deploy.sh` pulls, installs, builds and `pm2 reload`s. It runs
`npm ci --include=dev` on purpose: the build needs `typescript` and `vite`,
which are devDependencies, and a plain `npm ci` skips them whenever
`NODE_ENV=production` is set in the environment — failing later with a
confusing `tsc: not found`.

**Every deploy ends the games in progress.** `pm2 reload` restarts the process
and rooms are in-memory, so players are dropped with close code 4001
(`SERVER_SHUTDOWN`). The client catches exactly that code and says the server
restarted, rather than offering a reconnect that could not work. Deploy between
matches, not during one.

nginx must proxy `/` as a whole with WebSocket upgrade headers — a narrower
`location` will not do. The game's socket opens at `/<processId>/<roomId>`,
both of which are assigned at runtime, so there is no fixed path to match on.

**No secrets or env vars are needed.** The app reads only `PORT` (default 2567)
and `NODE_ENV`, both set in `ecosystem.config.cjs`. There is no database, no API
key and no `.env`.

### Fly.io (alternative)

`Dockerfile` and `fly.toml` are still in the repo and still work if you would
rather run it as a container — `fly deploy`. The same one-process rule applies,
and `fly.toml` pins a single machine for it. `primary_region` is `otp`
(Bucharest), the closest region to Sofia; region choice is the single biggest
lever on RTT for a 30Hz authoritative tick.

### Installing it on a phone

The client is a PWA: manifest, maskable icons, and a small service worker. On a
deployed HTTPS URL the browser will offer "Add to Home Screen", and it launches
fullscreen in landscape with no browser chrome.

The worker makes no pretence of offline play — this is a multiplayer game, it is
useless without a network. It exists so the app is installable at all (a fetch
handler is part of the install criteria) and so a repeat launch is instant. It
never touches matchmaking or gameplay traffic.

The screen also holds a wake-lock while you are in a game, so the phone does not
dim mid-round, and re-takes it when you come back to the tab — browsers drop the
lock whenever the page is hidden, and forgetting to re-acquire is the usual bug.

## Not built yet

The colour picker, weapons, and the shrinking platform. Matter.js is not a dependency yet — the
character controller in `shared/src/physics.ts` is a deliberately small
deterministic AABB stepper, which is what prediction and replay need; Matter.js
comes in with ragdolls, where determinism matters less.
