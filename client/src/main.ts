import { Predict, getStateCallbacks } from "@colyseus/sdk";
import {
  ATTACK_SWING_MS,
  BODY_FIELDS,
  INTERPOLATION_DELAY_MS,
  TICK_MS,
  type ArenaState,
  type FightInput,
  type MatchPhase,
  type Player,
  stepBody,
} from "@stickstakes/shared";
import { createHud } from "./hud.js";
import { createInput } from "./input.js";
import { createLanding } from "./landing.js";
import { createLobbyPanel } from "./lobby.js";
import { createRenderer } from "./render.js";
import { createResultPanel, shareText } from "./result.js";
import { share } from "./share.js";
import { createArena, describeJoinError, joinArenaByCode, type ArenaRoom } from "./net.js";

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
const hud = createHud();
const landing = createLanding();
const lobby = createLobbyPanel();
const result = createResultPanel();

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

/** The link that gets someone straight into this room. */
function inviteUrl(code: string): string {
  return `${location.origin}${location.pathname}?code=${code}`;
}

/**
 * Should this stickman be on screen at all? Dead between respawns, knocked out
 * for the round, or sitting out a match they joined late — all invisible.
 */
function isVisible(player: Player, state: ArenaState): boolean {
  const phase = state.phase as MatchPhase;
  if (phase === "lobby") return true;
  if (player.spectating) return false;
  if (player.deadUntilTick > 0) return false;
  // Knocked out: hidden for the rest of the round, back at the next countdown.
  if (player.lives === 0 && (phase === "playing" || phase === "roundOver")) return false;
  return true;
}

/** 0..1 through the attack swing, or 0 when not swinging. */
function swingProgress(player: Player, tick: number): number {
  const remaining = player.attackUntilTick - tick;
  if (remaining <= 0) return 0;
  const total = ATTACK_SWING_MS / TICK_MS;
  return Math.min(1, Math.max(0, 1 - remaining / total));
}

/** Landing screen → a joined room. Loops until something works. */
async function connect(): Promise<ArenaRoom> {
  for (;;) {
    const choice = await landing.choose();
    try {
      const room = choice.code
        ? await joinArenaByCode(choice.code, choice.name)
        : await createArena(choice.name);

      // Put the code in the address bar so the host can just share the URL,
      // and so a reload rejoins the same game instead of starting a new one.
      history.replaceState(null, "", `?code=${room.roomId}`);
      landing.hide();
      return room;
    } catch (error) {
      landing.reject(
        choice.code
          ? describeJoinError(error, choice.code)
          : `Couldn't create a game. ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const room = await connect();

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
   *
   * `frozen` and `stunned` are mirrored fields, so countdowns, deaths and
   * knockbacks all replay in lock-step with the server instead of fighting it.
   */
  const $ = getStateCallbacks(room);

  $(room.state).players.onAdd((player: Player, sessionId: string) => {
    if (sessionId !== room.sessionId) return;
    predict.reconciler(player, {
      input: inputHandle,
      fields: BODY_FIELDS,
      step: (ctx, body, command) => {
        // Identical code path to the server's fixed step. If these two ever
        // disagree, you get rubber-banding — which is why it lives in /shared.
        // Falling off is *not* handled here: death costs a life, and only the
        // server gets to decide that.
        stepBody(body, command, ctx.dt);
      },
    });
  });

  hud.onStart(() => room.send("startMatch"));
  result.onPlayAgain(() => room.send("startMatch"));
  lobby.onConfigure((change) => room.send("configure", change));

  function flash(message: string): void {
    if (!message) return;
    statusEl.dataset.flash = message;
    setTimeout(() => delete statusEl.dataset.flash, 2200);
  }

  lobby.onShare(async () => {
    flash(await share(`Join my StickStakes game — code ${room.roomId}`, inviteUrl(room.roomId)));
  });
  result.onShare(async (text) => {
    flash(await share(text, inviteUrl(room.roomId)));
  });

  if (import.meta.env.DEV) {
    Object.assign(globalThis, {
      __ss: {
        room,
        predict,
        code: () => room.roomId,
        start: () => room.send("startMatch"),
        configure: (change: unknown) => room.send("configure", change),
        phase: () => room.state.phase,
        stake: () => room.state.stake,
        share: () => shareText(room.state, room.sessionId),
        match: () => ({
          phase: room.state.phase,
          round: room.state.round,
          totalRounds: room.state.totalRounds,
          livesPerRound: room.state.livesPerRound,
          stake: room.state.stake,
          tick: room.state.tick,
          hostId: room.state.hostId,
          matchWinnerId: room.state.matchWinnerId,
        }),
        dump: () =>
          Array.from(room.state.players.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            self: id === room.sessionId,
            x: Math.round(predict.value(p, "x")),
            y: Math.round(predict.value(p, "y")),
            lives: p.lives,
            wins: p.roundWins,
            damage: p.damage,
            stunned: p.stunned,
            frozen: p.frozen,
            dead: p.deadUntilTick > 0,
            spectating: p.spectating,
          })),
      },
    });
  }

  room.onLeave((code) => {
    statusEl.textContent = `disconnected (${code})`;
  });

  let debugAt = 0;

  function frame(now: number): void {
    const state = room.state;
    const phase = state.phase as MatchPhase;

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

    const showLives = phase !== "lobby";

    for (const [sessionId, player] of state.players) {
      if (!isVisible(player, state)) continue;

      renderer.drawStickman({
        // The one read idiom: reconciled for us, interpolated for everyone else.
        x: predict.value(player, "x"),
        y: predict.value(player, "y"),
        facing: player.facing,
        grounded: player.grounded,
        color: player.color,
        name: player.name,
        isSelf: sessionId === room.sessionId,
        lives: player.lives,
        maxLives: state.livesPerRound,
        showLives: showLives && !player.spectating,
        swing: swingProgress(player, state.tick),
        invulnerable: player.invulnUntilTick > state.tick,
        damage: player.damage,
        stunned: player.stunned,
      });
    }

    renderer.endWorld();
    renderer.drawControls(input.zones, input.active, input.stick);

    hud.update(state, room.sessionId);

    // The lobby panel and the result card each own one phase; both stay out of
    // the way while there is a fight to watch.
    if (phase === "lobby") lobby.update(state, room.sessionId, room.roomId);
    else lobby.hide();

    if (phase === "matchOver") result.update(state, room.sessionId);
    else result.hide();

    if (now - debugAt > 250) {
      debugAt = now;
      statusEl.textContent =
        statusEl.dataset.flash ??
        `${room.roomId} · ${phase} · ${state.players.size}/${state.maxPlayers} · ` +
          `${Math.round(room.clock.rtt())}ms · ${inputHandle.pendingCount} in flight`;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  console.error(error);
  landing.reject(`Something broke: ${error instanceof Error ? error.message : String(error)}`);
});
