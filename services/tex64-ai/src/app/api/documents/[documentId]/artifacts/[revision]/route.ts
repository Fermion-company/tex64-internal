import { jsonError } from "@/server/http/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Revision-only URLs are cache aliases: the artifact for a revision can be
  // repaired before a later review. Only digest-addressed URLs are publishable.
  return jsonError("見つかりませんでした。", 404, "not_found");
}
