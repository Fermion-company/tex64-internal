const {
  EXTENDED_TEXT_FILE_EXTENSIONS,
  EXTENDED_TEXT_FILE_NAMES,
  isExtendedTextFileName,
} = require("../../services/text-file-types.cjs");
const crypto = require("crypto");

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
    fileAccess = { ensureAccess: async () => true },
    beforeWorkspaceChange = async () => {},
    beginRendererWorkspaceMutation = () => () => {},
  } = deps;

  if (!Number.isSafeInteger(state.workspaceGeneration)) {
    state.workspaceGeneration = 0;
  }
  if (typeof state.workspaceId !== "string") {
    state.workspaceId = null;
  }

  const canonicalWorkspacePath = (rootPath) => {
    let resolved = path.resolve(rootPath);
    try {
      resolved =
        typeof fs.realpathSync?.native === "function"
          ? fs.realpathSync.native(resolved)
          : fs.realpathSync(resolved);
    } catch {
      // A just-created directory can briefly be unresolved; path.resolve is
      // still deterministic for this session.
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const workspaceIdForRoot = (rootPath) =>
    crypto
      .createHash("sha256")
      .update(canonicalWorkspacePath(rootPath), "utf8")
      .digest("hex")
      .slice(0, 24);

  const beginWorkspaceSession = (rootPath) => {
    state.workspaceGeneration += 1;
    state.workspaceId = workspaceIdForRoot(rootPath);
    state.currentWorkspacePath = null;
    return {
      workspaceGeneration: state.workspaceGeneration,
      workspaceId: state.workspaceId,
    };
  };

  const workspaceSessionIsCurrent = (rootPath, generation = state.workspaceGeneration) =>
    workspace.getRootPath() === rootPath && state.workspaceGeneration === generation;

  // Root changes and renderer-originated filesystem mutations share one FIFO
  // lease. Project handlers hold the lease from quiesce through setRootPath;
  // file/document handlers hold it across their final root check and write.
  // This closes the only remaining gap where an awaited formatter/read could
  // resume after a project switch and reinterpret its relative path.
  let workspaceMutationTail = Promise.resolve();
  const acquireWorkspaceMutation = async () => {
    const previous = workspaceMutationTail;
    let releaseGate;
    workspaceMutationTail = new Promise((resolve) => {
      releaseGate = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  };

  const withWorkspaceMutation = async (operation) => {
    const mutationRootPath = workspace.getRootPath();
    // This synchronous lease handshake is shared with AgentService. It makes
    // renderer mutations and the external Codex writer mutually exclusive;
    // an in-process file lock alone cannot serialize a separate process.
    const releaseRendererMutation = beginRendererWorkspaceMutation(mutationRootPath);
    const release = await acquireWorkspaceMutation();
    try {
      return await operation();
    } finally {
      release();
      releaseRendererMutation?.();
    }
  };

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
  const isExtendedTextFilePath = (relativePath) => isExtendedTextFileName(relativePath);
  const isImageFilePath = (relativePath) => IMAGE_FILE_EXTENSIONS.has(getFileExtension(relativePath));
  const isPdfFilePath = (relativePath) => getFileExtension(relativePath) === "pdf";

  let latestWorkspaceSnapshotRequest = 0;
  const WORKSPACE_SNAPSHOT_TIMEOUT_MS = 5000;
  const boundedWorkspaceOperation = (promise, label) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`${label} timed out.`)),
        WORKSPACE_SNAPSHOT_TIMEOUT_MS,
      );
      timer.unref?.();
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });

  const sendWorkspace = async (rootPath, expectedGeneration = state.workspaceGeneration) => {
    const requestSequence = ++latestWorkspaceSnapshotRequest;
    if (!workspaceSessionIsCurrent(rootPath, expectedGeneration)) {
      return false;
    }
    let files = [];
    let folders = [];
    let errorMessage = null;
    let enumerationFailed = false;
    let rootFile = "";
    let rootSource = "";
    let buildProfiles = [];
    let buildProfileId = "";
    const [filesResult, foldersResult, infoResult, settingsResult] = await Promise.allSettled([
      boundedWorkspaceOperation(workspace.listFiles(), "Workspace file listing"),
      boundedWorkspaceOperation(workspace.listFolders(), "Workspace folder listing"),
      boundedWorkspaceOperation(workspace.rootInfo(), "Workspace root detection"),
      boundedWorkspaceOperation(workspace.loadSettings(), "Workspace settings"),
    ]);
    if (filesResult.status === "fulfilled" && Array.isArray(filesResult.value)) {
      files = filesResult.value;
    } else {
      enumerationFailed = true;
      errorMessage = filesResult.reason?.message || "Unable to list workspace files.";
    }
    if (foldersResult.status === "fulfilled" && Array.isArray(foldersResult.value)) {
      folders = foldersResult.value;
    } else {
      enumerationFailed = true;
      if (!errorMessage) {
        errorMessage = foldersResult.reason?.message || "Unable to list workspace folders.";
      }
    }
    if (infoResult.status === "fulfilled" && infoResult.value?.path) {
      rootFile = infoResult.value.path;
      rootSource = infoResult.value.source;
    } else if (infoResult.status === "rejected" && !errorMessage) {
      errorMessage = infoResult.reason?.message || "Unable to detect the root document.";
    }
    if (settingsResult.status === "fulfilled") {
      const settings = settingsResult.value;
      if (Array.isArray(settings?.buildProfiles)) buildProfiles = settings.buildProfiles;
      if (typeof settings?.buildProfileId === "string") {
        buildProfileId = settings.buildProfileId;
      }
    } else if (!errorMessage) {
      errorMessage = settingsResult.reason?.message || "Unable to load workspace settings.";
    }
    if (
      requestSequence !== latestWorkspaceSnapshotRequest ||
      !workspaceSessionIsCurrent(rootPath, expectedGeneration)
    ) {
      return false;
    }
    if (enumerationFailed) {
      sendIssues(1, errorMessage || "Unable to refresh workspace files.", "error", [
        { severity: "error", message: errorMessage || "Unable to refresh workspace files." },
      ]);
      // The root identity has already changed. Publish that new identity even
      // when enumeration failed so renderer actions can never keep targeting
      // the old tree while main resolves relative paths in the new one.
      // Empty lists fail closed and a later refresh can repopulate them.
      files = [];
      folders = [];
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
      workspaceGeneration: expectedGeneration,
      workspaceId: state.workspaceId,
    });
    if (errorMessage) {
      sendIssues(1, errorMessage, "error", [
        { severity: "error", message: errorMessage },
      ]);
    }
    return true;
  };

  const updateWorkspaceIfNeeded = async (rootPath, force = false) => {
    const expectedGeneration = state.workspaceGeneration;
    if (!workspaceSessionIsCurrent(rootPath, expectedGeneration)) {
      return false;
    }
    if (!force && state.currentWorkspacePath === rootPath) {
      return true;
    }
    const sent = await sendWorkspace(rootPath, expectedGeneration);
    if (!sent || !workspaceSessionIsCurrent(rootPath, expectedGeneration)) {
      return false;
    }
    state.currentWorkspacePath = rootPath;
    return true;
  };

  const requestIndex = (rootPath) => {
    const expectedGeneration = state.workspaceGeneration;
    indexerService.requestIndex(rootPath, (snapshot) => {
      if (
        state.currentWorkspacePath !== rootPath ||
        !workspaceSessionIsCurrent(rootPath, expectedGeneration)
      ) {
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
    fileAccess,
    beforeWorkspaceChange,
    beginRendererWorkspaceMutation,

    TEXT_FILE_EXTENSIONS,
    IMAGE_FILE_EXTENSIONS,
    IMAGE_MIME_TYPES,
    getFileExtension,
    isTextFilePath,
    isExtendedTextFilePath,
    isImageFilePath,
    isPdfFilePath,

    sendWorkspace,
    updateWorkspaceIfNeeded,
    beginWorkspaceSession,
    workspaceSessionIsCurrent,
    acquireWorkspaceMutation,
    withWorkspaceMutation,
    requestIndex,
    sendLauncherStatus,
    ensureWorkspace,
    resolveWorkspacePath,
    openInTerminal,
    revealInFinder,
  };
};

module.exports = { createWorkspaceContext };
