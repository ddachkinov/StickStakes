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
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const PORT = Number(process.env.CLIENT_PORT ?? 5173);
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const IS_WINDOWS = process.platform === "win32";

let printed = false;

/**
 * Prefer a `cloudflared` already on PATH (installed via winget / scoop / brew /
 * apt) — it starts instantly. Fall back to `npx cloudflared`, which downloads a
 * ~40MB binary on first run. `shell: true` is what lets Windows resolve the
 * `.cmd` shims for both; without it `spawn("npx")` throws ENOENT.
 */
function resolveTunnelCommand() {
  const probe = spawnSync("cloudflared", ["--version"], {
    stdio: "ignore",
    shell: IS_WINDOWS,
  });
  if (probe.status === 0) {
    return { command: "cloudflared", args: ["tunnel", "--url", `http://localhost:${PORT}`] };
  }
  console.error("cloudflared not on PATH — falling back to `npx cloudflared` (first run downloads it)…\n");
  return {
    command: "npx",
    args: ["--yes", "cloudflared", "tunnel", "--url", `http://localhost:${PORT}`],
  };
}

const { command, args } = resolveTunnelCommand();

const tunnel = spawn(command, args, {
  stdio: ["ignore", "pipe", "pipe"],
  shell: IS_WINDOWS,
});

tunnel.on("error", (err) => {
  console.error(
    `\nCould not start the tunnel (${err.code ?? err.message}).` +
      "\nInstall cloudflared and retry, or run `npm run dev` and use the LAN URL:" +
      "\n  winget install --id Cloudflare.cloudflared      (Windows)" +
      "\n  brew install cloudflared                        (macOS)\n",
  );
  // Stay alive and idle so a tunnel failure doesn't take the dev servers with it.
});

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

tunnel.stdout?.on("data", scan);
tunnel.stderr?.on("data", scan);

tunnel.on("exit", (code) => {
  if (!printed) {
    console.error(
      "\ncloudflared exited before publishing a URL." +
        "\nCheck that outbound HTTPS is allowed, then retry.\n",
    );
  }
  // Don't exit the process — under `concurrently` that would signal the whole
  // dev stack to shut down. The tunnel is optional; the local servers are not.
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    tunnel.kill(signal);
    process.exit(0);
  });
}
