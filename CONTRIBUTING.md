# Contributing to StickStakes

Thanks for taking a look. This is a small game with a deliberately small
codebase — you should be able to read all of it in an afternoon.

## Getting it running

You need **Node 22+** and nothing else. No database, no API keys, no `.env`,
no Docker.

```bash
git clone https://github.com/ddachkinov/StickStakes.git
cd StickStakes
npm install
npm run dev
```

Open <http://localhost:5173> in **two browser tabs** — you need two players for
anything interesting to happen. Create a game in the first tab, copy the
four-letter code, join with it in the second.

Keyboard controls: arrows or WASD to move, space to jump, **J** to attack. On a
touchscreen the left half of the screen is a floating drag stick and the right
half has jump and attack.

`npm run dev` starts three things at once: `tsc --watch` on `shared/`, the
Colyseus server on `:2567`, and Vite on `:5173`. Vite proxies `/colyseus` to the
server, so the browser only ever talks to one origin.

### Testing on your phone

```bash
npm run dev:phone
```

Same as `npm run dev`, plus a Cloudflare quick tunnel and a QR code in your
terminal. Scan it. You get HTTPS for free, which the fullscreen API, vibration,
wake-lock and install-to-homescreen all require, and friends can join over
cellular. Dev builds also load [eruda](https://github.com/liriliri/eruda), which
puts a devtools console on the phone itself.

## How the code is laid out

```
shared/   constants, types, the physics step BOTH sides run, the wire schema
server/   Colyseus room, authoritative 30Hz fixed timestep
client/   Vite + canvas renderer + touch controls
test/     integration suites that run against a live server
```

**`shared/` is the load-bearing one.** `stepBody()` lives there and is called by
the server inside its fixed timestep *and* by the client's reconciler when it
replays unacknowledged inputs. If those two ever disagree you get rubber-banding.
The server's `Player` schema declares exactly the fields of `PlayerBody`, and
there is a compile-time assertion in `shared/src/schema.ts` that breaks the build
if they drift apart.

A few rules that are not style preferences — breaking them breaks the game:

- **Clients send intent, never position.** `left`/`right`/`jump`/`attack` and
  nothing else. The server owns every coordinate.
- **The physics step must stay deterministic.** No `Math.random()`, no
  `Date.now()`, no wall-clock `dt` inside `stepBody`. Replay has to reproduce
  the server's result exactly.
- **One server process.** Rooms live in process memory. See the note in
  `README.md` before you reach for clustering.

`README.md` has more on the netcode, the match loop, and how feedback is wired.

## Tests

Every suite runs against a **running server**, because the things worth
asserting only exist once two clients and an authoritative tick are talking.

```bash
npm run dev    # one terminal
npm test       # another — lobby, match, combat, feel
```

| Suite | What it covers |
| --- | --- |
| `test:lobby` | Room codes, join-by-code, capacity, host-only configuration |
| `test:match` | The whole state machine: start, rounds, lives, elimination, replay |
| `test:combat` | Damage, knockback direction and scaling, hitstun, i-frames |
| `test:feel` | Drives a real fight in a real browser and asserts the feedback fired |

`test:feel` needs a Chromium. It uses `playwright-core`, which ships without one
so nobody pays a ~500MB download just to play the game — it finds an installed
Chrome or Edge automatically, or you can point `CHROME_PATH` at a binary, or run
`npx playwright-core install chromium`. Without a browser it skips rather than
fails.

If you touch physics, combat or the match flow, please add or extend a check.
The suites are plain `.mjs` with a one-line `check()` helper — no framework to
learn.

## Sending a pull request

`main` is protected: it takes changes through pull requests only.

1. Branch off `main` — `git checkout -b my-change`.
2. Make the change. Match the surrounding code: it favours explaining *why* in
   comments over restating *what*.
3. Run `npm run typecheck` and `npm test` locally.
4. Open a PR. CI runs typecheck, build and all four suites on it automatically,
   so you don't have to wait on a review to find out something broke.
5. A maintainer reviews and merges.

Small, focused PRs get read and merged quickly. If you are planning something
large — a new weapon system, swapping the renderer — open an issue first so we
can agree on the shape before you spend an evening on it.

### Things worth doing

The MVP is complete, so what is left is the stuff you only learn by playing it:

- Weapons that spawn in the arena (sword, gun, grenade).
- A platform that shrinks as the round goes on.
- A colour picker in the lobby.
- Tuning. Jump height, knockback, shake — all constants in `shared/` and
  `client/src/fx.ts`, all guesses that have not met enough real thumbs.

## Deploying

You cannot, and that is fine — deployment is maintainer-only. `npm run deploy`
pushes to `main` and then runs a script on the production VPS over SSH; it needs
an SSH host alias only the maintainer has, and it will simply fail for anyone
else. Merged PRs reach <https://play.groundpoint.net> when the maintainer
deploys.
