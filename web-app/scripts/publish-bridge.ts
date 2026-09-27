import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { PhotoStorage } from "../server/photos";
const root = resolve(import.meta.dir, "../..");
const apk = resolve(
  process.argv[2] ||
    join(root, "android-connector/app/build/outputs/apk/debug/app-debug.apk"),
);
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(homedir(), "Library/Android/sdk");
const versions = (await readdir(join(sdk, "build-tools")))
  .filter((v) => /^\d[\d.]*$/.test(v))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
if (!versions.length)
  throw new Error("Android SDK build-tools are required to verify the APK");
async function command(tool: string, args: string[]) {
  const p = Bun.spawn([join(sdk, "build-tools", versions[0]!, tool), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw new Error(`${tool} verification failed: ${err}`);
  return out;
}
const metadata = await command("aapt2", ["dump", "badging", apk]);
const pkg = metadata.match(
  /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/,
);
if (!pkg || pkg[1] !== "com.focus.connector" || !/^\d+(\.\d+)+$/.test(pkg[3]!))
  throw new Error("Invalid Focus Bridge package");
const signature = await command("apksigner", ["verify", "--print-certs", apk]);
const signerSha256 = signature
  .match(/certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1]
  ?.toLowerCase();
if (!signerSha256) throw new Error("APK signature could not be verified");
const manifestPath = join(root, "web-app/server/bridge-release.json");
const previous = JSON.parse(await readFile(manifestPath, "utf8"));
const versionCode = Number(pkg[2]),
  version = pkg[3]!;
if (previous.signerSha256 && previous.signerSha256 !== signerSha256)
  throw new Error(
    "Signing certificate changed. Existing installations could not update",
  );
if (versionCode < previous.versionCode)
  throw new Error("Cannot publish an older version");
const bytes = await readFile(apk),
  sha256 = createHash("sha256").update(bytes).digest("hex");
if (
  previous.sha256 &&
  previous.versionCode === versionCode &&
  previous.sha256 !== sha256
)
  throw new Error("Increase versionCode before publishing changed APK bytes");
const key = `releases/focus-bridge/v${version}/${sha256}.apk`,
  storage = new PhotoStorage();
await storage.put(key, bytes, "application/vnd.android.package-archive");
const stored = await storage.read(key, 150 * 1024 * 1024);
if (createHash("sha256").update(stored).digest("hex") !== sha256)
  throw new Error("Uploaded APK checksum mismatch");
await writeFile(
  manifestPath + ".tmp",
  JSON.stringify(
    { version, versionCode, key, sha256, size: bytes.length, signerSha256 },
    null,
    2,
  ) + "\n",
);
await rename(manifestPath + ".tmp", manifestPath);
console.log(
  `Published Focus Bridge ${version}: ${bytes.length} bytes, SHA-256 ${sha256}`,
);
console.log(
  "Include server/bridge-release.json in the next deployment. Prior APK versions remain in R2.",
);
