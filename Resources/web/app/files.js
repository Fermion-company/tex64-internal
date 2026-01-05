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
export const IMAGE_MIME_TYPES = new Map([
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
export const getFileExtension = (value) => {
    var _a;
    const name = (_a = value.split("/").pop()) !== null && _a !== void 0 ? _a : value;
    const index = name.lastIndexOf(".");
    if (index === -1 || index === name.length - 1) {
        return "";
    }
    return name.slice(index + 1).toLowerCase();
};
export const isTextFilePath = (path) => TEXT_FILE_EXTENSIONS.has(getFileExtension(path));
export const isImageFilePath = (path) => IMAGE_FILE_EXTENSIONS.has(getFileExtension(path));
export const isPdfFilePath = (path) => getFileExtension(path) === "pdf";
