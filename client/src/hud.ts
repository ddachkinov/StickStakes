import {
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
}

/** Countdown remaining, in ms, derived purely from synced ticks. */
function remainingMs(state: ArenaState): number {
  if (!state.phaseEndsAtTick) return 0;
  return Math.max(0, (state.phaseEndsAtTick - state.tick) * TICK_MS);
}

/**
 * A row of small dots — the first `filled` lit (and optionally tinted), the
 * rest hollow. Used for lives, round wins, and the banner's round tracker;
 * reads at a glance without a number to parse.
 */
function dotRow(filled: number, total: number, cls: string, tint?: string): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = cls ? `dots ${cls}` : "dots";
  for (let i = 0; i < Math.max(0, total); i++) {
    const dot = document.createElement("i");
    const on = i < filled;
    dot.className = on ? "dot is-on" : "dot";
    if (on && tint) dot.style.background = tint;
    wrap.append(dot);
  }
  return wrap;
}

/** Same ramp the canvas uses over each stickman's head — one visual language. */
function damageColor(damage: number): string {
  if (damage >= 150) return "#ff5a5f";
  if (damage >= 100) return "#ff9f45";
  if (damage >= 50) return "#ffd166";
  return "#e8ecf1";
}

export function createHud(root: ParentNode = document): Hud {
  const rosterEl = root.querySelector<HTMLUListElement>("#roster")!;
  const bannerEl = root.querySelector<HTMLElement>("#banner")!;
  const roundEl = root.querySelector<HTMLElement>("#banner-round")!;
  const pipsEl = root.querySelector<HTMLElement>("#banner-pips")!;
  const noteEl = root.querySelector<HTMLElement>("#banner-note")!;
  const bigEl = root.querySelector<HTMLElement>("#bigtext")!;
  const bigMainEl = root.querySelector<HTMLElement>("#bigtext-main")!;
  const bigSubEl = root.querySelector<HTMLElement>("#bigtext-sub")!;

  // Last-written values, so we only touch the DOM when something changed.
  let lastBigMain = "";
  let lastRosterKey = "";
  let lastPipsKey = "";
  /** Set when countdown flips to playing, so "FIGHT!" can linger a moment. */
  let fightUntil = 0;
  let lastPhase: MatchPhase | "" = "";

  function nameOf(state: ArenaState, sessionId: string): string {
    return state.players.get(sessionId)?.name ?? "";
  }

  function colorOf(state: ArenaState, sessionId: string): string {
    return state.players.get(sessionId)?.color ?? "";
  }

  function updateBanner(state: ArenaState, selfId: string): void {
    const phase = state.phase as MatchPhase;
    const isHost = state.hostId === selfId;

    // The lobby panel and the result card each own their phase full-screen —
    // the banner underneath them would only collide with the roster, so it
    // stays down until there is a fight to label.
    if (phase === "lobby" || phase === "matchOver") {
      bannerEl.hidden = true;
      return;
    }

    let round = "";
    let note = "";
    let showPips = false;

    switch (phase) {
      case "countdown":
      case "playing":
        round = `ROUND ${state.round}`;
        note = `first to ${state.roundWinsToTakeMatch}`;
        showPips = true;
        break;

      case "roundOver":
        round = `ROUND ${state.round}`;
        note = "next round…";
        showPips = true;
        break;

      default:
        break;
    }

    roundEl.textContent = round;
    noteEl.textContent = note;
    bannerEl.hidden = false;

    // Round tracker: one dot per round in the match, lit up to the current one.
    const pipsKey = showPips ? `${state.round}/${state.totalRounds}` : "";
    if (pipsKey !== lastPipsKey) {
      lastPipsKey = pipsKey;
      pipsEl.replaceChildren(
        ...(showPips ? [dotRow(state.round, state.totalRounds, "round-dots")] : []),
      );
      pipsEl.hidden = !showPips;
    }
  }

  function updateBigText(state: ArenaState, now: number): void {
    const phase = state.phase as MatchPhase;
    let main = "";
    let sub = "";
    let kind = "";
    let color = "";

    if (phase === "countdown") {
      // 3 · 2 · 1 — ceil so "1" is on screen for the final whole second.
      main = String(Math.max(1, Math.ceil(remainingMs(state) / 1000)));
      sub = "get ready";
      kind = "count";
    } else if (phase === "playing" && now < fightUntil) {
      main = "FIGHT!";
      kind = "fight";
    } else if (phase === "roundOver") {
      const winner = nameOf(state, state.lastRoundWinnerId);
      main = winner ? `${winner} WINS` : "DRAW";
      sub = winner ? `round ${state.round} of ${state.totalRounds}` : "nobody left standing";
      kind = winner ? "win" : "draw";
      color = winner ? colorOf(state, state.lastRoundWinnerId) : "";
    }
    // `matchOver` is deliberately absent: the result card owns that moment,
    // headline included, so the two never stack on top of each other.

    if (main !== lastBigMain) {
      lastBigMain = main;
      bigMainEl.textContent = main;
      bigEl.dataset.kind = kind;
      bigMainEl.style.color = color || "";
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
      .map(([id, p]) => `${id}:${p.name}:${p.lives}:${p.roundWins}:${p.spectating}:${p.damage}:${p.color}:${p.ready}`)
      .join("|") + `|${phase}|${state.hostId}`;
    if (key === lastRosterKey) return;
    lastRosterKey = key;

    rosterEl.replaceChildren(
      ...entries.map(([sessionId, player]: [string, Player]) => {
        const li = document.createElement("li");
        const out = inRound && !player.spectating && player.lives === 0;
        li.classList.toggle("is-out", out);
        li.classList.toggle("is-self", sessionId === selfId);
        li.style.setProperty("--pc", player.color);

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

        // In the lobby, show who has readied up so the wait is legible.
        if (!inRound) {
          const ready = document.createElement("span");
          ready.className = player.ready ? "roster-ready is-on" : "roster-ready";
          ready.textContent = player.ready ? "READY" : "…";
          li.append(ready);
        }

        if (inRound) {
          if (player.spectating) {
            const spec = document.createElement("span");
            spec.className = "roster-spectating";
            spec.textContent = "spectating";
            li.append(spec);
          } else {
            const lives = document.createElement("span");
            lives.className = "roster-lives";
            lives.append(dotRow(player.lives, state.livesPerRound, "life-dots", player.color));
            li.append(lives);

            // Damage is the knockback multiplier, so the colour is the warning:
            // you should be able to spot who is about to fly without reading it.
            const damage = document.createElement("span");
            damage.className = "roster-damage";
            damage.style.color = damageColor(player.damage);
            damage.textContent = `${player.damage}%`;
            li.append(damage);
          }

          const wins = document.createElement("span");
          wins.className = "roster-wins";
          wins.append(dotRow(player.roundWins, state.roundWinsToTakeMatch, "win-dots"));
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
  };
}
