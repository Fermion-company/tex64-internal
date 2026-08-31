import { jsonError } from "@/server/http/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Workspace bytes are available only through the Electron host bridge. An
 * HTTP caller-selected root can never prove that it is the workspace the host
 * opened, even when the page has a native launch token. Keep this tombstone so
 * stale clients fail closed instead of recovering the old filesystem reader.
 */
export async function GET() {
  return jsonError(
    "このファイル取得経路は廃止されました。",
    410,
    "workspace_file_route_removed",
  );
}
