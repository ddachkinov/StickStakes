/**
 * Reachability test for every shipped map.
 *
 * A map is broken if part of its geometry can't be reached on foot — a girder
 * hung higher than a jump can carry you is scenery, not a platform, and worse,
 * a fighter knocked down to it has nowhere to go.
 *
 * This drives the REAL shared physics step (`stepBody`, the exact code the
 * server and the client run) through simulated jumps between every platform
 * pair, and grows a reachable set from two seeds:
 *
 *   - the spawn tiers      — nobody starts a life stranded
 *   - the lowest floor      — a fighter who falls to the deck can climb back to
 *                             the fight without crossing a hazard to do it
 *
 * Foundry used to pass the first and fail the second: its spawns sat on the
 * girders, but the only way up from the deck was over a saw blade.
 *
 * Pure node, no server — the thing under test is `shared/`. Run it any time:
 * `npm run test:maps`. Exits non-zero on the first stranded surface.
 */
import {
  MAX_KNOCKBACK,
  NEUTRAL_INPUT,
  PLAYER_WIDTH,
  WORLD_MAPS,
  stepBody,
} from "@stickstakes/shared";

const FIXED_DT = 1 / 30;

/**
 * Fire a body at a solid's side at the hardest knockback the game can produce
 * and check the discrete collision pass actually stops it. A single 30 Hz tick
 * at `MAX_KNOCKBACK` covers ~30 px, so anything thinner than that would be
 * skipped clean over without `stepBody`'s substepping. Only the first few ticks
 * matter — the body crosses the solid's whole width in one or two — so gravity
 * has no time to drop it out of the solid's band and cause a false pass.
 */
function tunnelsThrough(world, solid) {
  for (const dir of [1, -1]) {
    const nearFace = dir > 0 ? solid.x : solid.x + solid.width;
    const farFace = dir > 0 ? solid.x + solid.width : solid.x;
    const body = {
      x: nearFace - dir * (PLAYER_WIDTH / 2 + 4),
      // Feet at the bottom face: the 56 px body then spans the solid upward.
      y: solid.y + solid.height,
      vx: dir * MAX_KNOCKBACK,
      vy: 0,
      facing: dir,
      grounded: false,
      coyote: 0,
      jumpBuffer: 0,
      jumpHeld: false,
      jumping: false,
      frozen: false,
      stunned: false,
    };
    for (let t = 0; t < 4; t++) {
      stepBody(body, NEUTRAL_INPUT, FIXED_DT, world);
      const centrePastFar =
        dir > 0 ? body.x - PLAYER_WIDTH / 2 > farFace : body.x + PLAYER_WIDTH / 2 < farFace;
      if (centrePastFar) return true;
    }
  }
  return false;
}

/**
 * Can a body standing on `from` get onto `to`? Sweeps launch positions along
 * `from`, both hold directions plus straight up, and a range of jump-timing
 * delays (including "never jump", i.e. walk or drop across). True if any
 * combination ends grounded on `to`'s top face.
 */
function canReach(map, from, to) {
  const world = { solids: map.solids, killPlaneY: map.killPlaneY };
  const x0 = Math.max(from.x, 0);
  const x1 = Math.min(from.x + from.width, 960);
  for (let i = 0; i <= 10; i++) {
    const startX = x0 + ((x1 - x0) * i) / 10;
    for (const hdir of [-1, 0, 1]) {
      for (const jumpDelay of [0, 1, 2, 3, 4, 6, 8, 12, Infinity]) {
        const body = {
          x: startX,
          y: from.y,
          vx: 0,
          vy: 0,
          facing: 1,
          grounded: true,
          coyote: 4,
          jumpBuffer: 0,
          jumpHeld: false,
          jumping: false,
          frozen: false,
          stunned: false,
        };
        for (let t = 0; t < 100; t++) {
          const input = {
            left: hdir < 0,
            right: hdir > 0,
            jump: t >= jumpDelay,
            attack: false,
          };
          if (stepBody(body, input, FIXED_DT, world)) break; // fell off the world
          const landed =
            body.grounded &&
            Math.abs(body.y - to.y) < 1.5 &&
            body.x > to.x - PLAYER_WIDTH / 2 &&
            body.x < to.x + to.width + PLAYER_WIDTH / 2;
          if (landed) return true;
        }
      }
    }
  }
  return false;
}

/** Grow `seedIndices` until no further surface can be jumped to. */
function reachableFrom(map, surfaces, seedIndices) {
  const reached = new Set(seedIndices);
  let grew = true;
  while (grew) {
    grew = false;
    for (const to of surfaces) {
      if (reached.has(to.index)) continue;
      for (const from of surfaces) {
        if (!reached.has(from.index)) continue;
        if (canReach(map, from, to)) {
          reached.add(to.index);
          grew = true;
          break;
        }
      }
    }
  }
  return reached;
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

for (const map of WORLD_MAPS) {
  const surfaces = map.solids.map((s, index) => ({ ...s, index }));
  const surfaceUnder = (spawn) =>
    surfaces.find(
      (s) =>
        spawn.x >= s.x - 2 &&
        spawn.x <= s.x + s.width + 2 &&
        Math.abs(spawn.y - s.y) < 2,
    );

  // Every spawn point has to put the player down on something solid.
  const floating = map.spawns.filter((sp) => !surfaceUnder(sp));
  check(
    `${map.name}: all ${map.spawns.length} spawns stand on a solid`,
    floating.length === 0,
    floating.map((sp) => `(${sp.x},${sp.y})`).join(", "),
  );

  // From the spawn tiers, every solid is reachable.
  const spawnSeeds = [
    ...new Set(
      map.spawns
        .map(surfaceUnder)
        .filter(Boolean)
        .map((s) => s.index),
    ),
  ];
  const fromSpawns = reachableFrom(map, surfaces, spawnSeeds);
  const strandedFromSpawns = surfaces.filter((s) => !fromSpawns.has(s.index));
  check(
    `${map.name}: all ${surfaces.length} solids reachable from the spawn tiers`,
    strandedFromSpawns.length === 0,
    strandedFromSpawns.map((s) => `${s.kind ?? "solid"} (${s.x},${s.y})`).join(", "),
  );

  // From the lowest floor, every solid is reachable — the check for a fighter
  // knocked down to the deck mid-round.
  const floorY = Math.max(...surfaces.map((s) => s.y));
  const floorSeeds = surfaces
    .filter((s) => s.y >= floorY - 2)
    .map((s) => s.index);
  const fromFloor = reachableFrom(map, surfaces, floorSeeds);
  const strandedFromFloor = surfaces.filter((s) => !fromFloor.has(s.index));
  check(
    `${map.name}: all ${surfaces.length} solids reachable from the floor`,
    strandedFromFloor.length === 0,
    strandedFromFloor
      .map((s) => `${s.kind ?? "solid"} (${s.x},${s.y}), ${Math.round(floorY - s.y)}px up`)
      .join(", "),
  );

  // No tunnelling: a body launched at every blocking solid at MAX_KNOCKBACK has
  // to be stopped by it. One-way platforms are meant to be passed through
  // sideways, so they're exempt.
  const world = { solids: map.solids, killPlaneY: map.killPlaneY };
  const blockers = map.solids.filter((s) => !s.oneWay);
  const tunnelled = blockers.filter((s) => tunnelsThrough(world, s));
  check(
    `${map.name}: no solid tunnels at MAX_KNOCKBACK (${blockers.length} blockers)`,
    tunnelled.length === 0,
    tunnelled.map((s) => `${s.kind ?? "solid"} ${s.width}×${s.height} @(${s.x},${s.y})`).join(", "),
  );
}

console.log(
  failures === 0
    ? `\nall ${WORLD_MAPS.length} maps clear`
    : `\n${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
