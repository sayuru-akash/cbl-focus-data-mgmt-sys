import { resolve } from "node:path";
import { existsSync } from "node:fs";
const root = resolve(import.meta.dir, "..");
const sample = process.argv.includes("--sample");
const publicPort = Number(process.env.PORT || 4310),
  nextPort = Number(process.env.NEXT_PORT || publicPort + 1);
if (!existsSync(resolve(root, ".next/BUILD_ID")))
  throw new Error("Run bun run build first");
const env = {
  ...process.env,
  PORT: String(publicPort),
  FOCUS_API_PORT: String(publicPort),
  FRONTEND_URL: `http://127.0.0.1:${nextPort}`,
};
const next = Bun.spawn(
  [
    "node",
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(nextPort),
  ],
  { cwd: root, env, stdout: "inherit", stderr: "inherit" },
);
const api = Bun.spawn(
  ["bun", sample ? "server/sample-start.ts" : "server/index.ts"],
  { cwd: root, env, stdout: "inherit", stderr: "inherit" },
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  next.kill();
  api.kill();
}
process.on("SIGINT", () => {
  stop();
});
process.on("SIGTERM", () => {
  stop();
});
const code = await Promise.race([next.exited, api.exited]);
stop();
await Promise.all([next.exited, api.exited]);
process.exit(code || 0);
