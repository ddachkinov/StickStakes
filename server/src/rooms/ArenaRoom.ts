import { Room, type Client, logger } from "@colyseus/core";
import {
  ArenaState,
  ATTACK_RECOVERY_MS,
  ATTACK_SWING_MS,
  COUNTDOWN_MS,
  FightInput,
  LIVES_PER_ROUND,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  Player,
  RESPAWN_DELAY_MS,
  ROUND_OVER_MS,
  ROUND_WINS_TO_TAKE_MATCH,
  SPAWN_IFRAME_MS,
  SPAWN_POINTS,
  TICK_RATE,
  TOTAL_ROUNDS,
  msToTicks,
  respawnBody,
  spawnBody,
  stepBody,
} from "@stickstakes/shared";

/**
 * The authoritative arena, and the match state machine that runs on top of it.
 *
 * Clients send input intent; this room owns every position, every life and
 * every phase transition. One input frame == one fixed step == one broadcast
 * tick, which is what lets the client replay its unacknowledged inputs against
 * server truth without drifting.
 *
 *   lobby ──host starts──> countdown ──> playing ──> roundOver ─┬─> countdown
 *     ^                                                          └─> matchOver
 *     └──────────────────── host plays again ────────────────────────┘
 */
export class ArenaRoom extends Room<{ state: ArenaState; input: FightInput }> {
  maxClients = MAX_PLAYERS;

  /**
   * Per-client input buffer. `reliable` is the right mode on WebSocket:
   * every frame arrives exactly once and in order, so the redundancy ring
   * an unreliable channel needs would be pure overhead.
   */
  inputs = this.defineInput(FightInput);

  /** Join order, so colours and spawn points are handed out predictably. */
  private nextSlot = 0;

  /**
   * How many fighters the current round started with. A round that began with
   * one player is practice — it has no winner and never ends on its own, which
   * is what makes testing alone on a single phone possible.
   */
  private roundStartedWith = 0;

  onCreate() {
    this.setState(new ArenaState());
    this.state.maxPlayers = MAX_PLAYERS;
    this.state.totalRounds = TOTAL_ROUNDS;
    this.state.livesPerRound = LIVES_PER_ROUND;
    this.state.roundWinsToTakeMatch = ROUND_WINS_TO_TAKE_MATCH;
    this.state.phase = "lobby";

    // Only the host can drive the match forward. Everyone else's press is a
    // no-op — never trust the client to tell us who it is.
    this.onMessage("startMatch", (client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") return;
      if (this.state.players.size === 0) return;
      this.resetMatch();
      this.startCountdown();
    });

    this.setFixedTimestep((ctx) => {
      this.state.tick++;
      this.stepPlayers(ctx.dt);
      this.updatePhase();
    }, TICK_RATE);

    logger.info(`[arena] room ${this.roomId} up at ${TICK_RATE}Hz`);
  }

  // ---------------------------------------------------------------- players

  onJoin(client: Client, options?: { name?: string }) {
    const slot = this.nextSlot++ % SPAWN_POINTS.length;
    // A match already in progress: sit this round out, join at the next one.
    const midMatch = this.state.phase !== "lobby";

    const player = new Player({
      ...spawnBody(slot),
      name: (options?.name ?? "").slice(0, 12) || `P${slot + 1}`,
      color: PLAYER_COLORS[slot % PLAYER_COLORS.length]!,
      slot,
      // Spread first so these two win: `spawnBody` carries `frozen: false`.
      spectating: midMatch,
      frozen: midMatch,
    });

    this.state.players.set(client.sessionId, player);
    if (!this.state.hostId) this.state.hostId = client.sessionId;

    logger.info(
      `[arena] ${player.name} (${client.sessionId}) joined` +
        `${midMatch ? " — spectating until next round" : ""}`,
    );
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);

    // Hand the host role to whoever is still here, so the match isn't stuck.
    if (this.state.hostId === client.sessionId) {
      this.state.hostId = this.state.players.keys().next().value ?? "";
    }
    // A round that just lost its last opponent is resolved by updatePhase().
  }

  onDispose() {
    logger.info(`[arena] room ${this.roomId} disposed`);
  }

  // --------------------------------------------------------------- physics

  private stepPlayers(dt: number) {
    for (const [sessionId, player] of this.state.players) {
      // Timers first: they have to advance even on a tick where this client's
      // input hasn't landed yet, or a dead player would never come back.
      this.advanceTimers(player);

      // Exactly one input per player per step. Draining the buffer and applying
      // only the newest would ack inputs we never simulated, and the client's
      // replay would then disagree with us. No input yet? Don't guess — wait.
      const input = this.inputs.get(sessionId).next();
      if (input === undefined) continue;

      this.tryAttack(player, input.attack);

      // `player` is structurally a PlayerBody — same function the client runs.
      const fellOff = stepBody(player, input, dt);
      if (!fellOff) continue;

      if (this.state.phase === "playing" && !player.spectating && player.lives > 0) {
        this.killFighter(player);
      } else {
        // Milling about in the lobby or between rounds: falling is free.
        respawnBody(player, player.slot);
      }
    }
  }

  /**
   * Start a swing if the button is down and the last one has fully recovered.
   * Purely cosmetic for now — Track B spawns the hitbox off this same window.
   */
  private tryAttack(player: Player, pressed: boolean) {
    if (!pressed || player.frozen) return;
    const readyAt = player.attackUntilTick + msToTicks(ATTACK_RECOVERY_MS);
    if (this.state.tick < readyAt) return;
    player.attackUntilTick = this.state.tick + msToTicks(ATTACK_SWING_MS);
  }

  private advanceTimers(player: Player) {
    if (player.deadUntilTick !== 0 && this.state.tick >= player.deadUntilTick) {
      this.respawnFighter(player);
    }
    if (player.invulnUntilTick !== 0 && this.state.tick >= player.invulnUntilTick) {
      player.invulnUntilTick = 0;
    }
  }

  /** Cost a life. Either respawn shortly, or sit out the rest of the round. */
  private killFighter(player: Player) {
    player.lives -= 1;
    // Frozen where they fell — `stepBody` short-circuits, so no repeat kill.
    player.frozen = true;
    player.vx = 0;
    player.vy = 0;

    if (player.lives > 0) {
      player.deadUntilTick = this.state.tick + msToTicks(RESPAWN_DELAY_MS);
    } else {
      player.deadUntilTick = 0;
      logger.info(`[arena] ${player.name} is out (round ${this.state.round})`);
    }
  }

  private respawnFighter(player: Player) {
    respawnBody(player, player.slot); // also clears `frozen`
    player.deadUntilTick = 0;
    player.attackUntilTick = 0;
    player.invulnUntilTick = this.state.tick + msToTicks(SPAWN_IFRAME_MS);
  }

  // ----------------------------------------------------------- match phases

  private updatePhase() {
    switch (this.state.phase) {
      case "countdown":
        if (this.state.tick >= this.state.phaseEndsAtTick) this.beginRound();
        break;

      case "playing":
        this.checkRoundOver();
        break;

      case "roundOver":
        if (this.state.tick >= this.state.phaseEndsAtTick) this.afterRound();
        break;

      // `lobby` and `matchOver` both wait on the host, not on a clock.
      default:
        break;
    }
  }

  private startCountdown() {
    this.state.round += 1;
    this.state.phase = "countdown";
    this.state.phaseEndsAtTick = this.state.tick + msToTicks(COUNTDOWN_MS);
    this.state.lastRoundWinnerId = "";

    for (const player of this.state.players.values()) {
      // Anyone who joined mid-match is a full fighter from this round on.
      player.spectating = false;
      player.lives = this.state.livesPerRound;
      player.deadUntilTick = 0;
      player.invulnUntilTick = 0;
      player.attackUntilTick = 0;
      respawnBody(player, player.slot);
      player.frozen = true; // held at spawn while "3 · 2 · 1" runs
    }

    logger.info(`[arena] round ${this.state.round} of ${this.state.totalRounds}`);
  }

  private beginRound() {
    this.state.phase = "playing";
    this.state.phaseEndsAtTick = 0;
    this.roundStartedWith = this.fighters().length;

    for (const player of this.state.players.values()) {
      if (player.spectating) continue;
      player.frozen = false;
      player.invulnUntilTick = this.state.tick + msToTicks(SPAWN_IFRAME_MS);
    }
  }

  private checkRoundOver() {
    // Solo practice: no opponents, so there is nothing to win. Keep it running
    // so one person on one phone can still test movement, death and respawn.
    if (this.roundStartedWith < MIN_PLAYERS) return;

    const fighters = this.fighters();
    if (fighters.length === 0) return; // everyone left; wait for dispose

    const standing = fighters.filter(([, p]) => p.lives > 0);
    if (standing.length > 1) return;

    // Exactly one left wins it; zero means a simultaneous KO — nobody scores.
    this.endRound(standing[0]);
  }

  private endRound(winner?: [string, Player]) {
    if (winner) {
      winner[1].roundWins += 1;
      this.state.lastRoundWinnerId = winner[0];
      logger.info(`[arena] round ${this.state.round} to ${winner[1].name}`);
    } else {
      this.state.lastRoundWinnerId = "";
      logger.info(`[arena] round ${this.state.round} was a draw`);
    }

    for (const player of this.state.players.values()) player.frozen = true;

    this.state.phase = "roundOver";
    this.state.phaseEndsAtTick = this.state.tick + msToTicks(ROUND_OVER_MS);
  }

  private afterRound() {
    const champion = this.matchChampion();
    const roundsExhausted = this.state.round >= this.state.totalRounds;

    if (champion || roundsExhausted) {
      this.state.matchWinnerId = champion ?? this.leaderOnRoundWins() ?? "";
      this.state.phase = "matchOver";
      this.state.phaseEndsAtTick = 0;
      logger.info(`[arena] match over — winner ${this.state.matchWinnerId || "(draw)"}`);
      return;
    }

    this.startCountdown();
  }

  private resetMatch() {
    this.state.round = 0;
    this.state.matchWinnerId = "";
    this.state.lastRoundWinnerId = "";
    for (const player of this.state.players.values()) player.roundWins = 0;
  }

  // ---------------------------------------------------------------- helpers

  /** Everyone taking part in the current round, as [sessionId, player]. */
  private fighters(): [string, Player][] {
    return Array.from(this.state.players.entries()).filter(([, p]) => !p.spectating);
  }

  /** Session id of the first player to reach the round-win target, if any. */
  private matchChampion(): string | undefined {
    for (const [sessionId, player] of this.state.players) {
      if (player.roundWins >= this.state.roundWinsToTakeMatch) return sessionId;
    }
    return undefined;
  }

  /** Outright leader on round wins once the rounds run out; undefined if tied. */
  private leaderOnRoundWins(): string | undefined {
    let best: string | undefined;
    let bestWins = -1;
    let tied = false;

    for (const [sessionId, player] of this.state.players) {
      if (player.roundWins > bestWins) {
        bestWins = player.roundWins;
        best = sessionId;
        tied = false;
      } else if (player.roundWins === bestWins) {
        tied = true;
      }
    }
    return tied ? undefined : best;
  }
}
