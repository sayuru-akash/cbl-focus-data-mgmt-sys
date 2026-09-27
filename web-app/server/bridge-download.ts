import release from "./bridge-release.json";
import { PhotoStorage } from "./photos";

export async function bridgeDownload(
  request: Request,
  storage: () => Pick<PhotoStorage, "downloadUrl"> = () => new PhotoStorage(),
) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" },
    });
  }
  try {
    if (
      !/^releases\/focus-bridge\/v[\d.]+\/[a-f0-9]{64}\.apk$/.test(release.key)
    )
      throw new Error("No published release");
    if (request.method === "HEAD")
      return new Response(null, {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Disposition": `attachment; filename="focus-bridge-${release.version}.apk"`,
          "Content-Length": String(release.size),
          "X-Focus-Version": release.version,
          "X-Focus-SHA256": release.sha256,
        },
      });
    const url = await storage().downloadUrl(release.key, {
      filename: `focus-bridge-${release.version}.apk`,
      contentType: "application/vnd.android.package-archive",
      expiresIn: 3600,
    });
    return new Response(null, {
      status: 307,
      headers: {
        ...headers,
        Location: url,
        "X-Focus-Version": release.version,
        "X-Focus-SHA256": release.sha256,
      },
    });
  } catch {
    return new Response(
      request.method === "HEAD"
        ? null
        : "Download temporarily unavailable. Please try again shortly.",
      {
        status: 503,
        headers: {
          ...headers,
          "Retry-After": "60",
          "Content-Type": "text/plain; charset=utf-8",
        },
      },
    );
  }
}
