/**
 * Maps and worlds.
 *
 * A `WorldMap` is the whole stage: the collision geometry both sides step
 * against, the hazards the server kills on, the spawn points, and the purely
 * decorative parallax/foreground layers the client draws. Everything that the
 * simulation reads (`solids`, `hazards`, `spawns`, `killPlaneY`) is plain data
 * so the server and the client agree bit-for-bit; everything else is the
 * renderer's problem and never reaches `stepBody`.
 *
 * The host picks the map in the lobby. `ArenaState.mapId` carries the choice,
 * and `getMap()` resolves it on both sides.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  KILL_PLANE_Y,
  PLATFORMS,
  SPAWN_POINTS,
  type Rect,
} from "./constants.js";

/**
 * A solid the character controller collides with.
 *
 * `oneWay` is what makes stacked levels work: you land on the top face but
 * pass up through it from below and never bump it from the side, so a tower
 * of thin beams is climbable without a dedicated drop-through input.
 * `kind` is a hint for the renderer only — the physics treats every solid,
 * `oneWay` aside, identically.
 */
export interface Solid extends Rect {
  oneWay?: boolean;
  kind?: "ground" | "platform" | "beam" | "girder" | "crate" | "pillar" | "ledge";
}

/**
 * A rectangle that costs a life on contact during `playing`. Resolved by the
 * server after every body has moved (same place a fall off the world is), so
 * the client only ever draws these — it never has to predict the death.
 */
export interface Hazard extends Rect {
  kind: "spikes" | "saw" | "pit";
  /** Optional renderer tint for the fallback rectangle look. */
  color?: string;
}

/**
 * One decorative object in a parallax layer. Anchored in arena units; for most
 * shapes `y` is the baseline (bottom) and `x` the horizontal centre, but the
 * field shapes (`skyline`, `starfield`, `rain`, `embers`) read `x/y/w/h` as a
 * bounding box they scatter inside. None of this is ever collided with.
 */
export interface ParallaxObject {
  shape:
    | "band"
    | "moon"
    | "mountain"
    | "mesa"
    | "hill"
    | "cloud"
    | "tree"
    | "spire"
    | "boulder"
    | "building"
    | "skyline"
    | "starfield"
    | "crane"
    | "chain"
    | "pipes"
    | "arch"
    | "girderX"
    | "rain"
    | "embers";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Windows, rivets, edge highlights — shape-specific secondary colour. */
  accent?: string;
  alpha?: number;
  /** Horizontal drift in arena units per second; wraps. 0/undefined = static. */
  drift?: number;
  /** Stable seed for the scatter shapes, so the field doesn't shimmer. */
  seed?: number;
}

/**
 * A stack of objects that all move together at one depth. `depth` is how
 * strongly the layer answers the camera (which follows your fighter): ~0 is
 * pinned to infinity, background layers sit around 0.03–0.16, and foreground
 * layers push past 0.4 so near things slide faster than the fight.
 */
export interface ParallaxLayer {
  depth: number;
  objects: ParallaxObject[];
}

export interface WorldMap {
  id: string;
  name: string;
  /** One line for the lobby picker. */
  blurb: string;
  /** Sky gradient, top → bottom. */
  sky: [string, string];
  /** Base tint for solids, so each world reads distinct at a glance. */
  ink: string;
  solids: readonly Solid[];
  hazards: readonly Hazard[];
  spawns: readonly { x: number; y: number }[];
  killPlaneY: number;
  /** Behind the fighters, far → near. Decorative — never collided with. */
  background: readonly ParallaxLayer[];
}

/** The subset of a map the shared physics step actually reads. */
export interface StepWorld {
  solids: readonly Solid[];
  killPlaneY: number;
}

// --------------------------------------------------------------------- maps

/**
 * The original arena — one platform, everything else air — kept as the
 * default so an unconfigured room plays exactly as it always has. The dressing
 * behind it is new; the geometry is byte-identical to the old `PLATFORMS`.
 */
const CLASSIC: WorldMap = {
  id: "classic",
  name: "Classic",
  blurb: "One platform, open sky. The original.",
  sky: ["#151b25", "#0f1319"],
  ink: "#2b3441",
  solids: PLATFORMS.map((p) => ({ ...p, kind: "ground" as const })),
  hazards: [],
  spawns: SPAWN_POINTS,
  killPlaneY: KILL_PLANE_Y,
  background: [
    {
      depth: 0.03,
      objects: [
        { shape: "starfield", x: 0, y: 0, w: ARENA_WIDTH, h: 300, color: "#9fb2cc", seed: 11, alpha: 0.8 },
        { shape: "moon", x: 760, y: 120, w: 96, h: 96, color: "#e8eef7", accent: "#aab8cc" },
      ],
    },
    {
      depth: 0.08,
      objects: [
        { shape: "mountain", x: 240, y: 430, w: 460, h: 220, color: "#1b2430" },
        { shape: "mountain", x: 620, y: 430, w: 540, h: 270, color: "#1b2430" },
      ],
    },
    {
      depth: 0.15,
      objects: [
        { shape: "hill", x: 180, y: 452, w: 520, h: 120, color: "#212c3a" },
        { shape: "hill", x: 720, y: 452, w: 620, h: 150, color: "#212c3a" },
        { shape: "tree", x: 120, y: 452, w: 40, h: 90, color: "#1a2331" },
        { shape: "tree", x: 858, y: 452, w: 46, h: 104, color: "#1a2331" },
      ],
    },
  ],
};

/**
 * A four-storey scaffold — solid ground, two mid beams, a centre crossbeam and
 * two top perches, all `oneWay` above the floor so you fight your way up and
 * drop back down through them. A crate on the deck to break a straight run.
 */
const TOWERS: WorldMap = {
  id: "towers",
  name: "Towers",
  blurb: "Four levels of beams over a city. Fight your way up.",
  sky: ["#12161f", "#0c0f16"],
  ink: "#333d4d",
  solids: [
    { x: 40, y: 470, width: 880, height: 50, kind: "ground" },
    { x: 120, y: 360, width: 220, height: 14, oneWay: true, kind: "beam" },
    { x: 620, y: 360, width: 220, height: 14, oneWay: true, kind: "beam" },
    // Crossbeam and top perches lowered a notch so the climb from the mid beams
    // is a clean ~80 rather than a near-ceiling 92.
    { x: 400, y: 280, width: 160, height: 14, oneWay: true, kind: "beam" },
    { x: 150, y: 200, width: 150, height: 14, oneWay: true, kind: "beam" },
    { x: 660, y: 200, width: 150, height: 14, oneWay: true, kind: "beam" },
    { x: 452, y: 430, width: 40, height: 40, kind: "crate" },
    { x: 250, y: 438, width: 34, height: 32, kind: "crate" },
  ],
  hazards: [],
  spawns: [
    { x: 150, y: 470 },
    { x: 810, y: 470 },
    { x: 320, y: 470 },
    { x: 640, y: 470 },
    { x: 225, y: 360 },
    { x: 735, y: 360 },
    { x: 480, y: 470 },
    { x: 480, y: 280 },
    { x: 225, y: 200 },
    { x: 735, y: 200 },
  ],
  killPlaneY: ARENA_HEIGHT + 240,
  background: [
    {
      depth: 0.03,
      objects: [
        { shape: "moon", x: 180, y: 110, w: 70, h: 70, color: "#f4e6c8", accent: "#d8c49a" },
        { shape: "skyline", x: 0, y: 470, w: ARENA_WIDTH, h: 300, color: "#141a24", accent: "#141a24", seed: 3 },
      ],
    },
    {
      depth: 0.08,
      objects: [
        { shape: "skyline", x: -40, y: 478, w: ARENA_WIDTH + 80, h: 240, color: "#1a212d", accent: "#3a4a63", seed: 17 },
      ],
    },
    {
      depth: 0.15,
      objects: [
        { shape: "skyline", x: -60, y: 486, w: ARENA_WIDTH + 120, h: 170, color: "#222b39", accent: "#4c608a", seed: 29 },
      ],
    },
  ],
};

/**
 * A split mesa — the ground is two blocks with a spiked pit between them.
 * `oneWay` ledges bridge the gap at two heights, so the crossing is always a
 * commitment over the spikes rather than a walk.
 */
const CANYON: WorldMap = {
  id: "canyon",
  name: "Canyon",
  blurb: "A spiked gap between two mesas. Mind the jump.",
  sky: ["#2a1c24", "#140d13"],
  ink: "#5a4030",
  solids: [
    { x: -20, y: 430, width: 350, height: 130, kind: "ground" },
    { x: 630, y: 430, width: 350, height: 130, kind: "ground" },
    { x: 366, y: 382, width: 90, height: 14, oneWay: true, kind: "ledge" },
    { x: 504, y: 382, width: 90, height: 14, oneWay: true, kind: "ledge" },
    { x: 430, y: 292, width: 100, height: 14, oneWay: true, kind: "ledge" },
    { x: 150, y: 300, width: 120, height: 14, oneWay: true, kind: "ledge" },
    { x: 690, y: 300, width: 120, height: 14, oneWay: true, kind: "ledge" },
  ],
  hazards: [{ x: 330, y: 500, width: 300, height: 30, kind: "spikes" }],
  spawns: [
    { x: 120, y: 430 },
    { x: 840, y: 430 },
    { x: 230, y: 430 },
    { x: 730, y: 430 },
    { x: 300, y: 430 },
    { x: 660, y: 430 },
    { x: 210, y: 300 },
    { x: 750, y: 300 },
    { x: 480, y: 292 },
    { x: 180, y: 430 },
  ],
  killPlaneY: ARENA_HEIGHT + 240,
  background: [
    {
      depth: 0.03,
      objects: [
        { shape: "moon", x: 700, y: 120, w: 110, h: 110, color: "#ffb46b", accent: "#e07a3c" },
        { shape: "mesa", x: 200, y: 440, w: 420, h: 250, color: "#2a1c22" },
        { shape: "mesa", x: 760, y: 440, w: 480, h: 300, color: "#2a1c22" },
      ],
    },
    {
      depth: 0.09,
      objects: [
        { shape: "mesa", x: 120, y: 452, w: 320, h: 180, color: "#38242c" },
        { shape: "mesa", x: 560, y: 452, w: 380, h: 210, color: "#38242c" },
        { shape: "mesa", x: 880, y: 452, w: 300, h: 160, color: "#38242c" },
      ],
    },
    { depth: 0.15, objects: [{ shape: "band", x: 0, y: 300, w: ARENA_WIDTH, h: 170, color: "#5a3a2e", alpha: 0.25 }] },
  ],
};

/**
 * A foundry floor — solid girders you can crack your head on, `oneWay`
 * catwalks up top, a crate on the deck, and two saw blades you route around.
 * The most hostile map.
 *
 * Every tier is a clean ~76 above the last: deck → wide side girders → centre
 * bridge → top catwalks. The old layout hung the first girders 112 above the
 * deck — past the jump ceiling — so a fighter knocked to the floor could only
 * climb back by way of a saw blade. The saws now sit in the middle third,
 * clear of the run-up under either girder.
 */
const FOUNDRY: WorldMap = {
  id: "foundry",
  name: "Foundry",
  blurb: "Girders, catwalks and two live saw blades.",
  sky: ["#241413", "#120a0a"],
  ink: "#3f4652",
  solids: [
    { x: 30, y: 460, width: 900, height: 50, kind: "ground" },
    { x: 120, y: 384, width: 230, height: 18, kind: "girder" },
    { x: 610, y: 384, width: 230, height: 18, kind: "girder" },
    { x: 370, y: 308, width: 220, height: 18, kind: "girder" },
    { x: 96, y: 232, width: 210, height: 12, oneWay: true, kind: "beam" },
    { x: 654, y: 232, width: 210, height: 12, oneWay: true, kind: "beam" },
    { x: 458, y: 420, width: 40, height: 40, kind: "crate" },
  ],
  hazards: [
    { x: 356, y: 428, width: 34, height: 34, kind: "saw" },
    { x: 570, y: 428, width: 34, height: 34, kind: "saw" },
  ],
  spawns: [
    { x: 110, y: 460 },
    { x: 850, y: 460 },
    { x: 240, y: 460 },
    { x: 720, y: 460 },
    { x: 320, y: 460 },
    { x: 640, y: 460 },
    { x: 200, y: 384 },
    { x: 760, y: 384 },
    { x: 480, y: 308 },
    { x: 180, y: 232 },
  ],
  killPlaneY: ARENA_HEIGHT + 240,
  background: [
    {
      depth: 0.03,
      objects: [
        { shape: "arch", x: 220, y: 470, w: 320, h: 340, color: "#2c1613", accent: "#ff6a2c" },
        { shape: "arch", x: 660, y: 470, w: 320, h: 340, color: "#2c1613", accent: "#ff6a2c" },
        { shape: "band", x: 0, y: 320, w: ARENA_WIDTH, h: 160, color: "#ff6a2c", alpha: 0.12 },
      ],
    },
    {
      depth: 0.09,
      objects: [
        { shape: "pipes", x: 0, y: 200, w: 380, h: 120, color: "#1c232e" },
        { shape: "pipes", x: 620, y: 150, w: 420, h: 150, color: "#1c232e" },
        { shape: "starfield", x: 0, y: 20, w: ARENA_WIDTH, h: 120, color: "#ff8a5c", seed: 41, alpha: 0.4 },
      ],
    },
    { depth: 0.15, objects: [{ shape: "embers", x: 0, y: 0, w: ARENA_WIDTH, h: ARENA_HEIGHT, color: "#ff9d4d", seed: 7, alpha: 0.5, drift: 12 }] },
  ],
};

/**
 * Floating stones over open air — no floor at all, just staggered slabs and
 * `oneWay` perches with real gaps between them. The kill plane sits close, so
 * a missed jump is the whole danger and there are no hazards to add to it.
 */
const SKYWAY: WorldMap = {
  id: "skyway",
  name: "Skyway",
  blurb: "Floating stones over open air. No floor to catch you.",
  sky: ["#3a6ea5", "#9cc4e0"],
  ink: "#586a78",
  solids: [
    { x: 380, y: 430, width: 200, height: 24, kind: "platform" },
    { x: 80, y: 452, width: 160, height: 22, kind: "platform" },
    { x: 720, y: 452, width: 160, height: 22, kind: "platform" },
    // Perches raised (heights lowered) so no hop clears more than ~80 — the old
    // 340/248/250 stones sat within a pixel or two of the jump ceiling.
    { x: 210, y: 352, width: 150, height: 12, oneWay: true, kind: "ledge" },
    { x: 600, y: 352, width: 150, height: 12, oneWay: true, kind: "ledge" },
    { x: 410, y: 272, width: 140, height: 12, oneWay: true, kind: "ledge" },
    { x: 110, y: 274, width: 96, height: 12, oneWay: true, kind: "ledge" },
    { x: 754, y: 274, width: 96, height: 12, oneWay: true, kind: "ledge" },
  ],
  hazards: [],
  spawns: [
    { x: 150, y: 452 },
    { x: 800, y: 452 },
    { x: 420, y: 430 },
    { x: 540, y: 430 },
    { x: 110, y: 452 },
    { x: 840, y: 452 },
    { x: 285, y: 352 },
    { x: 675, y: 352 },
    { x: 480, y: 272 },
    { x: 480, y: 430 },
  ],
  killPlaneY: ARENA_HEIGHT + 150,
  background: [
    {
      depth: 0.02,
      objects: [
        { shape: "moon", x: 200, y: 130, w: 120, h: 120, color: "#fff6df", accent: "#ffe6b0" },
        { shape: "band", x: 0, y: 360, w: ARENA_WIDTH, h: 200, color: "#bcd9ec", alpha: 0.35 },
      ],
    },
    {
      depth: 0.07,
      objects: [
        { shape: "cloud", x: 260, y: 200, w: 220, h: 46, color: "#e9f2f8", alpha: 0.9, drift: 7 },
        { shape: "cloud", x: 720, y: 150, w: 260, h: 54, color: "#e9f2f8", alpha: 0.9, drift: 5 },
        { shape: "cloud", x: 900, y: 300, w: 200, h: 42, color: "#dfeaf2", alpha: 0.8, drift: 9 },
      ],
    },
    {
      depth: 0.14,
      objects: [
        { shape: "cloud", x: 120, y: 380, w: 300, h: 60, color: "#cfe0ec", alpha: 0.85, drift: 15 },
        { shape: "cloud", x: 640, y: 420, w: 340, h: 66, color: "#cfe0ec", alpha: 0.85, drift: 13 },
        { shape: "mountain", x: 480, y: 470, w: 520, h: 150, color: "#8fb2cc", alpha: 0.5 },
      ],
    },
  ],
};

/**
 * Three city rooftops at three heights with a fatal gap between each. Vent
 * units to break a run, and a `oneWay` fire-escape ledge stepping down from
 * each roof to the next — the only clean way across.
 */
const ROOFTOPS: WorldMap = {
  id: "rooftops",
  name: "Rooftops",
  blurb: "Three roofs, two gaps, a long way down.",
  sky: ["#1a1030", "#2c1a3c"],
  ink: "#2b3140",
  solids: [
    { x: -20, y: 300, width: 300, height: 260, kind: "ground" },
    { x: 350, y: 430, width: 280, height: 130, kind: "ground" },
    { x: 700, y: 360, width: 320, height: 200, kind: "ground" },
    { x: 120, y: 260, width: 44, height: 40, kind: "crate" },
    { x: 470, y: 390, width: 40, height: 40, kind: "crate" },
    { x: 830, y: 320, width: 44, height: 40, kind: "crate" },
    { x: 282, y: 380, width: 92, height: 12, oneWay: true, kind: "ledge" },
    { x: 626, y: 402, width: 92, height: 12, oneWay: true, kind: "ledge" },
  ],
  hazards: [],
  spawns: [
    { x: 40, y: 300 },
    { x: 230, y: 300 },
    { x: 390, y: 430 },
    { x: 600, y: 430 },
    { x: 740, y: 360 },
    { x: 960, y: 360 },
    { x: 90, y: 300 },
    { x: 560, y: 430 },
    { x: 900, y: 360 },
    { x: 200, y: 300 },
  ],
  killPlaneY: ARENA_HEIGHT + 200,
  background: [
    {
      depth: 0.03,
      objects: [
        { shape: "moon", x: 780, y: 110, w: 84, h: 84, color: "#f2e9ff", accent: "#cdbde6" },
        { shape: "skyline", x: 0, y: 470, w: ARENA_WIDTH, h: 340, color: "#160e28", accent: "#160e28", seed: 13 },
      ],
    },
    {
      depth: 0.08,
      objects: [
        { shape: "skyline", x: -40, y: 486, w: ARENA_WIDTH + 80, h: 260, color: "#1e1436", accent: "#ff5ea8", seed: 61 },
      ],
    },
    {
      depth: 0.15,
      objects: [
        { shape: "skyline", x: -60, y: 500, w: ARENA_WIDTH + 120, h: 190, color: "#271a45", accent: "#5ee0ff", seed: 47 },
        { shape: "building", x: 120, y: 520, w: 70, h: 150, color: "#1a1230", accent: "#3a2a55" },
      ],
    },
  ],
};

/**
 * The Sofia Airport Center complex — IBM Bulgaria's building — over its lake.
 * A lakeside plaza is the floor; the façade above it is a symmetric lattice of
 * `oneWay` ledges standing in for the office floors, every step ~64–76 up so
 * the whole front is climbable to the signage level and drop-through on the way
 * down. No hazards: the lake below the plaza (past `killPlaneY`) is the only
 * way out of the arena.
 */
const IBM_SAC: WorldMap = {
  id: "ibm-sac",
  name: "IBM Bulgaria (SAC)",
  blurb: "IBM's Sofia offices, climbing the glass over the lake.",
  sky: ["#7fb4dd", "#c6dded"],
  ink: "#49535f",
  solids: [
    { x: 60, y: 452, width: 840, height: 40, kind: "ground" },
    { x: 410, y: 384, width: 140, height: 16, kind: "platform" },
    { x: 140, y: 380, width: 160, height: 12, oneWay: true, kind: "ledge" },
    { x: 660, y: 380, width: 160, height: 12, oneWay: true, kind: "ledge" },
    { x: 180, y: 312, width: 150, height: 12, oneWay: true, kind: "ledge" },
    { x: 630, y: 312, width: 150, height: 12, oneWay: true, kind: "ledge" },
    { x: 420, y: 312, width: 120, height: 12, oneWay: true, kind: "beam" },
    { x: 150, y: 244, width: 140, height: 12, oneWay: true, kind: "ledge" },
    { x: 670, y: 244, width: 140, height: 12, oneWay: true, kind: "ledge" },
    { x: 410, y: 240, width: 140, height: 12, oneWay: true, kind: "ledge" },
  ],
  hazards: [],
  spawns: [
    { x: 150, y: 452 },
    { x: 810, y: 452 },
    { x: 330, y: 452 },
    { x: 630, y: 452 },
    { x: 240, y: 452 },
    { x: 720, y: 452 },
    { x: 480, y: 452 },
    { x: 215, y: 380 },
    { x: 745, y: 380 },
    { x: 480, y: 384 },
  ],
  killPlaneY: ARENA_HEIGHT + 220,
  background: [
    {
      depth: 0.03,
      objects: [
        { shape: "cloud", x: 190, y: 88, w: 220, h: 44, color: "#f4f8fb", alpha: 0.95, drift: 4 },
        { shape: "cloud", x: 630, y: 66, w: 260, h: 52, color: "#f4f8fb", alpha: 0.95, drift: 3 },
        { shape: "cloud", x: 860, y: 140, w: 200, h: 40, color: "#e9f1f7", alpha: 0.85, drift: 5 },
        { shape: "mountain", x: 230, y: 300, w: 520, h: 150, color: "#a9c6dd", alpha: 0.5 },
        { shape: "mountain", x: 720, y: 300, w: 560, h: 180, color: "#a9c6dd", alpha: 0.5 },
      ],
    },
    {
      depth: 0.08,
      objects: [
        { shape: "hill", x: 160, y: 300, w: 520, h: 90, color: "#5c8a4e" },
        { shape: "hill", x: 690, y: 300, w: 620, h: 110, color: "#55823f" },
      ],
    },
    {
      depth: 0.16,
      objects: [
        { shape: "building", x: 255, y: 470, w: 330, h: 300, color: "#5a6672", accent: "#90a7b9" },
        { shape: "building", x: 715, y: 470, w: 330, h: 300, color: "#5a6672", accent: "#90a7b9" },
        { shape: "building", x: 485, y: 470, w: 210, h: 250, color: "#45576a", accent: "#bfddf0" },
        // Signage plates on the upper façade — SAC over the left wing, IBM the right.
        { shape: "band", x: 300, y: 196, w: 200, h: 20, color: "#eef3f7" },
        { shape: "band", x: 588, y: 196, w: 118, h: 20, color: "#eef3f7" },
      ],
    },
    {
      depth: 0.3,
      objects: [
        { shape: "band", x: 0, y: 486, w: ARENA_WIDTH, h: 60, color: "#3c4a3a", alpha: 0.9 },
        { shape: "tree", x: 40, y: 500, w: 60, h: 120, color: "#31402c" },
        { shape: "tree", x: 924, y: 500, w: 66, h: 130, color: "#31402c" },
      ],
    },
    {
      depth: 0.45,
      objects: [
        { shape: "band", x: -60, y: 496, w: ARENA_WIDTH + 120, h: 120, color: "#6fa8cf", alpha: 0.55 },
        { shape: "band", x: -60, y: 524, w: ARENA_WIDTH + 120, h: 90, color: "#5892bd", alpha: 0.7 },
      ],
    },
  ],
};

export const WORLD_MAPS: readonly WorldMap[] = [
  CLASSIC,
  TOWERS,
  CANYON,
  FOUNDRY,
  SKYWAY,
  ROOFTOPS,
  IBM_SAC,
];

export const DEFAULT_MAP_ID = CLASSIC.id;

const MAP_BY_ID: ReadonlyMap<string, WorldMap> = new Map(
  WORLD_MAPS.map((m) => [m.id, m]),
);

/** Every map id, for the lobby picker and server-side validation. */
export const MAP_IDS: readonly string[] = WORLD_MAPS.map((m) => m.id);

/** Is this a world we actually ship? */
export function isMapId(value: unknown): value is string {
  return typeof value === "string" && MAP_BY_ID.has(value);
}

/** Resolve a map id to its map, falling back to the default rather than throwing. */
export function getMap(id: string): WorldMap {
  return MAP_BY_ID.get(id) ?? CLASSIC;
}

/**
 * The active map for callers that don't thread one through — the client, and
 * the tests. The server never uses this (it hosts many rooms in one process
 * and passes each room's map explicitly), so this module global can't be
 * stomped by a concurrent room.
 */
let activeMapId = DEFAULT_MAP_ID;

export function setActiveMap(id: string): void {
  if (isMapId(id)) activeMapId = id;
}

export function activeMap(): WorldMap {
  return getMap(activeMapId);
}
