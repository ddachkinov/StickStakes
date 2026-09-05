#!/usr/bin/env node
/**
 * `npm run deploy` — maintainer only.
 *
 * Pushes main and then runs /srv/stickstakes/deploy.sh on the production VPS.
 * It needs an SSH host alias `gp` that only the maintainer has, so for anyone
 * else this exists purely to fail with an explanation rather than a wall of
 * ssh output. Contributors deploy nothing: merged PRs go live when the
 * maintainer deploys.
 */
import { execFileSync, execSync } from "node:child_process";
import process from "node:process";

const SSH_ALIAS = "gp";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// Is the alias even configured? `ssh -G` resolves a host without connecting.
let resolved = "";
try {
  resolved = execFileSync("ssh", ["-G", SSH_ALIAS], { encoding: "utf8" });
} catch {
  fail(
    "Could not run ssh, so this cannot be the maintainer's machine.\n" +
      "`npm run deploy` is maintainer-only — see the Deploying section of CONTRIBUTING.md.",
  );
}

// An unknown alias resolves to itself as the hostname; a configured one does not.
const hostname = /^hostname (.+)$/m.exec(resolved)?.[1]?.trim();
if (!hostname || hostname === SSH_ALIAS) {
  fail(
    `No SSH host alias "${SSH_ALIAS}" is configured, so this is not the maintainer's machine.\n` +
      "`npm run deploy` is maintainer-only — see the Deploying section of CONTRIBUTING.md.\n" +
      "Merged pull requests reach play.groundpoint.net when the maintainer deploys.",
  );
}

const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
if (branch !== "main") {
  fail(
    `On branch "${branch}", but the VPS tracks main and deploy.sh runs \`git pull --ff-only\`.\n` +
      "Merge to main first — deploying from a side branch would be a no-op at best.",
  );
}

console.log(`Deploying main to ${hostname}...\n`);
execSync("git push", { stdio: "inherit" });
execFileSync("ssh", [SSH_ALIAS, "/srv/stickstakes/deploy.sh"], { stdio: "inherit" });
