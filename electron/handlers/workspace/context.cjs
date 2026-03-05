const createWorkspaceContext = (deps) => {
  const {
    dialog,
    shell,
    spawn,
    fs,
    fsp,
    path,
    workspace,
    indexerService,
    formatterService,
    searchService,
    sendToRenderer,
    sendIssues,
    WorkspaceError,
    state,
    userSettings,
  } = deps;

  const TEXT_FILE_EXTENSIONS = new Set([
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
  const IMAGE_FILE_EXTENSIONS = new Set([
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
  const IMAGE_MIME_TYPES = new Map([
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

  const getFileExtension = (relativePath) => {
    const name = typeof relativePath === "string" ? path.basename(relativePath) : "";
    const ext = path.extname(name).toLowerCase();
    return ext.startsWith(".") ? ext.slice(1) : ext;
  };

  const isTextFilePath = (relativePath) => TEXT_FILE_EXTENSIONS.has(getFileExtension(relativePath));
  const isImageFilePath = (relativePath) => IMAGE_FILE_EXTENSIONS.has(getFileExtension(relativePath));
  const isPdfFilePath = (relativePath) => getFileExtension(relativePath) === "pdf";

  const sendWorkspace = async (rootPath) => {
    let files = [];
    let folders = [];
    let errorMessage = null;
    try {
      files = await workspace.listFiles();
    } catch (error) {
      errorMessage = error.message;
    }
    try {
      folders = await workspace.listFolders();
    } catch (error) {
      if (!errorMessage) {
        errorMessage = error.message;
      }
    }
    let rootFile = "";
    let rootSource = "";
    let buildProfiles = [];
    let buildProfileId = "";
    try {
      const info = await workspace.rootInfo();
      if (info?.path) {
        rootFile = info.path;
        rootSource = info.source;
      }
      const settings = await workspace.loadSettings().catch(() => null);
      if (Array.isArray(settings?.buildProfiles)) {
        buildProfiles = settings.buildProfiles;
      }
      if (typeof settings?.buildProfileId === "string") {
        buildProfileId = settings.buildProfileId;
      }
    } catch (error) {
      if (!errorMessage) {
        errorMessage = error.message;
      }
    }
    sendToRenderer("updateWorkspace", {
      rootName: path.basename(rootPath),
      rootPath,
      files,
      folders,
      rootFile,
      rootSource,
      buildProfiles,
      buildProfileId,
    });
    if (errorMessage) {
      sendIssues(1, errorMessage, "error", [
        { severity: "error", message: errorMessage },
      ]);
    }
  };

  const updateWorkspaceIfNeeded = async (rootPath, force = false) => {
    if (!force && state.currentWorkspacePath === rootPath) {
      return;
    }
    state.currentWorkspacePath = rootPath;
    await sendWorkspace(rootPath);
  };

  const requestIndex = (rootPath) => {
    indexerService.requestIndex(rootPath, (snapshot) => {
      if (state.currentWorkspacePath !== rootPath) {
        return;
      }
      sendToRenderer("updateIndex", snapshot);
    });
  };

  const sendLauncherStatus = (payload) => {
    sendToRenderer("launcherStatus", payload);
  };

  const ensureWorkspace = () => workspace.getRootPath();

  const resolveWorkspacePath = (relativePath) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = path.resolve(rootPath, relativePath);
    const rootResolved = path.resolve(rootPath);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(WorkspaceError.invalidPath);
    }
    return resolved;
  };

  const openInTerminal = (targetPath) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      throw new Error(WorkspaceError.invalidPath);
    }
    const resolved = resolveWorkspacePath(targetPath);
    let dirPath = resolved;
    if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
      dirPath = path.dirname(resolved);
    }
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", dirPath]);
      return;
    }
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${dirPath}"`], {
        windowsHide: true,
      });
      return;
    }
    spawn("x-terminal-emulator", [], { cwd: dirPath });
  };

  const revealInFinder = (targetPath) => {
    const resolved = resolveWorkspacePath(targetPath);
    shell.showItemInFolder(resolved);
  };

  return {
    dialog,
    shell,
    spawn,
    fs,
    fsp,
    path,
    workspace,
    indexerService,
    formatterService,
    searchService,
    sendToRenderer,
    sendIssues,
    WorkspaceError,
    state,
    userSettings,

    TEXT_FILE_EXTENSIONS,
    IMAGE_FILE_EXTENSIONS,
    IMAGE_MIME_TYPES,
    getFileExtension,
    isTextFilePath,
    isImageFilePath,
    isPdfFilePath,

    sendWorkspace,
    updateWorkspaceIfNeeded,
    requestIndex,
    sendLauncherStatus,
    ensureWorkspace,
    resolveWorkspacePath,
    openInTerminal,
    revealInFinder,
  };
};

module.exports = { createWorkspaceContext };
