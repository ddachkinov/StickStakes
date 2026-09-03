import { Room, type Client, logger } from "@colyseus/core";
import {
  ArenaState,
  FightInput,
  MAX_PLAYERS,
  PLAYER_COLORS,
  Player,
  SPAWN_POINTS,
  TICK_RATE,
  respawnBody,
  spawnBody,
  stepBody,
} from "@stickstakes/shared";

/**
 * The authoritative arena.
 *
 * Clients send input intent; this room owns every position. One input frame
 * == one fixed step == one broadcast tick, which is what lets the client
 * replay its unacknowledged inputs against server truth without drifting.
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

  onCreate() {
    this.setState(new ArenaState());
    this.state.maxPlayers = MAX_PLAYERS;

    this.setFixedTimestep((ctx) => {
      this.state.tick++;

      for (const [sessionId, player] of this.state.players) {
        // Exactly one input per player per step. Draining the buffer and
        // applying only the newest would ack inputs we never simulated, and
        // the client's replay would then disagree with us.
        const input = this.inputs.get(sessionId).next();
        if (input === undefined) continue;

        // `player` is structurally a PlayerBody — same function the client runs.
        const fellOff = stepBody(player, input, ctx.dt);
        if (fellOff) respawnBody(player, player.slot);
      }
    }, TICK_RATE);

    logger.info(`[arena] room ${this.roomId} up at ${TICK_RATE}Hz`);
  }

  onJoin(client: Client, options?: { name?: string }) {
    const slot = this.nextSlot++ % SPAWN_POINTS.length;
    const player = new Player({
      name: (options?.name ?? "").slice(0, 12) || `P${slot + 1}`,
      color: PLAYER_COLORS[slot % PLAYER_COLORS.length]!,
      slot,
      ...spawnBody(slot),
    });

    this.state.players.set(client.sessionId, player);
    logger.info(`[arena] ${player.name} (${client.sessionId}) joined`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    logger.info(`[arena] room ${this.roomId} disposed`);
  }
}
