import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Room, type Client, logger } from "@colyseus/core";
import {
  ArenaState,
  ATTACK_ACTIVE_MS,
  ATTACK_RECOVERY_MS,
  ATTACK_STARTUP_MS,
  ATTACK_SWING_MS,
  COUNTDOWN_MS,
  DEFAULT_HAT,
  DEFAULT_MAP_ID,
  DEFAULT_STAKE,
  HITSTUN_BASE_MS,
  HITSTUN_MAX_MS,
  HITSTUN_PER_DAMAGE_MS,
  HIT_DAMAGE,
  KNOCKBACK_BASE,
  KNOCKBACK_LIFT,
  KNOCKBACK_SCALING,
  KNOCKBACK_UP_RATIO,
  FightInput,
  LIVES_OPTIONS,
  LIVES_PER_ROUND,
  MAX_DAMAGE,
  MAX_KNOCKBACK,
  MAX_NAME_LENGTH,
  MAX_STAKE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  Player,
  RESPAWN_DELAY_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROUND_OPTIONS,
  ROUND_OVER_MS,
  ROUND_WINS_TO_TAKE_MATCH,
  SPAWN_IFRAME_MS,
  TICK_RATE,
  TOTAL_ROUNDS,
  attackHitbox,
  bodyAabb,
  getMap,
  isHatId,
  isHexColor,
  isMapId,
  msToTicks,
  NEUTRAL_INPUT,
  overlapsRect,
  roundWinsToTakeMatch,
  respawnBody,
  spawnBody,
  stepBody,
  type Rect,
  type WorldMap,
} from "@stickstakes/shared";

/**
 * Room codes held by a live room in THIS process. One process owns every room
 * (`LocalPresence` + `LocalDriver`, per the README), so this set IS the
 * authority — a synchronous check-and-insert with no `await` to race across,
 * and no matchmaker round trip on the room-creation path. A multi-node
 * deployment would move this to Redis (`SETNX`), per the README's scaling note.
 */
const claimedRoomCodes = new Set<string>();

/** Host-only match setup message. Every field is validated server-side. */
interface Configure {
  totalRounds?: number;
  livesPerRound?: number;
  stake?: string;
  mapId?: string;
}

/** Per-player wardrobe. Anyone may set their own; every value is validated. */
interface Customize {
  color?: string;
  hat?: string;
}

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

  /**
   * Spawn/colour slot in use by each session. A slot is the index into the
   * map's spawn list and `PLAYER_COLORS`. Released in `onLeave` and reused, so
   * an evening of drops and rejoins can't wrap a monotonic counter and seat
   * two players on the same spawn point in the same colour.
   */
  private slots = new Map<string, number>();

  /**
   * Last time (ms) each client sent each throttled message type. Every accepted
   * `ready` / `rename` / `customize` / `configure` dirties synced state, which
   * Colyseus then re-encodes and broadcasts to the whole room — so a client
   * spamming them can saturate everyone's bandwidth. Cleared in `onLeave`.
   */
  private lastMessageAt = new Map<string, Map<string, number>>();

  /**
   * How many fighters the current round started with. A round that began with
   * one player is practice — it has no winner and never ends on its own, which
   * is what makes testing alone on a single phone possible.
   */
  private roundStartedWith = 0;

  /**
   * Targets each attacker has already connected with during their current
   * swing. Server-local and transient — it never needs to reach a client.
   */
  private hitThisSwing = new Map<string, Set<string>>();

  /**
   * Reusable AABBs for the per-tick hazard and hit passes. The geometry
   * helpers fill one of these instead of returning a fresh object, so a busy
   * room streams no short-lived garbage from collision detection.
   */
  private readonly hazardBox: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly attackBox: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly targetBox: Rect = { x: 0, y: 0, width: 0, height: 0 };

  /** Tick-budget watch: a 30 Hz loop slipping under budget reads as lag on the
   *  client and is invisible from there, so count overruns and log them. */
  private readonly tickBudgetMs = 1000 / TICK_RATE;
  private tickOverruns = 0;
  private lastOverrunLogAt = 0;

  /** This room's world, memoised on `mapId` so `this.map` is a field read
   *  rather than a `Map` lookup on every access (it is read per player,
   *  per tick). Invalidated the moment the host changes the map. */
  private cachedMapId = "";
  private cachedMap: WorldMap = getMap(DEFAULT_MAP_ID);

  onCreate() {
    // A short, speakable room code instead of Colyseus's generated id, so the
    // host can read it across a table. Replacing `roomId` here is supported.
    this.roomId = this.reserveRoomCode();

    this.setState(new ArenaState());
    this.state.maxPlayers = MAX_PLAYERS;
    this.state.totalRounds = TOTAL_ROUNDS;
    this.state.livesPerRound = LIVES_PER_ROUND;
    this.state.roundWinsToTakeMatch = ROUND_WINS_TO_TAKE_MATCH;
    this.state.stake = DEFAULT_STAKE;
    this.state.mapId = DEFAULT_MAP_ID;
    this.state.phase = "lobby";

    // Only the host can drive the match forward. Everyone else's press is a
    // no-op — never trust the client to tell us who it is.
    this.onMessage("startMatch", (client) => {
      if (client.sessionId !== this.state.hostId) {
        client.send("startRefused", { reason: "notHost" });
        return;
      }
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") {
        client.send("startRefused", { reason: "wrongPhase" });
        return;
      }
      if (this.state.players.size === 0) return;
      // Every active (non-spectating, connected) player has to have readied up
      // first — the host included. A silent no-op here is exactly how a dead
      // "Play again" button hid for so long; say why instead.
      if (!this.everyoneReady()) {
        client.send("startRefused", { reason: "notEveryoneReady" });
        return;
      }
      this.resetMatch();
      this.startCountdown();
    });

    /**
     * Ready toggle. Anyone may set their own ready flag (and only their own)
     * while the room is waiting in the lobby or on the match-over screen. An
     * explicit boolean sets it; a bare message flips it.
     */
    this.onMessage("ready", (client, message?: { ready?: boolean }) => {
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (this.throttled(client.sessionId, "ready", 200)) return;
      const next =
        typeof message?.ready === "boolean" ? message.ready : !player.ready;
      if (next !== player.ready) player.ready = next; // no broadcast on a no-op
    });

    /**
     * Host-only match setup. Everything is validated against the shared option
     * lists rather than trusted: a hand-crafted message must not be able to set
     * 200 lives or paste a megabyte of "stake".
     */
    this.onMessage("configure", (client, message: Configure) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") return;
      if (this.throttled(client.sessionId, "configure", 150)) return;

      // Each write is guarded on an actual change — an unchanged value must not
      // dirty the schema and trigger a room-wide re-broadcast.
      const rounds = Number(message?.totalRounds);
      if (ROUND_OPTIONS.includes(rounds) && rounds !== this.state.totalRounds) {
        this.state.totalRounds = rounds;
        this.state.roundWinsToTakeMatch = roundWinsToTakeMatch(rounds);
      }

      const lives = Number(message?.livesPerRound);
      if (LIVES_OPTIONS.includes(lives) && lives !== this.state.livesPerRound) {
        this.state.livesPerRound = lives;
      }

      // The world. Validated against the shipped list; an unknown id is dropped
      // and the current map stays. Only settable in the lobby / on match-over,
      // like every other rule, so the geometry never shifts mid-round.
      if (isMapId(message?.mapId) && message.mapId !== this.state.mapId) {
        this.state.mapId = message.mapId;
      }

      if (typeof message?.stake === "string") {
        const stake = message.stake.trim().slice(0, MAX_STAKE_LENGTH);
        const next = stake || DEFAULT_STAKE;
        if (next !== this.state.stake) this.state.stake = next;
      }
    });

    /** Anyone may rename themselves, but only themselves. */
    this.onMessage("rename", (client, message: { name?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (this.throttled(client.sessionId, "rename", 150)) return;
      const name = String(message?.name ?? "").trim().slice(0, MAX_NAME_LENGTH);
      if (name && name !== player.name) player.name = name;
    });

    /**
     * Wardrobe. Anyone may restyle their own stickman at any time — it is
     * cosmetic and never touches the simulation. Junk values are dropped, not
     * clamped: a bad colour or an unknown hat just leaves the old one in place.
     */
    this.onMessage("customize", (client, message: Customize) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (this.throttled(client.sessionId, "customize", 150)) return;
      if (isHexColor(message?.color)) {
        const color = message.color.toLowerCase();
        if (color !== player.color) player.color = color;
      }
      if (isHatId(message?.hat) && message.hat !== player.hat) player.hat = message.hat;
    });

    this.setFixedTimestep((ctx) => {
      // A room everyone has left keeps running the full physics + phase loop
      // until `autoDispose` fires — nothing to simulate, so skip it.
      if (this.state.players.size === 0) return;

      const startedAt = performance.now();

      this.state.tick++;
      this.stepPlayers(ctx.dt);
      // Hits resolve after every body has moved, so a tick sees one consistent
      // world rather than positions half-updated in map order.
      this.resolveHits();
      this.updatePhase();

      const elapsed = performance.now() - startedAt;
      if (elapsed > this.tickBudgetMs) {
        this.tickOverruns++;
        const now = Date.now();
        if (now - this.lastOverrunLogAt > 5000) {
          this.lastOverrunLogAt = now;
          logger.warn(
            `[arena] room ${this.roomId} tick ${elapsed.toFixed(1)}ms over ` +
              `${this.tickBudgetMs.toFixed(1)}ms budget — ${this.tickOverruns} overrun(s) so far, ` +
              `${this.state.players.size} player(s)`,
          );
        }
      }
    }, TICK_RATE);

    logger.info(`[arena] room ${this.roomId} up at ${TICK_RATE}Hz`);
  }

  /**
   * Pick a room code nobody is using. Collisions are vanishingly rare at
   * 24^4, but "vanishingly rare" across a whole evening of a busy restaurant
   * is still a person joining a stranger's fight — so check the in-process set
   * of live codes and retry. O(1) and `await`-free: the check-and-insert can't
   * be interleaved with another room's, so the TOCTOU race is closed, and the
   * room-creation path no longer waits on up to a dozen matchmaker round trips.
   */
  private reserveRoomCode(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      // `crypto.randomInt` rather than `Math.random`: the code is the only
      // access control on a room, and a predictable PRNG over a 331k keyspace
      // makes enumeration cheap.
      const code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)],
      ).join("");

      if (claimedRoomCodes.has(code)) continue;
      claimedRoomCodes.add(code); // released in onDispose
      return code;
    }
    // Astronomically unlikely; fall back to the generated id rather than fail.
    logger.warn("[arena] could not find a free room code, keeping the default");
    return this.roomId;
  }

  /**
   * True if this client sent `kind` less than `everyMs` ago — the caller then
   * drops the message. Per-client, per-type; the maps are cleared in `onLeave`.
   */
  private throttled(sessionId: string, kind: string, everyMs: number): boolean {
    let perKind = this.lastMessageAt.get(sessionId);
    if (!perKind) {
      perKind = new Map();
      this.lastMessageAt.set(sessionId, perKind);
    }
    const now = Date.now();
    if (now - (perKind.get(kind) ?? 0) < everyMs) return true;
    perKind.set(kind, now);
    return false;
  }

  /** Lowest spawn/colour slot no one in the room is using right now. */
  private takeSlot(sessionId: string): number {
    const count = Math.max(this.map.spawns.length, 1);
    const used = new Set(this.slots.values());
    let slot = 0;
    while (slot < count - 1 && used.has(slot)) slot++;
    // More players than the map has spawns: wrap, and accept the double-up.
    if (used.has(slot)) slot = this.slots.size % count;
    this.slots.set(sessionId, slot);
    return slot;
  }

  // ---------------------------------------------------------------- players

  /** This room's world. Passed explicitly into the shared step so that many
   *  rooms on one process can run different maps without a shared global.
   *  Memoised on `mapId`: read per player per tick, so the `Map` lookup only
   *  runs when the host actually switches the map. */
  private get map(): WorldMap {
    if (this.state.mapId !== this.cachedMapId) {
      this.cachedMapId = this.state.mapId;
      this.cachedMap = getMap(this.state.mapId);
    }
    return this.cachedMap;
  }

  onJoin(client: Client, options?: { name?: string; color?: string; hat?: string }) {
    const slot = this.takeSlot(client.sessionId);
    // A match already in progress: sit this round out, join at the next one.
    const midMatch = this.state.phase !== "lobby";

    const player = new Player({
      ...spawnBody(slot, this.map.spawns),
      name: (options?.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || `P${slot + 1}`,
      // Their wardrobe pick if it's valid, otherwise the join-order colour.
      color: isHexColor(options?.color)
        ? options.color.toLowerCase()
        : PLAYER_COLORS[slot % PLAYER_COLORS.length]!,
      hat: isHatId(options?.hat) ? options.hat : DEFAULT_HAT,
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

  /**
   * A non-consented drop — a phone locking, Wi-Fi handing off to cellular, a
   * tunnel. Hold the fighter (greyed client-side, still simulated so it can
   * still fall) and let them slot back into the same session. If the window
   * elapses, Colyseus follows up with `onLeave`, which does the removal.
   */
  async onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    try {
      await this.allowReconnection(client, 20);
    } catch {
      // Reconnection window elapsed; `onLeave` will clean up.
    }
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    logger.info(`[arena] ${player?.name ?? client.sessionId} reconnected`);
  }

  onLeave(client: Client) {
    this.removePlayer(client.sessionId);
  }

  private removePlayer(sessionId: string) {
    this.state.players.delete(sessionId);
    this.hitThisSwing.delete(sessionId);
    this.slots.delete(sessionId);
    this.lastMessageAt.delete(sessionId);

    // Hand the host role to whoever is still here, so the match isn't stuck.
    if (this.state.hostId === sessionId) {
      this.state.hostId = this.state.players.keys().next().value ?? "";
    }
    // A round that just lost its last opponent is resolved by updatePhase().
  }

  onDispose() {
    claimedRoomCodes.delete(this.roomId);
    logger.info(`[arena] room ${this.roomId} disposed`);
  }

  // --------------------------------------------------------------- physics

  private stepPlayers(dt: number) {
    const map = this.map;
    for (const [sessionId, player] of this.state.players) {
      // Timers first: they have to advance even on a tick where this client's
      // input hasn't landed yet, or a dead player would never come back.
      this.advanceTimers(player);

      // Exactly one input per player per step. Draining the buffer and applying
      // only the newest would ack inputs we never simulated, and the client's
      // replay would then disagree with us.
      const buffered = this.inputs.get(sessionId).next();

      // No input this tick — a backgrounded tab, a phone waking, a throttled or
      // dropped socket. Simulate with a NEUTRAL command anyway: gravity, the
      // fall-off-the-world check and hazards must still apply, or a player can
      // kill their network mid-jump and hang in the air indefinitely (and a
      // hovering body never loses its last life, so the round never ends).
      // Only the input *ack* is withheld — `.next()` above consumed nothing —
      // so the client's replay stays in lock-step once frames resume.
      const input = buffered ?? NEUTRAL_INPUT;
      if (buffered !== undefined) this.tryAttack(sessionId, player, buffered.attack);

      // `player` is structurally a PlayerBody — same function the client runs.
      const fellOff = stepBody(player, input, dt, map);

      const inFight =
        this.state.phase === "playing" && !player.spectating && player.lives > 0;
      // A hazard (spikes, a saw blade) is resolved here, next to the fall off
      // the world — both cost exactly one life and the client predicts neither.
      // Skip a body that's already dying: `killFighter` freezes it in place, so
      // without this guard a corpse lying on the spikes is re-killed every tick
      // and burns through every life before the respawn timer can fire.
      const struck =
        inFight &&
        !player.frozen &&
        player.deadUntilTick === 0 &&
        this.touchesHazard(player, map);

      if (!fellOff && !struck) continue;

      if (inFight) {
        this.killFighter(player);
      } else {
        // Milling about in the lobby or between rounds: falling is free.
        respawnBody(player, player.slot, map.spawns);
      }
    }
  }

  /** Is this body overlapping any of the current map's kill rectangles? */
  private touchesHazard(player: Player, map: WorldMap): boolean {
    if (map.hazards.length === 0) return false;
    const box = bodyAabb(player, this.hazardBox);
    for (const hazard of map.hazards) {
      if (overlapsRect(box, hazard)) return true;
    }
    return false;
  }

  /** Start a swing if the button is down and the last one has fully recovered. */
  private tryAttack(sessionId: string, player: Player, pressed: boolean) {
    // Only during a live round. A lobby swing hurts no one (`resolveHits` is
    // phase-gated) but it still animates, fires the swing SFX, and can carry a
    // cooldown across the countdown into the first frames of the fight.
    if (this.state.phase !== "playing") return;
    if (!pressed || player.frozen || player.stunned) return;
    const readyAt = player.attackUntilTick + msToTicks(ATTACK_RECOVERY_MS);
    if (this.state.tick < readyAt) return;

    player.attackUntilTick = this.state.tick + msToTicks(ATTACK_SWING_MS);
    // A fresh swing may hit everyone again.
    this.hitThisSwing.set(sessionId, new Set());
  }

  private advanceTimers(player: Player) {
    if (player.deadUntilTick !== 0 && this.state.tick >= player.deadUntilTick) {
      this.respawnFighter(player);
    }
    if (player.invulnUntilTick !== 0 && this.state.tick >= player.invulnUntilTick) {
      player.invulnUntilTick = 0;
    }
    if (player.stunUntilTick !== 0 && this.state.tick >= player.stunUntilTick) {
      player.stunUntilTick = 0;
      player.stunned = false;
    }
  }

  // ----------------------------------------------------------------- combat

  /**
   * Is this player's swing in its active frames? A swing runs
   * startup → active → the rest of the animation, so an attack is a
   * commitment rather than a free button press.
   */
  private isSwingActive(player: Player): boolean {
    if (player.attackUntilTick === 0) return false;
    const since =
      this.state.tick - (player.attackUntilTick - msToTicks(ATTACK_SWING_MS));
    const startup = msToTicks(ATTACK_STARTUP_MS);
    return since >= startup && since < startup + msToTicks(ATTACK_ACTIVE_MS);
  }

  /** Can this player be hit right now? */
  private isHittable(player: Player): boolean {
    return (
      !player.spectating &&
      !player.frozen &&
      player.lives > 0 &&
      player.deadUntilTick === 0 &&
      player.invulnUntilTick <= this.state.tick
    );
  }

  private resolveHits() {
    if (this.state.phase !== "playing") return;

    for (const [attackerId, attacker] of this.state.players) {
      if (!this.isSwingActive(attacker)) continue;

      // The one-hit-per-target-per-swing set. Make it exist rather than
      // optional-chaining every use: if the entry were ever missing (a future
      // code path that sets `attackUntilTick` without going through
      // `tryAttack`), `?.` would silently drop the guard and the hitbox would
      // connect on every active tick — a fail-open bug.
      let alreadyHit = this.hitThisSwing.get(attackerId);
      if (!alreadyHit) {
        alreadyHit = new Set();
        this.hitThisSwing.set(attackerId, alreadyHit);
      }
      const box = attackHitbox(attacker, this.attackBox);

      for (const [targetId, target] of this.state.players) {
        if (targetId === attackerId) continue;
        // One hit per target per swing — otherwise the box connects on every
        // active tick and a single press would deal several hits.
        if (alreadyHit.has(targetId)) continue;
        if (!this.isHittable(target)) continue;
        if (!overlapsRect(box, bodyAabb(target, this.targetBox))) continue;

        alreadyHit.add(targetId);
        this.applyHit(attacker, target);
      }
    }
  }

  private applyHit(attacker: Player, target: Player) {
    target.damage = Math.min(MAX_DAMAGE, target.damage + HIT_DAMAGE);

    // Launch away from the attacker; a dead-on tie breaks toward where the
    // attacker faces (`facing` is maintained as 1 | -1, so no zero case).
    const away =
      target.x === attacker.x
        ? attacker.facing >= 0
          ? 1
          : -1
        : target.x < attacker.x
          ? -1
          : 1;

    // Clamp the impulse. `KNOCKBACK_BASE + MAX_DAMAGE * KNOCKBACK_SCALING` is
    // ~4400 px/s, which even with `stepBody`'s substepping is a needlessly
    // violent launch; `MAX_KNOCKBACK` keeps it sane without changing anything
    // at realistic damage.
    const power = Math.min(
      MAX_KNOCKBACK,
      KNOCKBACK_BASE + target.damage * KNOCKBACK_SCALING,
    );
    target.vx = away * power;
    target.vy = -(KNOCKBACK_LIFT + power * KNOCKBACK_UP_RATIO);
    target.grounded = false;
    // Hit mid-jump: the rise is the game's now, so it must not be cut short.
    target.jumping = false;

    const stunMs = Math.min(
      HITSTUN_MAX_MS,
      HITSTUN_BASE_MS + target.damage * HITSTUN_PER_DAMAGE_MS,
    );
    target.stunUntilTick = this.state.tick + msToTicks(stunMs);
    target.stunned = true;
  }

  /** Cost a life. Either respawn shortly, or sit out the rest of the round. */
  private killFighter(player: Player) {
    player.lives -= 1;
    // Frozen where they fell — `stepBody` short-circuits, so no repeat kill.
    player.frozen = true;
    player.stunned = false;
    player.stunUntilTick = 0;
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
    respawnBody(player, player.slot, this.map.spawns); // also clears `frozen` / `stunned`
    player.deadUntilTick = 0;
    player.attackUntilTick = 0;
    player.stunUntilTick = 0;
    // Damage is per-life: you come back fresh and hard to launch again.
    player.damage = 0;
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
      player.stunUntilTick = 0;
      player.damage = 0;
      player.ready = false; // next lobby / "play again" needs fresh readies
      respawnBody(player, player.slot, this.map.spawns);
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

    // One pass, no arrays: this runs every tick during `playing`, and the old
    // `Array.from(...).filter(...)` then `.filter()` again was two allocations
    // a tick per room for a plain count.
    let fighters = 0;
    let standing = 0;
    let lastStanding: [string, Player] | undefined;
    for (const entry of this.state.players) {
      if (entry[1].spectating) continue;
      fighters++;
      if (entry[1].lives > 0) {
        standing++;
        lastStanding = entry;
      }
    }

    if (fighters === 0) return; // everyone left; wait for dispose
    if (standing > 1) return;

    // Exactly one left wins it; zero means a simultaneous KO — nobody scores.
    this.endRound(standing === 1 ? lastStanding : undefined);
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

  /**
   * True once every player who *can* ready up has. Spectators (joined
   * mid-match) and briefly-disconnected players have no lobby UI to ready
   * with, so counting them would let one badly-timed join or drop lock the
   * room out of ever starting again.
   */
  private everyoneReady(): boolean {
    const active = [...this.state.players.values()].filter(
      (p) => !p.spectating && p.connected,
    );
    return active.length > 0 && active.every((p) => p.ready);
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
