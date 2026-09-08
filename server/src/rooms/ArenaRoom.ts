import { Room, ServerError, matchMaker, type Client, logger } from "@colyseus/core";
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
  ERR_LEFT_MID_MATCH,
  HITSTUN_BASE_MS,
  HITSTUN_MAX_MS,
  HITSTUN_PER_DAMAGE_MS,
  HIT_DAMAGE,
  KNOCKBACK_BASE,
  KNOCKBACK_LIFT,
  KNOCKBACK_SCALING,
  KNOCKBACK_UP_RATIO,
  FightInput,
  LEFT_MID_MATCH_MESSAGE,
  LIVES_OPTIONS,
  LIVES_PER_ROUND,
  MAX_CLIENT_TOKEN_LENGTH,
  MAX_DAMAGE,
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
  SPAWN_POINTS,
  TICK_RATE,
  TOTAL_ROUNDS,
  attackHitbox,
  bodyAabb,
  getMap,
  isHatId,
  isHexColor,
  isLivePhase,
  isMapId,
  msToTicks,
  overlapsRect,
  roundWinsToTakeMatch,
  respawnBody,
  spawnBody,
  stepBody,
  type WorldMap,
} from "@stickstakes/shared";

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
 *
 * The host can also bail out of a live match from the pause menu, either
 * straight back into a fresh countdown (`restartMatch`) or all the way back to
 * the lobby (`endMatch`), which is the only way to reopen the room to someone
 * who quit part-way through.
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

  /**
   * Targets each attacker has already connected with during their current
   * swing. Server-local and transient — it never needs to reach a client.
   */
  private hitThisSwing = new Map<string, Set<string>>();

  /**
   * Each connected client's own id, as remembered by their browser. The
   * session id is useless for telling people apart across a reconnect — it is
   * new every time — so this is what the quit lockout below is keyed on.
   */
  private tokens = new Map<string, string>();

  /**
   * Tokens of the fighters who walked out of the match that is running now.
   * They stay locked out until it ends, or until the host takes the room back
   * to the lobby. Rejoining mid-match would hand them a full set of lives and
   * wipe the damage they were carrying, which is the cheapest imaginable way
   * to escape a losing round.
   */
  private quitters = new Set<string>();

  /**
   * Each player's `frozen` flag as it was the moment the room was paused, so
   * resuming puts everyone back exactly as they were — a corpse mid-respawn
   * stays a corpse, a fighter goes straight back to fighting.
   */
  private frozenBeforePause = new Map<string, boolean>();

  async onCreate() {
    // A short, speakable room code instead of Colyseus's generated id, so the
    // host can read it across a table. Replacing `roomId` here is supported.
    this.roomId = await this.reserveRoomCode();

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
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") return;
      if (this.state.players.size === 0) return;
      // Everyone in the room has to have readied up first — the host included.
      if (!this.everyoneReady()) return;
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
      player.ready =
        typeof message?.ready === "boolean" ? message.ready : !player.ready;
    });

    /**
     * Host-only match setup. Everything is validated against the shared option
     * lists rather than trusted: a hand-crafted message must not be able to set
     * 200 lives or paste a megabyte of "stake".
     */
    this.onMessage("configure", (client, message: Configure) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") return;

      const rounds = Number(message?.totalRounds);
      if (ROUND_OPTIONS.includes(rounds)) {
        this.state.totalRounds = rounds;
        this.state.roundWinsToTakeMatch = roundWinsToTakeMatch(rounds);
      }

      const lives = Number(message?.livesPerRound);
      if (LIVES_OPTIONS.includes(lives)) this.state.livesPerRound = lives;

      // The world. Validated against the shipped list; an unknown id is dropped
      // and the current map stays. Only settable in the lobby / on match-over,
      // like every other rule, so the geometry never shifts mid-round.
      if (isMapId(message?.mapId)) this.state.mapId = message.mapId;

      if (typeof message?.stake === "string") {
        const stake = message.stake.trim().slice(0, MAX_STAKE_LENGTH);
        this.state.stake = stake || DEFAULT_STAKE;
      }
    });

    /** Anyone may rename themselves, but only themselves. */
    this.onMessage("rename", (client, message: { name?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const name = String(message?.name ?? "").trim().slice(0, MAX_NAME_LENGTH);
      if (name) player.name = name;
    });

    /**
     * Wardrobe. Anyone may restyle their own stickman at any time — it is
     * cosmetic and never touches the simulation. Junk values are dropped, not
     * clamped: a bad colour or an unknown hat just leaves the old one in place.
     */
    this.onMessage("customize", (client, message: Customize) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (isHexColor(message?.color)) player.color = message.color.toLowerCase();
      if (isHatId(message?.hat)) player.hat = message.hat;
    });

    /**
     * Host-only bail-outs from a live match, both driven from the pause menu.
     *
     * `restartMatch` throws the current match away and starts the same setup
     * again from round one — the answer to "this one stinks". `endMatch` goes
     * further and puts the room back in the lobby, where the rules and the map
     * can be changed before the next one. Neither asks for readies: everyone
     * already opted in when this match started, and a host who cannot restart
     * without chasing five people for a second ready would just leave instead.
     */
    this.onMessage("restartMatch", (client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (!isLivePhase(this.state.phase)) return;
      this.setPaused(false);
      this.resetMatch();
      // The match somebody walked out of is gone, so their lockout goes with it.
      this.reopenRoom();
      this.startCountdown();
      logger.info(`[arena] room ${this.roomId} restarted by the host`);
    });

    this.onMessage("endMatch", (client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase === "lobby") return;
      this.setPaused(false);
      this.returnToLobby();
      logger.info(`[arena] room ${this.roomId} sent back to the lobby by the host`);
    });

    /**
     * Pause. Deliberately solo-only: pausing is stopping the world, and one
     * person's menu has no business stopping four other people's fight. With
     * company the menu is a purely local overlay and the fight carries on
     * without you — which is the honest trade, and it is what the menu says.
     */
    this.onMessage("pause", (client, message?: { paused?: boolean }) => {
      if (!this.state.players.has(client.sessionId)) return;
      if (!isLivePhase(this.state.phase)) return;
      if (this.state.players.size > 1) return;
      this.setPaused(
        typeof message?.paused === "boolean" ? message.paused : !this.state.paused,
      );
    });

    this.setFixedTimestep((ctx) => {
      this.state.tick++;
      if (this.state.paused) {
        this.holdPaused();
        return;
      }
      this.stepPlayers(ctx.dt);
      // Hits resolve after every body has moved, so a tick sees one consistent
      // world rather than positions half-updated in map order.
      this.resolveHits();
      this.updatePhase();
    }, TICK_RATE);

    logger.info(`[arena] room ${this.roomId} up at ${TICK_RATE}Hz`);
  }

  /**
   * Pick a room code nobody is using. Collisions are vanishingly rare at
   * 24^4, but "vanishingly rare" across a whole evening of a busy restaurant
   * is still a person joining a stranger's fight, so check and retry.
   */
  private async reserveRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)],
      ).join("");

      const taken = await matchMaker.query({ roomId: code });
      if (taken.length === 0) return code;
    }
    // Astronomically unlikely; fall back to the generated id rather than fail.
    logger.warn("[arena] could not find a free room code, keeping the default");
    return this.roomId;
  }

  // ---------------------------------------------------------------- players

  /** This room's world. Passed explicitly into the shared step so that many
   *  rooms on one process can run different maps without a shared global. */
  private get map(): WorldMap {
    return getMap(this.state.mapId);
  }

  onJoin(
    client: Client,
    options?: { name?: string; color?: string; hat?: string; token?: string },
  ) {
    // Turned away before anything is touched: a quitter does not get to walk
    // back into the match they abandoned. Checked first so a refused join
    // leaves the room exactly as it found it.
    const token = String(options?.token ?? "").slice(0, MAX_CLIENT_TOKEN_LENGTH);
    if (token && this.quitters.has(token) && isLivePhase(this.state.phase)) {
      throw new ServerError(ERR_LEFT_MID_MATCH, LEFT_MID_MATCH_MESSAGE);
    }

    const slot = this.nextSlot++ % SPAWN_POINTS.length;
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
    if (token) this.tokens.set(client.sessionId, token);
    if (!this.state.hostId) this.state.hostId = client.sessionId;
    // A pause is a solo privilege, and this room is no longer solo.
    this.setPaused(false);

    logger.info(
      `[arena] ${player.name} (${client.sessionId}) joined` +
        `${midMatch ? " — spectating until next round" : ""}`,
    );
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    const token = this.tokens.get(client.sessionId);

    // Walked out of a live match as a fighter: locked out until it is over.
    // Spectators are let off — someone who followed a link into a match in
    // progress and lost their connection has nothing to gain by coming back,
    // and shutting them out would only punish a bad tunnel.
    if (token && player && !player.spectating && isLivePhase(this.state.phase)) {
      this.quitters.add(token);
      logger.info(`[arena] ${player.name} quit round ${this.state.round} — locked out`);
    }

    this.state.players.delete(client.sessionId);
    this.hitThisSwing.delete(client.sessionId);
    this.tokens.delete(client.sessionId);
    this.frozenBeforePause.delete(client.sessionId);

    // Hand the host role to whoever is still here, so the match isn't stuck.
    if (this.state.hostId === client.sessionId) {
      this.state.hostId = this.state.players.keys().next().value ?? "";
    }
    // Nobody left to lift it, and an empty room must not sit frozen if someone
    // walks back in.
    if (this.state.players.size === 0) this.setPaused(false);
    // A round that just lost its last opponent is resolved by updatePhase().
  }

  onDispose() {
    logger.info(`[arena] room ${this.roomId} disposed`);
  }

  // ----------------------------------------------------------------- pause

  /**
   * Stop (or restart) the world. Freezing every body is what makes the pause
   * honest on the client too: `frozen` is a synced field, so the reconciler
   * predicts a paused stickman exactly as still as the server simulates it,
   * with no drift to snap back from when play resumes.
   */
  private setPaused(paused: boolean) {
    if (paused === this.state.paused) return;
    this.state.paused = paused;

    if (paused) {
      this.frozenBeforePause.clear();
      for (const [sessionId, player] of this.state.players) {
        this.frozenBeforePause.set(sessionId, player.frozen);
        player.frozen = true;
      }
      logger.info(`[arena] room ${this.roomId} paused`);
      return;
    }

    for (const [sessionId, player] of this.state.players) {
      // Anyone who joined during the pause was never in the map; they are
      // frozen for their own reasons (spectating) and stay that way.
      const was = this.frozenBeforePause.get(sessionId);
      if (was !== undefined) player.frozen = was;
    }
    this.frozenBeforePause.clear();
    logger.info(`[arena] room ${this.roomId} resumed`);
  }

  /**
   * One tick of a paused room.
   *
   * `tick` still advances, because it is what acknowledges client input — stop
   * it and every phone in the room piles up unacknowledged frames for as long
   * as the menu is open. So instead, every deadline in the world moves along
   * with it: the pause costs the match nothing, no countdown eaten, no respawn
   * served early, no invulnerability burned standing still.
   */
  private holdPaused() {
    if (this.state.phaseEndsAtTick) this.state.phaseEndsAtTick++;

    for (const [sessionId, player] of this.state.players) {
      if (player.deadUntilTick) player.deadUntilTick++;
      if (player.invulnUntilTick) player.invulnUntilTick++;
      if (player.attackUntilTick) player.attackUntilTick++;
      if (player.stunUntilTick) player.stunUntilTick++;
      // Drain the buffer without simulating it. The body is frozen, so these
      // inputs would do nothing anyway — but consuming them is what keeps the
      // client's in-flight queue from growing for the length of the pause.
      this.inputs.get(sessionId).next();
    }
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
      // replay would then disagree with us. No input yet? Don't guess — wait.
      const input = this.inputs.get(sessionId).next();
      if (input === undefined) continue;

      this.tryAttack(sessionId, player, input.attack);

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
    const box = bodyAabb(player);
    for (const hazard of map.hazards) {
      if (overlapsRect(box, hazard)) return true;
    }
    return false;
  }

  /** Start a swing if the button is down and the last one has fully recovered. */
  private tryAttack(sessionId: string, player: Player, pressed: boolean) {
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

      const alreadyHit = this.hitThisSwing.get(attackerId);
      const box = attackHitbox(attacker);

      for (const [targetId, target] of this.state.players) {
        if (targetId === attackerId) continue;
        // One hit per target per swing — otherwise the box connects on every
        // active tick and a single press would deal several hits.
        if (alreadyHit?.has(targetId)) continue;
        if (!this.isHittable(target)) continue;
        if (!overlapsRect(box, bodyAabb(target))) continue;

        alreadyHit?.add(targetId);
        this.applyHit(attacker, target);
      }
    }
  }

  private applyHit(attacker: Player, target: Player) {
    target.damage = Math.min(MAX_DAMAGE, target.damage + HIT_DAMAGE);

    // Launch away from the attacker; ties break toward where they're facing.
    const away =
      target.x === attacker.x ? Math.sign(attacker.facing) || 1 : target.x < attacker.x ? -1 : 1;

    const power = KNOCKBACK_BASE + target.damage * KNOCKBACK_SCALING;
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
      // The match is done, so the door reopens: whoever quit can come back for
      // the next one.
      this.reopenRoom();
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

  /**
   * Abandon whatever is running and put the room back where it started: the
   * lobby, with the setup open and everyone un-readied. This is also the one
   * door back in for anyone who quit — the match they walked out of no longer
   * exists, so there is nothing left to lock them out of.
   */
  private returnToLobby() {
    this.state.phase = "lobby";
    this.state.phaseEndsAtTick = 0;
    this.resetMatch();
    this.reopenRoom();

    for (const player of this.state.players.values()) {
      player.ready = false;
      player.spectating = false;
      player.lives = 0;
      player.damage = 0;
      player.deadUntilTick = 0;
      player.invulnUntilTick = 0;
      player.attackUntilTick = 0;
      player.stunUntilTick = 0;
      // Clears `frozen` and `stunned` too, so everyone can mill about again.
      respawnBody(player, player.slot, this.map.spawns);
    }
    this.hitThisSwing.clear();
  }

  /** The match is over (or abandoned): let the quitters back in. */
  private reopenRoom() {
    this.quitters.clear();
  }

  // ---------------------------------------------------------------- helpers

  /** Everyone taking part in the current round, as [sessionId, player]. */
  private fighters(): [string, Player][] {
    return Array.from(this.state.players.entries()).filter(([, p]) => !p.spectating);
  }

  /** True once every player in the room has readied up (and there is one). */
  private everyoneReady(): boolean {
    if (this.state.players.size === 0) return false;
    for (const player of this.state.players.values()) {
      if (!player.ready) return false;
    }
    return true;
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
