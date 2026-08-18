import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { jsonError } from "@/server/http/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 64 * 1024 * 1024;
const SERVABLE = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

const QuerySchema = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
});

/**
 * Serves a file out of the workspace the desktop app has open.
 *
 * The page can be megabytes, and the desktop bridge is a message channel, not
 * a transport for that. This service runs on the same machine, so it reads the
 * file directly — confined to the root the host named, and only formats a
 * viewer displays.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = QuerySchema.parse({
      root: url.searchParams.get("root"),
      path: url.searchParams.get("path"),
    });

    const root = path.resolve(query.root);
    const target = path.resolve(root, query.path);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return jsonError("その場所は読み取れません。", 400, "outside_workspace");
    }
    if (!SERVABLE.has(path.extname(target).toLowerCase())) {
      return jsonError("この形式は表示できません。", 400, "unsupported_format");
    }

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      return jsonError("見つかりませんでした。", 404, "not_found");
    }
    if (info.size > MAX_BYTES) {
      return jsonError("ファイルが大きすぎます。", 413, "too_large");
    }

    const bytes = await readFile(target);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type":
          path.extname(target).toLowerCase() === ".pdf"
            ? "application/pdf"
            : "image/*",
        "Content-Length": String(info.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return jsonError("読み取れませんでした。", 400, "invalid_request");
  }
}
