import { Room, matchMaker, type Client, logger } from "@colyseus/core";
import {
  ARENA_WIDTH,
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
  MAX_NAME_LENGTH,
  MAX_STAKE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  Player,
  Projectile,
  RESPAWN_DELAY_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROUND_OPTIONS,
  ROUND_OVER_MS,
  ROUND_WINS_TO_TAKE_MATCH,
  SHOT_COOLDOWN_MS,
  SHOT_DAMAGE,
  SHOT_RADIUS,
  SHOT_SPEED,
  SPAWN_IFRAME_MS,
  SPAWN_POINTS,
  TICK_RATE,
  TOTAL_ROUNDS,
  WEAPON_HOLD_MS,
  WEAPON_HOVER,
  WEAPON_MIN_SURFACE_WIDTH,
  WEAPON_PICKUP_RADIUS,
  WEAPON_SPAWN_MAX_MS,
  WEAPON_SPAWN_MIN_MS,
  attackHitbox,
  bodyAabb,
  getMap,
  isHatId,
  isHexColor,
  isLobbyColorId,
  isMapId,
  LOBBY_COLORS,
  lobbyColorHex,
  lobbyColorIdFromHex,
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
   * Server tick the next map weapon appears on, or 0 when nothing is scheduled
   * — which is the case while a weapon is already on the map or being held. The
   * timer only starts once the current weapon has been claimed, so there is
   * never more than one gun in the arena.
   */
  private nextWeaponTick = 0;

  /** Monotonic id handed to each projectile, so the renderer can key on it. */
  private nextProjectileId = 1;

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
     * Lobby identity colour. One colour belongs to one player: a request for a
     * colour someone else already holds is rejected outright (the client is
     * told, so it can flash "taken"). The room is single-threaded, so two
     * near-simultaneous requests for the same colour resolve in arrival order —
     * the first wins, the second bounces. Only settable while waiting.
     */
    this.onMessage("setColor", (client, message: { colorId?: string }) => {
      if (this.state.phase !== "lobby" && this.state.phase !== "matchOver") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const id = message?.colorId;
      if (!isLobbyColorId(id) || id === player.colorId) return;

      if (this.colorHolder(id, client.sessionId)) {
        client.send("colorRejected", { colorId: id });
        return;
      }

      player.colorId = id;
      player.color = lobbyColorHex(id);
    });

    // Test-only: force the next weapon to drop on the following tick, so the
    // weapons suite doesn't have to sit through a 30–60s spawn timer. Stripped
    // from production builds, exactly like the client's feel-test hook.
    if (process.env.NODE_ENV !== "production") {
      this.onMessage("__spawnWeapon", () => {
        if (this.state.phase === "playing" && !this.state.weaponActive) {
          this.nextWeaponTick = this.state.tick + 1;
        }
      });
    }

    this.setFixedTimestep((ctx) => {
      this.state.tick++;
      this.stepPlayers(ctx.dt);
      // Hits resolve after every body has moved, so a tick sees one consistent
      // world rather than positions half-updated in map order.
      this.resolveHits();
      // Weapons ride on top of the resolved world: pickups, the spawn timer and
      // every projectile's flight and hit.
      this.updateWeapons(ctx.dt);
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
    options?: { name?: string; color?: string; colorId?: string; hat?: string },
  ) {
    const slot = this.nextSlot++ % SPAWN_POINTS.length;
    // A match already in progress: sit this round out, join at the next one.
    const midMatch = this.state.phase !== "lobby";

    // Lobby identity colour: honour the player's remembered pick when it's a
    // real palette id and nobody else holds it, otherwise hand out the first
    // free colour. Falls back to "" only if all twelve are somehow taken.
    const wanted =
      (isLobbyColorId(options?.colorId) ? options!.colorId! : "") ||
      lobbyColorIdFromHex(options?.color);
    const colorId =
      wanted && !this.colorHolder(wanted) ? wanted : this.firstFreeColorId();

    const player = new Player({
      ...spawnBody(slot, this.map.spawns),
      name: (options?.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || `P${slot + 1}`,
      colorId,
      // The palette hex for the assigned identity; a raw wardrobe hex only wins
      // when there was no free palette colour at all.
      color: colorId
        ? lobbyColorHex(colorId)
        : isHexColor(options?.color)
          ? options!.color!.toLowerCase()
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

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.hitThisSwing.delete(client.sessionId);

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

  /** Is this fighter currently holding a weapon? */
  private isArmed(player: Player): boolean {
    return player.armedUntilTick > this.state.tick;
  }

  /**
   * The attack button. Armed fighters fire a shot; everyone else throws a
   * punch. One button, two behaviours — the weapon simply takes the press over
   * for as long as it lasts.
   */
  private tryAttack(sessionId: string, player: Player, pressed: boolean) {
    if (!pressed || player.frozen || player.stunned) return;

    if (this.isArmed(player)) {
      this.tryShoot(sessionId, player);
      return;
    }

    const readyAt = player.attackUntilTick + msToTicks(ATTACK_RECOVERY_MS);
    if (this.state.tick < readyAt) return;

    player.attackUntilTick = this.state.tick + msToTicks(ATTACK_SWING_MS);
    // A fresh swing may hit everyone again.
    this.hitThisSwing.set(sessionId, new Set());
  }

  /**
   * Fire one projectile straight ahead — in the direction the fighter faces,
   * which is "where they're looking" under this control scheme. Gated by the
   * shot cooldown. The short `attackUntilTick` stamp is only there so the
   * client plays the arm-raise and the shot cue; the punch hitbox that stamp
   * would normally arm is suppressed for armed fighters in `resolveHits`.
   */
  private tryShoot(sessionId: string, player: Player) {
    if (this.state.tick < player.shotReadyTick) return;
    player.shotReadyTick = this.state.tick + msToTicks(SHOT_COOLDOWN_MS);
    player.attackUntilTick = this.state.tick + msToTicks(ATTACK_SWING_MS);

    const dir = player.facing >= 0 ? 1 : -1;
    this.state.projectiles.push(
      new Projectile({
        id: this.nextProjectileId++,
        ownerId: sessionId,
        x: player.x + dir * (PLAYER_WIDTH * 0.5 + 6),
        y: player.y - PLAYER_HEIGHT * 0.55,
        vx: dir * SHOT_SPEED,
        vy: 0,
      }),
    );
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
    // Weapon ran out: back to fists. The next map weapon schedules itself once
    // `updateWeapons` sees nobody armed and nothing on the ground.
    if (player.armedUntilTick !== 0 && this.state.tick >= player.armedUntilTick) {
      player.armedUntilTick = 0;
      player.shotReadyTick = 0;
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
      // An armed fighter's `attackUntilTick` drives the shot animation, not a
      // punch — the fist has no reach while a weapon is in hand.
      if (this.isArmed(attacker)) continue;

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
    this.applyDamage(target, attacker.x, attacker.facing, HIT_DAMAGE);
  }

  /**
   * Take a hit from a point source: bump the damage, launch away from
   * `sourceX`, and apply hitstun. Shared by the punch and the weapon shot —
   * `sourceDir` only breaks the tie when the source and target share an x.
   */
  private applyDamage(
    target: Player,
    sourceX: number,
    sourceDir: number,
    damage: number,
  ) {
    target.damage = Math.min(MAX_DAMAGE, target.damage + damage);

    const away =
      target.x === sourceX ? Math.sign(sourceDir) || 1 : target.x < sourceX ? -1 : 1;

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
    // Whatever they were holding is gone the moment they die.
    player.armedUntilTick = 0;
    player.shotReadyTick = 0;

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
    // A weapon doesn't survive a death — you respawn with fists, and the arena's
    // next gun is scheduled the moment `updateWeapons` sees nobody holding one.
    player.armedUntilTick = 0;
    player.shotReadyTick = 0;
    // Damage is per-life: you come back fresh and hard to launch again.
    player.damage = 0;
    player.invulnUntilTick = this.state.tick + msToTicks(SPAWN_IFRAME_MS);
  }

  // ---------------------------------------------------------------- weapons

  /**
   * One tick of the weapon world: move every shot in flight, resolve the
   * pickup, and run the single-slot spawn timer. Only `playing` has weapons —
   * any other phase wipes the lot so nothing lingers into the countdown or the
   * round-over freeze.
   */
  private updateWeapons(dt: number) {
    if (this.state.phase !== "playing") {
      if (this.state.projectiles.length > 0) this.state.projectiles.splice(0);
      if (this.state.weaponActive) this.state.weaponActive = false;
      this.nextWeaponTick = 0;
      return;
    }

    this.stepProjectiles(dt);
    this.updateWeaponPickup();
  }

  /** True while any fighter is holding a weapon. */
  private someoneArmed(): boolean {
    for (const player of this.state.players.values()) {
      if (this.isArmed(player)) return true;
    }
    return false;
  }

  /**
   * The spawn timer and the walk-over pickup.
   *
   * The invariant: at most one weapon "in play" at a time — either lying on the
   * map (`weaponActive`) or held by a fighter (`someoneArmed`). The timer for
   * the next one only starts once both are false, which is what makes the drop
   * wait for the previous weapon to actually be used.
   */
  private updateWeaponPickup() {
    if (this.state.weaponActive) {
      for (const [, player] of this.state.players) {
        if (!this.canGrabWeapon(player)) continue;
        const dx = player.x - this.state.weaponX;
        const dy = player.y - PLAYER_HEIGHT * 0.5 - this.state.weaponY;
        if (dx * dx + dy * dy > WEAPON_PICKUP_RADIUS * WEAPON_PICKUP_RADIUS) continue;

        player.armedUntilTick = this.state.tick + msToTicks(WEAPON_HOLD_MS);
        player.shotReadyTick = this.state.tick;
        this.state.weaponActive = false;
        this.nextWeaponTick = 0; // rescheduled once this weapon is spent
        break;
      }
      return;
    }

    // A weapon is still being held — nothing to schedule yet.
    if (this.someoneArmed()) {
      this.nextWeaponTick = 0;
      return;
    }

    if (this.nextWeaponTick === 0) {
      this.nextWeaponTick = this.state.tick + this.randomWeaponDelayTicks();
      return;
    }

    if (this.state.tick >= this.nextWeaponTick) this.spawnWeapon();
  }

  /** A random spawn gap in [WEAPON_SPAWN_MIN_MS, WEAPON_SPAWN_MAX_MS], in ticks. */
  private randomWeaponDelayTicks(): number {
    const ms =
      WEAPON_SPAWN_MIN_MS + Math.random() * (WEAPON_SPAWN_MAX_MS - WEAPON_SPAWN_MIN_MS);
    return msToTicks(ms);
  }

  /** Can this fighter pick a weapon up right now? */
  private canGrabWeapon(player: Player): boolean {
    return (
      !player.spectating &&
      !player.frozen &&
      player.lives > 0 &&
      player.deadUntilTick === 0 &&
      !this.isArmed(player)
    );
  }

  /** Drop a weapon onto a random wide-enough surface of the current map. */
  private spawnWeapon() {
    const surfaces = this.map.solids.filter(
      (s) => s.width >= WEAPON_MIN_SURFACE_WIDTH,
    );
    const pool = surfaces.length > 0 ? surfaces : this.map.solids;
    const surface = pool[Math.floor(Math.random() * pool.length)];
    if (!surface) return; // a map with no solids at all — nothing to stand a gun on

    const margin = 20;
    const span = Math.max(1, surface.width - margin * 2);
    this.state.weaponX = surface.x + margin + Math.random() * span;
    this.state.weaponY = surface.y - WEAPON_HOVER;
    this.state.weaponActive = true;
    this.nextWeaponTick = 0;
  }

  /** Advance every shot, and drop the ones that leave the world, hit a wall, or connect. */
  private stepProjectiles(dt: number) {
    const map = this.map;
    for (let i = this.state.projectiles.length - 1; i >= 0; i--) {
      const shot = this.state.projectiles[i]!;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;

      if (
        this.shotOutOfBounds(shot, map.killPlaneY) ||
        this.shotHitsSolid(shot) ||
        this.shotHitsFighter(shot)
      ) {
        this.state.projectiles.splice(i, 1);
      }
    }
  }

  private shotOutOfBounds(shot: Projectile, killPlaneY: number): boolean {
    return (
      shot.x < -40 ||
      shot.x > ARENA_WIDTH + 40 ||
      shot.y < -40 ||
      shot.y > killPlaneY
    );
  }

  /** A shot stops at any real wall; it passes straight through one-way beams. */
  private shotHitsSolid(shot: Projectile): boolean {
    for (const solid of this.map.solids) {
      if (solid.oneWay) continue;
      if (
        shot.x >= solid.x - SHOT_RADIUS &&
        shot.x <= solid.x + solid.width + SHOT_RADIUS &&
        shot.y >= solid.y - SHOT_RADIUS &&
        shot.y <= solid.y + solid.height + SHOT_RADIUS
      ) {
        return true;
      }
    }
    return false;
  }

  /** First hittable fighter (never the owner) whose body the shot is inside. */
  private shotHitsFighter(shot: Projectile): boolean {
    for (const [sessionId, target] of this.state.players) {
      if (sessionId === shot.ownerId) continue;
      if (!this.isHittable(target)) continue;

      const box = bodyAabb(target);
      if (
        shot.x >= box.x - SHOT_RADIUS &&
        shot.x <= box.x + box.width + SHOT_RADIUS &&
        shot.y >= box.y - SHOT_RADIUS &&
        shot.y <= box.y + box.height + SHOT_RADIUS
      ) {
        // Knockback follows the bullet, not "away from the impact point": a fast
        // shot can register on a tick where it has already crossed the target's
        // centre, and launching away from *that* would fire the victim backward.
        const dir = Math.sign(shot.vx) || 1;
        this.applyDamage(target, target.x - dir * 1000, dir, SHOT_DAMAGE);
        return true;
      }
    }
    return false;
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
      player.armedUntilTick = 0;
      player.shotReadyTick = 0;
      player.damage = 0;
      player.ready = false; // next lobby / "play again" needs fresh readies
      respawnBody(player, player.slot, this.map.spawns);
      player.frozen = true; // held at spawn while "3 · 2 · 1" runs
    }

    // Fresh round, fresh arena: no gun on the ground, none in flight, and the
    // spawn timer restarts from zero (scheduled by `updateWeapons` on tick one
    // of `playing`).
    this.state.weaponActive = false;
    this.state.projectiles.splice(0);
    this.nextWeaponTick = 0;

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

  /**
   * Session id of the player currently holding `colorId`, or undefined if it's
   * free. `exceptSessionId` lets a player "hold" their own colour without it
   * reading as taken.
   */
  private colorHolder(colorId: string, exceptSessionId?: string): string | undefined {
    for (const [sessionId, player] of this.state.players) {
      if (sessionId === exceptSessionId) continue;
      if (player.colorId === colorId) return sessionId;
    }
    return undefined;
  }

  /** The first palette colour nobody in the room holds, or "" if all are taken. */
  private firstFreeColorId(): string {
    for (const color of LOBBY_COLORS) {
      if (!this.colorHolder(color.id)) return color.id;
    }
    return "";
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
