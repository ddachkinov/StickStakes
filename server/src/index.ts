import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { ROOM_NAME, TICK_RATE } from "@stickstakes/shared";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

const PORT = Number(process.env.PORT ?? 2567);

/**
 * Where the built client lives, relative to this file at `server/dist/index.js`.
 * Overridable so a container can lay the files out however it likes.
 */
const CLIENT_DIST = process.env.CLIENT_DIST
  ? resolve(process.env.CLIENT_DIST)
  : fileURLToPath(new URL("../../client/dist", import.meta.url));

/**
 * In production this one process is the whole game: the built client at `/`
 * and Colyseus's matchmaking + WebSocket on the same origin, so a phone only
 * ever learns one hostname. In dev there is no build, Vite serves the client
 * and proxies `/colyseus` here instead — so we simply skip all of this.
 */
const serveClient = existsSync(join(CLIENT_DIST, "index.html"));

const gameServer = new Server({
  transport: new WebSocketTransport(),
  // Colyseus checks its own matchmaking router first and falls through to this
  // express app, so anything registered here is the fallback — which is exactly
  // what a static client wants to be.
  express: (app) => {
    app.get("/health", (_req, res) => {
      res.json({ ok: true, room: ROOM_NAME, tickRate: TICK_RATE, servingClient: serveClient });
    });

    if (!serveClient) return;

    const indexHtml = join(CLIENT_DIST, "index.html");

    /**
     * Vite fingerprints everything under `/assets`, so those may be cached
     * hard and forever. Everything else — the HTML shell, the manifest, and
     * above all the service worker — must revalidate, or a stale worker
     * outlives the deploy that was meant to replace it.
     */
    app.use(
      express.static(CLIENT_DIST, {
        index: false,
        setHeaders: (res, path) => {
          const immutable = path.includes(`${sep}assets${sep}`);
          res.setHeader(
            "Cache-Control",
            immutable ? "public, max-age=31536000, immutable" : "no-cache",
          );
        },
      }),
    );

    const sendShell = (_req: express.Request, res: express.Response) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(indexHtml);
    };

    // An explicit root route also tells Colyseus not to claim `/` for its
    // own version banner.
    app.get("/", sendShell);

    // Single-page fallback: `/?code=ABCD` and any deep link land on the shell.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      sendShell(req, res);
    });
  },
});

gameServer.define(ROOM_NAME, ArenaRoom);

await gameServer.listen(PORT);
console.log(
  `[server] listening on http://localhost:${PORT}` +
    (serveClient ? ` (serving client from ${CLIENT_DIST})` : " (api only — run Vite for the client)"),
);
