import type { ArenaState, Player } from "@stickstakes/shared";
import { createFighterShowcase } from "./figure.js";

/**
 * The end screen — the point of the whole thing. Who won, what they won, the
 * final standings, and a way to send it to the group chat.
 *
 * Explicitly NOT a payments screen. The split helper does arithmetic on a
 * number the user types and shows the answer; nothing is stored, sent, or
 * settled. It's a calculator for a joke bet, and it stays that way.
 */

export interface ResultPanel {
  update(state: ArenaState, selfId: string): void;
  hide(): void;
  onShare(handler: (text: string) => void): void;
  onPlayAgain(handler: () => void): void;
}

interface Standing {
  name: string;
  wins: number;
  isSelf: boolean;
  color: string;
}

function standings(state: ArenaState, selfId: string): Standing[] {
  return Array.from(state.players.entries())
    .map(([id, p]: [string, Player]) => ({
      name: p.name,
      wins: p.roundWins,
      isSelf: id === selfId,
      color: p.color,
    }))
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
}

/** One line worth pasting into a group chat. */
export function shareText(state: ArenaState, selfId: string): string {
  const winner = state.players.get(state.matchWinnerId)?.name;
  const table = standings(state, selfId)
    .map((s) => `${s.name} ${s.wins}`)
    .join(" · ");
  const headline = winner ? `${winner} won StickStakes` : "StickStakes ended in a dead heat";
  return `${headline}\n${state.stake}\n${table}`;
}

export function createResultPanel(root: ParentNode = document): ResultPanel {
  const el = root.querySelector<HTMLElement>("#result")!;
  const titleEl = root.querySelector<HTMLElement>("#result-title")!;
  const stakeEl = root.querySelector<HTMLElement>("#result-stake")!;
  const listEl = root.querySelector<HTMLOListElement>("#result-standings")!;
  const shareBtn = root.querySelector<HTMLButtonElement>("#result-share")!;
  const againBtn = root.querySelector<HTMLButtonElement>("#result-again")!;
  const totalEl = root.querySelector<HTMLInputElement>("#split-total")!;
  const splitOutEl = root.querySelector<HTMLElement>("#split-out")!;
  const fighterCanvas = root.querySelector<HTMLCanvasElement>("#result-fighter")!;

  const showcase = createFighterShowcase(fighterCanvas, { color: "#e8ecf1", hat: "none" });

  let shareHandler: ((text: string) => void) | undefined;
  let againHandler: (() => void) | undefined;
  let current: { state: ArenaState; selfId: string } | undefined;
  let lastKey = "";

  againBtn.addEventListener("click", () => againHandler?.());

  shareBtn.addEventListener("click", () => {
    if (!current) return;
    shareHandler?.(shareText(current.state, current.selfId));
  });

  function renderSplit(): void {
    if (!current) return;
    const total = Number.parseFloat(totalEl.value);
    const payers = Math.max(0, current.state.players.size - 1);

    if (!Number.isFinite(total) || total <= 0 || payers === 0) {
      splitOutEl.textContent = "";
      return;
    }
    const each = total / payers;
    splitOutEl.textContent = `${payers} × ${each.toFixed(2)}`;
  }

  totalEl.addEventListener("input", renderSplit);

  return {
    update(state, selfId) {
      el.hidden = false;
      current = { state, selfId };
      // The card sits over the banner, so the replay button has to live here
      // or the host simply cannot reach it.
      againBtn.hidden = state.hostId !== selfId;

      const winner = state.players.get(state.matchWinnerId);
      const rows = standings(state, selfId);

      // Only touch the DOM when the outcome actually changes; this runs every
      // frame and the split field must not be rebuilt under the user's cursor.
      const key = `${state.matchWinnerId}|${state.stake}|${rows
        .map((r) => `${r.name}:${r.wins}`)
        .join(",")}`;
      if (key === lastKey) return;
      lastKey = key;

      titleEl.textContent = winner ? `${winner.name} takes it` : "Dead heat";
      titleEl.style.color = winner?.color ?? "#e8ecf1";
      stakeEl.textContent = winner ? state.stake : "Nobody owes anybody.";

      // The hero stage wears the winner (or a neutral stickman on a dead heat).
      showcase.set(winner?.color ?? "#e8ecf1", winner?.hat ?? "none");

      listEl.replaceChildren(
        ...rows.map((row, i) => {
          const li = document.createElement("li");
          li.classList.toggle("is-self", row.isSelf);

          const rank = document.createElement("span");
          rank.className = "result-rank";
          rank.textContent = String(i + 1);

          const dot = document.createElement("span");
          dot.className = "result-dot";
          dot.style.background = row.color;

          const name = document.createElement("span");
          name.className = "result-name";
          name.textContent = row.name;

          const wins = document.createElement("span");
          wins.className = "result-wins";
          wins.textContent = row.wins === 1 ? "1 round" : `${row.wins} rounds`;

          li.append(rank, dot, name, wins);
          return li;
        }),
      );

      renderSplit();
    },
    hide() {
      el.hidden = true;
      lastKey = "";
    },
    onShare(handler) {
      shareHandler = handler;
    },
    onPlayAgain(handler) {
      againHandler = handler;
    },
  };
}
