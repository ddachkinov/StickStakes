import { Client, type Room } from "@colyseus/sdk";
import { ArenaState, ROOM_NAME } from "@stickstakes/shared";

/**
 * One URL to share, one origin to reach. In dev, Vite proxies `/colyseus`
 * to the Colyseus process; in production the same prefix is served by the
 * same host. That is what makes a Cloudflare quick-tunnel link work as-is:
 * the phone only ever learns about one hostname, over HTTPS/WSS.
 */
export function createClient(): Client {
  return new Client({
    hostname: location.hostname,
    secure: location.protocol === "https:",
    port: location.port ? Number(location.port) : undefined,
    pathname: "/colyseus",
  });
}

export type ArenaRoom = Room<unknown, ArenaState>;

/** Start a new game. The server assigns the room a 4-letter code as its id. */
export async function createArena(name: string): Promise<ArenaRoom> {
  return createClient().create<ArenaState>(ROOM_NAME, { name }, ArenaState);
}

/** Join an existing game by its code. */
export async function joinArenaByCode(code: string, name: string): Promise<ArenaRoom> {
  return createClient().joinById<ArenaState>(code, { name }, ArenaState);
}

/**
 * Turn a join failure into something worth reading on a phone. Colyseus
 * reports both "no such room" and "already full" through the same error type,
 * so match on the message rather than inventing a code of our own.
 */
export function describeJoinError(error: unknown, code: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return `No game called ${code}. Check the code?`;
  if (/locked|full/i.test(message)) return `Game ${code} is full.`;
  return `Couldn't join ${code}. ${message}`;
}
