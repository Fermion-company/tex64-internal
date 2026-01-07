export const TEXT_FILE_EXTENSIONS = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "bst",
  "bbx",
  "cbx",
  "cfg",
  "def",
  "lbx",
  "ins",
  "dtx",
  "ltx",
  "txt",
  "aux",
  "bbl",
  "blg",
  "log",
  "out",
  "toc",
  "lof",
  "lot",
  "fdb_latexmk",
  "fls",
]);

export const LATEX_FILE_EXTENSIONS = new Set([
  "tex",
  "sty",
  "cls",
  "ltx",
  "dtx",
  "ins",
  "bbx",
  "cbx",
  "cfg",
  "def",
  "lbx",
  "bst",
]);

export const PINNED_TAB_EXTENSIONS = new Set([
  ...LATEX_FILE_EXTENSIONS,
  "bib",
  "pdf",
]);

export const IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "svg",
  "tif",
  "tiff",
  "ico",
]);

export const IMAGE_MIME_TYPES = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["bmp", "image/bmp"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["ico", "image/x-icon"],
]);

export const getFileExtension = (value: string) => {
  const name = value.split("/").pop() ?? value;
  const index = name.lastIndexOf(".");
  if (index === -1 || index === name.length - 1) {
    return "";
  }
  return name.slice(index + 1).toLowerCase();
};

export const isTextFilePath = (path: string) =>
  TEXT_FILE_EXTENSIONS.has(getFileExtension(path));
export const isImageFilePath = (path: string) =>
  IMAGE_FILE_EXTENSIONS.has(getFileExtension(path));
export const isPdfFilePath = (path: string) => getFileExtension(path) === "pdf";
