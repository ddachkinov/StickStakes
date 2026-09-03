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

export async function joinArena(name: string): Promise<ArenaRoom> {
  const client = createClient();
  return client.joinOrCreate<ArenaState>(ROOM_NAME, { name }, ArenaState);
}
