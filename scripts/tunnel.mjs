#!/usr/bin/env node
/**
 * Publishes the local Vite dev server through a Cloudflare quick tunnel and
 * prints a QR code for it.
 *
 * Why not just a LAN IP: the tunnel gives you HTTPS, which the fullscreen API,
 * vibration, screen-wake-lock and PWA install all require — and it works from
 * cellular data, which matters when you are testing in an actual restaurant.
 *
 * Quick tunnels are anonymous and get a fresh random hostname on every run,
 * so the QR is regenerated each session. Once you are testing with real people,
 * deploy and use a stable URL instead.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const PORT = Number(process.env.CLIENT_PORT ?? 5173);
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let printed = false;

const tunnel = spawn(
  "npx",
  ["--yes", "cloudflared", "tunnel", "--url", `http://localhost:${PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] },
);

async function announce(url) {
  if (printed) return;
  printed = true;

  let qr = null;
  try {
    ({ default: qr } = await import("qrcode-terminal"));
  } catch {
    // qrcode-terminal is optional; the URL alone is still usable.
  }

  const line = "─".repeat(url.length + 4);
  console.log(`\n┌${line}┐\n│  ${url}  │\n└${line}┘\n`);
  if (qr) qr.generate(url, { small: true });
  console.log("\nScan it, or open the URL on any phone. Ctrl-C to stop.\n");
}

function scan(chunk) {
  const text = chunk.toString();
  process.stderr.write(text);
  const match = text.match(URL_PATTERN);
  if (match) void announce(match[0]);
}

tunnel.stdout.on("data", scan);
tunnel.stderr.on("data", scan);

tunnel.on("exit", (code) => {
  if (!printed) {
    console.error(
      "\ncloudflared exited before publishing a URL." +
        "\nCheck that outbound HTTPS is allowed, then retry.\n",
    );
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    tunnel.kill(signal);
  });
}
