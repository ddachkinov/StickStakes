import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME, TICK_RATE } from "@stickstakes/shared";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

const PORT = Number(process.env.PORT ?? 2567);

const gameServer = new Server({
  transport: new WebSocketTransport(),
  // Colyseus owns the HTTP app and mounts its matchmaking routes; we only add ours.
  express: (app) => {
    app.get("/health", (_req, res) => {
      res.json({ ok: true, room: ROOM_NAME, tickRate: TICK_RATE });
    });
  },
});

gameServer.define(ROOM_NAME, ArenaRoom);

await gameServer.listen(PORT);
console.log(`[server] listening on http://localhost:${PORT}`);
