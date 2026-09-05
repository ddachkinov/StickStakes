import { defineConfig } from "vite";

/**
 * The client always talks to the Colyseus server through a same-origin `/colyseus`
 * prefix, which Vite proxies in dev. That keeps one URL to share with a phone
 * (or a Cloudflare tunnel) instead of two, and means no CORS and no mixed
 * content when the page is served over HTTPS.
 */
export default defineConfig({
  server: {
    host: true, // listen on 0.0.0.0 so a phone on the same wifi (or a tunnel) can reach it
    port: 5173,
    strictPort: true,
    proxy: {
      "/colyseus": {
        target: "http://localhost:2567",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/colyseus/, ""),
      },
    },
    // A quick tunnel hands out a random *.trycloudflare.com host each run.
    allowedHosts: [".trycloudflare.com", ".ngrok-free.app", ".loca.lt"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
