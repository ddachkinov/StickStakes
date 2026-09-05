/**
 * pm2 process config for the VPS.
 *
 * `exec_mode: "fork"` with a single instance is NOT a performance oversight —
 * it is a correctness requirement. Colyseus keeps rooms in the process's own
 * memory (LocalPresence + LocalDriver), so under cluster mode a room created
 * by one worker is invisible to the others and roughly half of all join-by-code
 * attempts would fail with "not found". Scaling past one process means adding
 * @colyseus/redis-presence and @colyseus/redis-driver first.
 */
module.exports = {
  apps: [
    {
      name: "stickstakes",
      // The compiled server. It resolves the client build relative to its own
      // file, so pm2's working directory does not matter.
      script: "server/dist/index.js",
      cwd: "/srv/stickstakes",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: "2567",
      },
      // A game server should come back if it dies, but not spin forever.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      time: true,
    },
  ],
};
