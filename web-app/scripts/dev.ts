import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT || 4310),
  uiPort = Number(process.env.NEXT_PORT || port + 1);
const env = {
  ...process.env,
  PORT: String(port),
  FOCUS_API_PORT: String(port),
  HOST: "127.0.0.1",
  DEV_UI_ORIGIN: `http://127.0.0.1:${uiPort}`,
  FRONTEND_URL: `http://127.0.0.1:${uiPort}`,
};
const ui = Bun.spawn(
  [
    "node",
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(uiPort),
  ],
  { cwd: root, env, stdout: "inherit", stderr: "inherit" },
);
const api = Bun.spawn(
  [
    "bun",
    "--watch",
    process.argv.includes("--sample")
      ? "server/sample-start.ts"
      : "server/index.ts",
  ],
  { cwd: root, env, stdout: "inherit", stderr: "inherit" },
);
console.log(`Development UI: http://127.0.0.1:${uiPort}`);
const stop = () => {
  ui.kill();
  api.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const code = await Promise.race([ui.exited, api.exited]);
stop();
await Promise.all([ui.exited, api.exited]);
process.exit(code || 0);
