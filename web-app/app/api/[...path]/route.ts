import { handleApi } from "../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const handler = (request: Request) =>
  handleApi(
    request,
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown",
  );
export {
  handler as GET,
  handler as HEAD,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as PATCH,
};
