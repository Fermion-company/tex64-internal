const path = require("path");

// The AI mode's documents: one folder per document inside the workspace,
// each with its own main.tex. The reader names a document; everything else —
// folder, file, scaffold — is arranged here so they never think about files.
const createWorkspaceAiDocumentHandlers = (ctx) => {
  const {
    fs,
    workspace,
    sendToRenderer,
    sendWorkspace,
    ensureWorkspace,
    updateWorkspaceIfNeeded,
    requestIndex,
  } = ctx;

  /** A folder name both macOS and Windows accept, still readably the title. */
  const sanitizeDocumentName = (title) => {
    const cleaned = (typeof title === "string" ? title : "")
      .replace(/[/\\:*?"<>|]/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      .trim();
    const clipped = Array.from(cleaned).slice(0, 60).join("").trim();
    return clipped || "新しい文書";
  };

  /** The title lands inside \title{...}; it must typeset as typed. */
  const escapeLatexText = (text) =>
    text.replace(/[\\%$&#_{}~^]/g, (char) => {
      if (char === "\\") return "\\textbackslash{}";
      if (char === "~") return "\\textasciitilde{}";
      if (char === "^") return "\\textasciicircum{}";
      return `\\${char}`;
    });

  /**
   * The smallest paper that typesets to a visible page: the title on page 1.
   * The agent rewrites everything from here; the scaffold only guarantees the
   * very first 組版 has something to show.
   */
  const scaffoldFor = (title) =>
    [
      "\\documentclass{ltjsarticle}",
      `\\title{${escapeLatexText(title)}}`,
      "\\author{}",
      "\\date{}",
      "\\begin{document}",
      "\\maketitle",
      "\\end{document}",
      "",
    ].join("\n");

  const handleDocumentCreate = async (requestId, title) => {
    if (!requestId || typeof requestId !== "string") {
      return;
    }
    const reply = (payload) =>
      sendToRenderer("document:createResult", { requestId, ...payload });
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      reply({ ok: false, error: "No workspace is selected." });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    const name = sanitizeDocumentName(title);
    try {
      let folder = name;
      let counter = 2;
      while (fs.existsSync(path.join(rootPath, folder))) {
        folder = `${name} ${counter}`;
        counter += 1;
        if (counter > 200) {
          throw new Error("Could not find an unused folder name.");
        }
      }
      await workspace.createFolder(folder);
      const mainFile = `${folder}/main.tex`;
      await workspace.writeFile(mainFile, scaffoldFor(folder));
      await sendWorkspace(rootPath);
      if (workspace.isIndexTarget(mainFile)) {
        requestIndex(rootPath);
      }
      reply({ ok: true, name: folder, folder, mainFile });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  };

  const handleDocumentList = async (requestId) => {
    if (!requestId || typeof requestId !== "string") {
      return;
    }
    const reply = (payload) =>
      sendToRenderer("document:listResult", { requestId, ...payload });
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      reply({ ok: false, error: "No workspace is selected." });
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    try {
      const documents = [];
      // A project opened before the folder-per-document flow keeps its
      // main.tex at the root; it is a document too, named after the project.
      const rootMain = path.join(rootPath, "main.tex");
      if (fs.existsSync(rootMain)) {
        documents.push({
          name: path.basename(rootPath),
          folder: "",
          mainFile: "main.tex",
          updatedAt: fs.statSync(rootMain).mtimeMs,
        });
      }
      for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const mainPath = path.join(rootPath, entry.name, "main.tex");
        if (!fs.existsSync(mainPath)) {
          continue;
        }
        documents.push({
          name: entry.name,
          folder: entry.name,
          mainFile: `${entry.name}/main.tex`,
          updatedAt: fs.statSync(mainPath).mtimeMs,
        });
      }
      documents.sort((left, right) => right.updatedAt - left.updatedAt);
      reply({ ok: true, documents });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  };

  return { handleDocumentCreate, handleDocumentList };
};

module.exports = { createWorkspaceAiDocumentHandlers };
