import {
  MIN_PLAYERS,
  TICK_MS,
  type ArenaState,
  type MatchPhase,
  type Player,
} from "@stickstakes/shared";

/**
 * The DOM layer above the canvas: roster, top band, and the centred beat
 * ("3 · 2 · 1 · FIGHT", the round result, the final call).
 *
 * Everything here is derived from `state.phase` on each frame. The HUD keeps no
 * match state of its own — the only thing it remembers is what it last wrote to
 * the DOM, so it can skip redundant writes and know when to replay the pop
 * animation. Deliberately a *banner* rather than a full-screen takeover: the
 * fight stays visible between rounds.
 */

export interface Hud {
  update(state: ArenaState, selfId: string): void;
  onStart(handler: () => void): void;
}

/** Countdown remaining, in ms, derived purely from synced ticks. */
function remainingMs(state: ArenaState): number {
  if (!state.phaseEndsAtTick) return 0;
  return Math.max(0, (state.phaseEndsAtTick - state.tick) * TICK_MS);
}

function pips(filled: number, total: number): string {
  return "●".repeat(Math.max(0, filled)) + "○".repeat(Math.max(0, total - filled));
}

function stars(filled: number, total: number): string {
  return "★".repeat(Math.max(0, filled)) + "☆".repeat(Math.max(0, total - filled));
}

export function createHud(root: ParentNode = document): Hud {
  const rosterEl = root.querySelector<HTMLUListElement>("#roster")!;
  const bannerEl = root.querySelector<HTMLElement>("#banner")!;
  const roundEl = root.querySelector<HTMLElement>("#banner-round")!;
  const noteEl = root.querySelector<HTMLElement>("#banner-note")!;
  const actionEl = root.querySelector<HTMLButtonElement>("#banner-action")!;
  const bigEl = root.querySelector<HTMLElement>("#bigtext")!;
  const bigMainEl = root.querySelector<HTMLElement>("#bigtext-main")!;
  const bigSubEl = root.querySelector<HTMLElement>("#bigtext-sub")!;

  let startHandler: (() => void) | undefined;
  actionEl.addEventListener("click", () => startHandler?.());

  // Last-written values, so we only touch the DOM when something changed.
  let lastBigMain = "";
  let lastRosterKey = "";
  /** Set when countdown flips to playing, so "FIGHT!" can linger a moment. */
  let fightUntil = 0;
  let lastPhase: MatchPhase | "" = "";

  function nameOf(state: ArenaState, sessionId: string): string {
    return state.players.get(sessionId)?.name ?? "";
  }

  function updateBanner(state: ArenaState, selfId: string): void {
    const phase = state.phase as MatchPhase;
    const isHost = state.hostId === selfId;
    const count = state.players.size;

    let round = "";
    let note = "";
    let action = "";

    switch (phase) {
      case "lobby":
        round = "STICKSTAKES";
        note =
          count < MIN_PLAYERS
            ? `${count}/${state.maxPlayers} · need ${MIN_PLAYERS}`
            : `${count}/${state.maxPlayers} ready`;
        action = isHost ? (count < MIN_PLAYERS ? "Start solo" : "Start match") : "";
        if (!isHost) note += " · waiting for host";
        break;

      case "countdown":
      case "playing":
        round = `ROUND ${state.round}/${state.totalRounds}`;
        note = `first to ${state.roundWinsToTakeMatch}`;
        break;

      case "roundOver":
        round = `ROUND ${state.round}/${state.totalRounds}`;
        note = "next round…";
        break;

      case "matchOver":
        round = "MATCH OVER";
        note = isHost ? "" : "waiting for host";
        action = isHost ? "Play again" : "";
        break;
    }

    roundEl.textContent = round;
    noteEl.textContent = note;
    actionEl.textContent = action;
    actionEl.hidden = action === "";
    bannerEl.hidden = false;
  }

  function updateBigText(state: ArenaState, now: number): void {
    const phase = state.phase as MatchPhase;
    let main = "";
    let sub = "";

    if (phase === "countdown") {
      // 3 · 2 · 1 — ceil so "1" is on screen for the final whole second.
      main = String(Math.max(1, Math.ceil(remainingMs(state) / 1000)));
      sub = "get ready";
    } else if (phase === "playing" && now < fightUntil) {
      main = "FIGHT!";
    } else if (phase === "roundOver") {
      const winner = nameOf(state, state.lastRoundWinnerId);
      main = winner ? `${winner} WINS` : "DRAW";
      sub = winner ? `round ${state.round}` : `round ${state.round} · nobody left standing`;
    } else if (phase === "matchOver") {
      const winner = nameOf(state, state.matchWinnerId);
      main = winner ? `${winner} TAKES IT` : "DEAD HEAT";
      sub = winner ? "loser pays" : "nobody owes anybody";
    }

    if (main !== lastBigMain) {
      lastBigMain = main;
      bigMainEl.textContent = main;
      // Restart the pop animation by removing and re-adding the class.
      bigEl.classList.remove("pop");
      void bigEl.offsetWidth;
      if (main) bigEl.classList.add("pop");
    }
    bigSubEl.textContent = sub;
    bigEl.hidden = main === "";
  }

  function updateRoster(state: ArenaState, selfId: string): void {
    const phase = state.phase as MatchPhase;
    const inRound = phase !== "lobby";

    const entries = Array.from(state.players.entries()).sort(
      ([, a], [, b]) => a.slot - b.slot,
    );

    // Cheap change detection: rebuild only when something visible moved.
    const key = entries
      .map(([id, p]) => `${id}:${p.name}:${p.lives}:${p.roundWins}:${p.spectating}`)
      .join("|") + `|${phase}|${state.hostId}`;
    if (key === lastRosterKey) return;
    lastRosterKey = key;

    rosterEl.replaceChildren(
      ...entries.map(([sessionId, player]: [string, Player]) => {
        const li = document.createElement("li");
        const out = inRound && !player.spectating && player.lives === 0;
        li.classList.toggle("is-out", out);
        li.classList.toggle("is-self", sessionId === selfId);

        const dot = document.createElement("span");
        dot.className = "roster-dot";
        dot.style.background = player.color;

        const name = document.createElement("span");
        name.className = "roster-name";
        name.textContent = player.name;

        li.append(dot, name);

        if (sessionId === state.hostId) {
          const host = document.createElement("span");
          host.className = "roster-host";
          host.textContent = "HOST";
          li.append(host);
        }

        if (inRound) {
          const lives = document.createElement("span");
          lives.className = "roster-lives";
          lives.style.color = player.color;
          lives.textContent = player.spectating
            ? "spectating"
            : pips(player.lives, state.livesPerRound);
          li.append(lives);

          const wins = document.createElement("span");
          wins.className = "roster-wins";
          wins.textContent = stars(player.roundWins, state.roundWinsToTakeMatch);
          li.append(wins);
        }

        return li;
      }),
    );
  }

  return {
    update(state, selfId) {
      const now = performance.now();
      const phase = state.phase as MatchPhase;

      if (phase !== lastPhase) {
        // Entering the fight: let "FIGHT!" sit for a beat before it clears.
        if (phase === "playing" && lastPhase === "countdown") fightUntil = now + 700;
        lastPhase = phase;
      }

      updateBanner(state, selfId);
      updateBigText(state, now);
      updateRoster(state, selfId);
    },

    onStart(handler) {
      startHandler = handler;
    },
  };
}
