const normalizePosixPath = (value: string) => {
  const parts = value.split("/").filter(Boolean);
  const stack = [];
  for (const part of parts) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
};

const containingDirectory = (file: string) => file.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

const resolveCandidates = (activeFile: string, input: string, files: string[], extensions: string[], rootFile: string | null) => {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) return [];
  const base = raw.replace(/^\/+/, "");
  // Ordinary LaTeX inclusions are read from the build directory. Keep
  // source-relative matches as well for imports that change the search path.
  const directories = raw.startsWith("/") ? [""] : ["", containingDirectory(rootFile || ""), containingDirectory(activeFile)];
  const paths = new Set(files.map((file) => file.replace(/\\/g, "/")));
  const matches: string[] = [];
  for (const directory of new Set(directories)) {
    const resolved = normalizePosixPath(directory ? `${directory}/${base}` : base);
    const candidates = resolved.split("/").pop()?.includes(".") ? [resolved] : [resolved, ...extensions.map(ext => `${resolved}.${ext}`)];
    for (const candidate of candidates) {
      if (paths.has(candidate) && !matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
};

export const resolveGraphicsCandidates = (activeFile: string, input: string, files: string[], rootFile: string | null = null) =>
  resolveCandidates(activeFile, input, files, ["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"], rootFile);

export const resolveTexIncludeCandidates = (activeFile: string, input: string, files: string[], rootFile: string | null = null) =>
  resolveCandidates(activeFile, input, files, ["tex"], rootFile);

export const isPreviewableImagePath = (pathValue: string) => {
  const ext = (pathValue.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico"].includes(ext);
};

export const isPdfPath = (pathValue: string) =>
  ((pathValue.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "") === "pdf";

