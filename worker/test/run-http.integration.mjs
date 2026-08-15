import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerEntry = path.join(workerDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
const workerUrl = "http://127.0.0.1:8787";

const wrangler = spawn(process.execPath, [wranglerEntry, "dev", "--env", "local"], {
  cwd: workerDirectory,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let wranglerOutput = "";
wrangler.stdout.on("data", chunk => { wranglerOutput += chunk; });
wrangler.stderr.on("data", chunk => { wranglerOutput += chunk; });

async function waitForWorker() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null) throw new Error(`Wrangler stopped before startup.\n${wranglerOutput}`);
    try {
      const response = await fetch(`${workerUrl}/createPoll`, {
        method: "OPTIONS",
        headers: { Origin: "http://127.0.0.1:5000" }
      });
      if (response.status === 204) return;
    } catch {
      // The local runtime is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for the local Worker.\n${wranglerOutput}`);
}

async function stopWorker() {
  if (wrangler.exitCode !== null) return;

  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    await once(taskkill, "exit");
  } else {
    wrangler.kill("SIGTERM");
  }
}

try {
  await waitForWorker();
  process.env.EASYVOTE_WORKER_URL = workerUrl;
  await import("./security.integration.mjs");
  console.log("Cloudflare Worker HTTP runtime tests passed.");
} finally {
  await stopWorker();
}
