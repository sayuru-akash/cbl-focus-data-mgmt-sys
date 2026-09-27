import { test, expect } from "bun:test";
import { bridgeDownload } from "./bridge-download";
import release from "./bridge-release.json";
const url = "https://cbf.amsonline.lk/api/downloads/focus-bridge.apk";
test("both rewritten and original installer URLs bypass workspace initialization", async () => {
  const { handleApi } = await import("./api");
  for (const path of [
    "/downloads/focus-bridge.apk",
    "/api/downloads/focus-bridge.apk",
  ]) {
    const response = await handleApi(
      new Request(`https://cbf.amsonline.lk${path}`, { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Focus-SHA256")).toBe(release.sha256);
  }
});
test("public installer points only to the retained release and refreshes its signed URL", async () => {
  let calls = 0;
  const storage = () => ({
    downloadUrl: async (key: string, options: any) => {
      calls++;
      expect(key).toBe(release.key);
      expect(key.startsWith("releases/focus-bridge/")).toBe(true);
      expect(options.filename).toBe(`focus-bridge-${release.version}.apk`);
      expect(options.expiresIn).toBe(3600);
      return `https://storage.example/verified.apk?signature=${calls}`;
    },
  });
  const first = await bridgeDownload(new Request(url), storage),
    second = await bridgeDownload(new Request(url), storage);
  expect(first.status).toBe(307);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  expect(first.headers.get("Location")).not.toBe(
    second.headers.get("Location"),
  );
  expect(first.headers.get("X-Focus-SHA256")).toBe(release.sha256);
});
test("HEAD advertises the APK without following a GET-only storage signature", async () => {
  const result = await bridgeDownload(
    new Request(url, { method: "HEAD" }),
    () => {
      throw new Error("Must not sign a GET URL for HEAD");
    },
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("Content-Length")).toBe(String(release.size));
  expect(result.headers.get("Content-Type")).toBe(
    "application/vnd.android.package-archive",
  );
  expect(await result.text()).toBe("");
});
test("installer rejects mutations and does not leak storage errors", async () => {
  const fail = () => {
    throw new Error("private credential detail");
  };
  expect(
    (await bridgeDownload(new Request(url, { method: "POST" }), fail)).status,
  ).toBe(405);
  const result = await bridgeDownload(new Request(url), fail);
  expect(result.status).toBe(503);
  expect(result.headers.get("Retry-After")).toBe("60");
  expect(await result.text()).not.toContain("credential");
});

test("photo cleanup cannot delete retained installers", async () => {
  const { PhotoStorage } = await import("./photos");
  const storage = Object.create(PhotoStorage.prototype) as InstanceType<
    typeof PhotoStorage
  >;
  await expect(storage.delete([release.key])).rejects.toThrow(
    "Release assets cannot be removed",
  );
});
