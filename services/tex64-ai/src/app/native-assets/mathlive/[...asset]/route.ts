import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

const mathLiveDirectories = (): string[] => {
  const appResources = process.env.TEX64_APP_RESOURCES_DIR;
  return [
    ...(appResources
      ? [path.join(appResources, "app.asar", "Resources", "web", "mathlive")]
      : []),
    path.resolve(process.cwd(), "../../Resources/web/mathlive"),
    path.resolve(process.cwd(), "Resources/web/mathlive"),
  ];
};

const safeAssetPath = (parts: readonly string[]): string | null => {
  if (
    parts.length === 1 &&
    (parts[0] === "mathlive.min.js" || parts[0] === "mathlive-static.css")
  ) {
    return parts[0];
  }
  if (
    parts.length === 2 &&
    parts[0] === "fonts" &&
    /^KaTeX_[A-Za-z0-9-]+\.woff2$/u.test(parts[1] ?? "")
  ) {
    return path.join(parts[0], parts[1] ?? "");
  }
  return null;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ asset: string[] }> },
) {
  const { asset } = await context.params;
  const relative = safeAssetPath(asset);
  if (!relative) return NextResponse.json({ error: "Not found" }, { status: 404 });
  for (const directory of mathLiveDirectories()) {
    try {
      const contents = await readFile(path.join(directory, relative));
      return new NextResponse(contents, {
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Type": CONTENT_TYPES[path.extname(relative)] ?? "application/octet-stream",
        },
      });
    } catch {
      // Try the next development/packaged location.
    }
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
