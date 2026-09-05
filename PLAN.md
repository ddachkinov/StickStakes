# StickStakes — the plan

A stickman brawler for a table of bored people. Host taps **Create**, gets a
4-letter code, everyone else opens the URL, types the code, picks a colour.
Host sets rounds, lives, and **the stake**. Fight. Scoreboard names who pays.

## Tech

- **Client** — plain canvas + Matter.js for ragdoll physics. PWA, so it's
  add-to-homescreen with no install.
- **Server** — Colyseus (Node). Rooms, room IDs and state sync out of the box;
  map a 4-char code onto a room ID.
- **Authoritative server tick at 30Hz.** Phones send input intent only
  (left/right/jump/attack), the server runs physics and broadcasts state.
  Clients interpolate ~100ms behind. Never trust the client — otherwise the guy
  who owes lunch opens devtools.
- **Deploy** — a single Fly.io or Railway container, one region. Everyone is on
  the same restaurant wifi anyway.

## Controls — this is where it lives or dies

Left thumb steers with a floating stick: put a thumb down anywhere in the left
half and drag left or right. Nothing is drawn there until you touch it, so the
left half of the arena stays clear. Right thumb gets one attack button and one
jump button. Two buttons, maximum. Landscape, and generous hitboxes, because
people hold a phone in one hand.

## Combat

Keep it dumb. Ragdoll knockback, a shrinking platform, weapons that spawn at
random (sword, gun, grenade). A round ends when one stickman is left. Death by
falling off, not health bars — that reads instantly on a 6" screen.

## The stakes layer (the actual differentiator)

- Setup screen: "Best of 5" or "10 minutes", plus a free-text stake
  ("loser pays for the winner's meal").
- Running ledger: a card after each round showing who owes what.
- End screen: big result graphic, shareable to the group chat. Maybe a
  split-the-bill helper — enter the total, it shows what each non-winner owes.
- **Don't touch real money.** No payments, no wallets. The moment you process
  funds you are in app-store gambling policy and BG payment-services territory.
  It stays a joke tracker.

## MVP scope

4 players, one arena, one weapon, 3 rounds x 3 lives, room codes, stake text.

## Repo shape

    /server   Colyseus room, authoritative tick
    /client   Vite, canvas, touch controls
    /shared   types, constants, the physics step BOTH sides run

`/shared` is the one people forget and regret: client prediction and server
truth have to run identical code.

## Testing on a phone, hands-off

Cloudflare quick tunnel + QR code (`npm run dev:phone`). HTTPS for free, which
you need for the fullscreen API, vibration, screen-wake-lock and PWA install —
and friends can join from cellular data, which matters when you are testing in
an actual restaurant. Vite HMR works through the tunnel, so the loop is: edit,
the phone reloads itself, thumbs stay on the glass. `eruda` gives you a
floating devtools console on the phone in dev builds.

Quick-tunnel URLs change on every restart, so the QR is regenerated each
session. Once you are testing with real people, deploy and use a stable URL.

## Status

**Step 1 done** — monorepo scaffolded, Colyseus server and Vite client talking,
stickmen moving on a shared canvas.

**Track A done** — the core loop. Rounds, lives, elimination, host-driven
start/replay, and the between-round screens. `npm run test:match` plays a whole
match headless and asserts the state machine.

**Track B done** — combat. Hitboxes, damage-scaled knockback, hitstun.
`npm run test:combat` asserts the numbers against a running server.

**Track C done** — the stakes layer. Room codes, join screen, stake text,
ledger, shareable result, 10 players. `npm run test:lobby` covers the codes.

**Track D done** — ship it. Installable PWA, screen wake-lock, and one
container that serves the built client and the authoritative room on a single
origin. `Dockerfile` + `fly.toml` are ready; `fly deploy` is the last step.

**Track E done** — juice. Trauma-based camera shake, hit sparks and landing
dust, synthesised audio with a sample-swap slot, and vibration for the things
that happen to you. `npm run test:feel` drives a real fight in front of a real
browser and asserts the feedback actually fired.

That is the MVP. What is left is the stuff you only find out by playing it with
bored people at a table: tuning, weapons, the shrinking platform, a colour
picker.

See `README.md` for what exists today and "Not built yet" for the gaps.
