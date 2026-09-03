import { Predict, getStateCallbacks } from "@colyseus/sdk";
import {
  BODY_FIELDS,
  INTERPOLATION_DELAY_MS,
  type FightInput,
  type Player,
  respawnBody,
  stepBody,
} from "@stickstakes/shared";
import { createInput } from "./input.js";
import { createRenderer } from "./render.js";
import { joinArena } from "./net.js";

// Floating devtools on the phone. Dev builds only — this is the single biggest
// quality-of-life win for debugging with your thumbs instead of a laptop.
if (import.meta.env.DEV) {
  void import("eruda").then((m) => m.default.init());
}

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const fullscreenBtn = document.querySelector<HTMLButtonElement>("#fullscreen")!;

const renderer = createRenderer(canvas);
const input = createInput(canvas);

function relayout(): void {
  renderer.resize();
  input.layout(renderer.cssWidth, renderer.cssHeight);
}

relayout();
window.addEventListener("resize", relayout);
window.addEventListener("orientationchange", relayout);

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
});

/** Remembered between reloads so you keep your name across HMR reloads on a phone. */
function playerName(): string {
  const stored = localStorage.getItem("stickstakes:name");
  if (stored) return stored;
  const generated = `P${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem("stickstakes:name", generated);
  return generated;
}

async function main(): Promise<void> {
  statusEl.textContent = "connecting…";
  const room = await joinArena(playerName());
  statusEl.textContent = "connected";

  /**
   * The input channel. `reliable` is right for WebSocket: every frame arrives
   * once and in order, so the server's ack (`handle.lastProcessed`) tracks our
   * sends 1:1 and the reconciler knows exactly what is still in flight.
   */
  const inputHandle = room.input<FightInput>({ mode: "reliable" });

  /**
   * Remote stickmen are drawn ~100ms behind the newest snapshot, interpolated
   * between the two straddling it — smooth motion at the cost of a little lag,
   * which nobody notices on someone else's character.
   */
  const predict = Predict.get(room, { mode: "lerp", delay: INTERPOLATION_DELAY_MS });
  predict.attachAll("players", { x: "lerp", y: "lerp" });

  /**
   * Our own stickman is different: it must answer the thumb instantly. The
   * reconciler applies each input locally the moment we send it, and when the
   * server's truth arrives it rewinds to that truth and replays whatever is
   * still unacked — using the very same `stepBody` the server just ran.
   */
  const $ = getStateCallbacks(room);
  let selfSlot = 0;

  $(room.state).players.onAdd((player: Player, sessionId: string) => {
    if (sessionId !== room.sessionId) return;
    selfSlot = player.slot;
    predict.reconciler(player, {
      input: inputHandle,
      fields: BODY_FIELDS,
      step: (ctx, body, command) => {
        // Identical code path to the server's fixed step. If these two ever
        // disagree, you get rubber-banding — which is why it lives in /shared.
        if (stepBody(body, command, ctx.dt)) respawnBody(body, selfSlot);
      },
    });
  });

  // Dev-only inspection hook: pair it with eruda on the phone, or drive it
  // from a headless browser in a test.
  if (import.meta.env.DEV) {
    Object.assign(globalThis, {
      __ss: {
        room,
        predict,
        playerCount: () => room.state.players.size,
        dump: () =>
          Array.from(room.state.players.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            self: id === room.sessionId,
            x: Math.round(predict.value(p, "x")),
            y: Math.round(predict.value(p, "y")),
            grounded: p.grounded,
          })),
      },
    });
  }

  room.onLeave((code) => {
    statusEl.textContent = `disconnected (${code})`;
  });

  let debugAt = 0;

  function frame(now: number): void {
    // One driver for the whole prediction stack. Returns how many fixed input
    // steps are due this frame — we send exactly that many, no more.
    const steps = predict.tick(now);
    for (let i = 0; i < steps; i++) {
      inputHandle.data.left = input.intent.left;
      inputHandle.data.right = input.intent.right;
      inputHandle.data.jump = input.intent.jump;
      inputHandle.data.attack = input.intent.attack;
      inputHandle.send();
    }

    renderer.clear();
    renderer.beginWorld();
    renderer.drawArena();

    for (const [sessionId, player] of room.state.players) {
      renderer.drawStickman({
        // The one read idiom: reconciled for us, interpolated for everyone else.
        x: predict.value(player, "x"),
        y: predict.value(player, "y"),
        facing: player.facing,
        grounded: player.grounded,
        color: player.color,
        name: player.name,
        isSelf: sessionId === room.sessionId,
      });
    }

    renderer.endWorld();
    renderer.drawControls(input.zones, input.active);

    if (now - debugAt > 250) {
      debugAt = now;
      statusEl.textContent =
        `${room.state.players.size}/${room.state.maxPlayers} · ` +
        `${Math.round(room.clock.rtt())}ms rtt · ` +
        `${inputHandle.pendingCount} in flight`;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  console.error(error);
  statusEl.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
});
