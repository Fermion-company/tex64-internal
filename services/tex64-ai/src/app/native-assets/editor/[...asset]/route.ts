import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

// Serve the compiled, shared WYSIWYG modules, never source or arbitrary files.
const helpers = new Set([
  "app/blocks/input-ui/mathfield-matrix-ops.js",
  "app/blocks/input-ui-math-field.js",
  "app/blocks/input-ui-latex-format.js",
  "app/blocks/math-input-utils.js",
  "app/math-keyboard-data.js",
  "math/mathfield-private-adapter.js",
]);

export async function GET(_request: Request, context: { params: Promise<{ asset: string[] }> }) {
  const { asset } = await context.params;
  if (!asset.every((part) => /^[a-zA-Z0-9_-]+(?:\.js)?$/u.test(part)))
    return new NextResponse(null, { status: 404 });
  const relative = asset.join("/");
  if (!helpers.has(relative) && !/^math\/wysiwyg\/[\w/-]+\.js$/u.test(relative))
    return new NextResponse(null, { status: 404 });
  const resources = process.env.TEX64_APP_RESOURCES_DIR;
  const directories = [
    ...(resources ? [path.join(resources, "app.asar.unpacked/Resources/web"), path.join(resources, "app.asar/Resources/web")] : []),
    path.resolve(process.cwd(), "../../Resources/web"),
    path.resolve(process.cwd(), "Resources/web"),
  ];
  for (const directory of directories) {
    try {
      return new NextResponse(await readFile(path.join(directory, relative)), {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
      });
    } catch { /* Try the packaged/development location. */ }
  }
  return new NextResponse(null, { status: 404 });
}
