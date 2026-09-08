import { Client, type Room } from "@colyseus/sdk";
import { ArenaState, LEFT_MID_MATCH_MESSAGE, ROOM_NAME } from "@stickstakes/shared";

/**
 * One URL to share, one origin to reach — which is what makes a tunnel link
 * or a deployed URL work as-is: the phone only ever learns one hostname, over
 * HTTPS/WSS, and there is no CORS and no mixed content.
 *
 * The prefix differs by build because the origin's owner does. In dev Vite
 * owns `/` and proxies `/colyseus` to the Colyseus process. In production the
 * game server owns `/` outright — it serves the built client itself — so
 * matchmaking sits at the root and the prefix would be a 404.
 */
export function createClient(): Client {
  return new Client({
    hostname: location.hostname,
    secure: location.protocol === "https:",
    port: location.port ? Number(location.port) : undefined,
    pathname: import.meta.env.DEV ? "/colyseus" : "",
  });
}

export type ArenaRoom = Room<unknown, ArenaState>;

const TOKEN_KEY = "stickstakes:token";

/**
 * This browser's own id, made once and kept.
 *
 * The server needs *something* stable to recognise a player across a
 * reconnect: session ids are new every time, so without this, quitting a match
 * and rejoining is indistinguishable from a stranger arriving. It is not an
 * account and carries nothing about anyone — its only job is to hold a quitter
 * out of the match they walked away from. Storage that refuses to cooperate
 * (private mode, a locked-down browser) just means a fresh id per load, which
 * costs nothing but the lockout.
 */
export function clientToken(): string {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) return saved;
    const made = crypto.randomUUID();
    localStorage.setItem(TOKEN_KEY, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}

/** Cosmetic pick sent with the join; the server validates every field. */
export interface Wardrobe {
  color: string;
  hat: string;
}

/** Start a new game. The server assigns the room a 4-letter code as its id. */
export async function createArena(name: string, wardrobe?: Wardrobe): Promise<ArenaRoom> {
  return createClient().create<ArenaState>(
    ROOM_NAME,
    { name, token: clientToken(), ...wardrobe },
    ArenaState,
  );
}

/** Join an existing game by its code. */
export async function joinArenaByCode(
  code: string,
  name: string,
  wardrobe?: Wardrobe,
): Promise<ArenaRoom> {
  return createClient().joinById<ArenaState>(
    code,
    { name, token: clientToken(), ...wardrobe },
    ArenaState,
  );
}

/**
 * Turn a join failure into something worth reading on a phone. Colyseus
 * reports both "no such room" and "already full" through the same error type,
 * so match on the message rather than inventing a code of our own.
 */
export function describeJoinError(error: unknown, code: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // The server's own words for a mid-match rejoin — it explains the rule
  // better than "couldn't join" ever could, so pass it straight through.
  if (message.includes(LEFT_MID_MATCH_MESSAGE)) return LEFT_MID_MATCH_MESSAGE;
  if (/not found/i.test(message)) return `No game called ${code}. Check the code?`;
  if (/locked|full/i.test(message)) return `Game ${code} is full.`;
  return `Couldn't join ${code}. ${message}`;
}
