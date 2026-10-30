"use strict";

// IPC side of the Prism import: pick the zip, extract it next to a folder the
// user chooses, analyze each project, check the TeX environment, build with
// the ordinary BuildService (including the missing-package recovery the
// Build button uses) and compare the result with Prism's last PDF.
// Renderer: `tex64Prism.call(action, payload)`; progress goes out as
// `prism:progress` messages. Failures carry a `code` (and the `step` they
// belong to); the renderer owns the wording.

const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const prism = require("../services/prism-import.cjs");

const ENGINES = new Set(["pdflatex", "lualatex", "xelatex", "uplatex"]);
const BIB_TOOLS = new Set(["biber", "bibtex", "none"]);
const PROFILE_ID = "prism-import";

const BIB_ARGS = {
  none: "-bibtex-",
  bibtex: "-bibtex",
  biber: "-bibtex -e $bibtex_use=2",
};
const BIB_ARTIFACTS = [".bbl", ".blg", ".bcf", ".run.xml"];

const DIALOG_STRINGS = {
  en: { zipTitle: "Prism export", zipButton: "Import", destTitle: "Where to put the projects", destMessage: "The projects are unpacked into a new folder here.", destButton: "Unpack here" },
  ja: { zipTitle: "Prism の書き出し", zipButton: "読み込む", destTitle: "プロジェクトの置き場所", destMessage: "ここに新しいフォルダを作って展開します。", destButton: "ここに展開" },
};

const failure = (code, step = null) => Object.assign(new Error(code), { code, step });

const uniqueFolder = async (parent, name) => {
  let candidate = path.join(parent, name);
  for (let counter = 2; counter < 1000; counter += 1) {
    const exists = await fsp.stat(candidate).then(() => true).catch(() => false);
    if (!exists) return candidate;
    candidate = path.join(parent, `${name}-${counter}`);
  }
  throw failure("DEST_NAME", "extract");
};

const projectNameOf = (relative, zipName) => (relative ? relative.split("/").pop() : zipName);

// The engine is the profile's own field (Build and the Settings page read it);
// only the bibliography switch goes through latexmk options.
const buildProfileFor = (engine, bibTool) => ({
  id: PROFILE_ID,
  name: "Prism",
  outDir: null,
  extraArgs: BIB_ARGS[bibTool] || BIB_ARGS.bibtex,
  engine: ENGINES.has(engine) ? engine : "pdflatex",
});

// The first issue with a source location explains a failed run better than
// latexmk's closing "Fatal error" line. When the run's own issue list has no
// such line, the .log is parsed the way the Issues panel parses it.
// TeX wraps its transcript at 79 columns; a `file:line: message` diagnostic
// from a package outside the project (texmf) is split across two lines and
// the Issues parser keeps only in-project paths, so read it here directly.
const firstTexDiagnostic = (transcript) => {
  const raw = String(transcript || "").split(/\r?\n/);
  const lines = [];
  for (let index = 0; index < raw.length; index += 1) {
    let line = raw[index];
    while (line.length === 79 && index + 1 < raw.length) { index += 1; line += raw[index]; }
    lines.push(line);
  }
  for (const line of lines) {
    const located = /^(?:\.\/)?(\S+?\.(?:tex|ltx|sty|cls|def|cfg|ldf|lua)):(\d+):\s*(.+)$/.exec(line);
    if (located) return { severity: "error", message: located[3].trim(), path: path.basename(located[1]), line: Number(located[2]) };
    const bang = /^!\s+(.+)$/.exec(line);
    if (bang) return { severity: "error", message: bang[1].trim(), path: null, line: null };
  }
  return null;
};

const explainFailure = async (buildService, root, pdfPath, issues, transcript) => {
  const located = (list) => list.filter((issue) => issue && issue.severity === "error" && issue.line != null);
  let best = located(issues);
  if (best.length === 0) {
    const logPath = pdfPath.replace(/\.pdf$/i, ".log");
    const log = await fsp.readFile(logPath, "utf8").catch(() => "");
    if (log && typeof buildService.parseIssues === "function") best = located(buildService.parseIssues(log, root));
    if (best.length === 0) {
      const found = firstTexDiagnostic(transcript) || firstTexDiagnostic(log);
      if (found) best = [found];
    }
  }
  const rest = issues.filter((issue) => !best.includes(issue));
  return [...best, ...rest];
};

const classifyExtractError = (error) => {
  if (error?.code) return error;
  const message = String(error?.message || "");
  if (/Unsafe path/.test(message)) return failure("ZIP_UNSAFE_PATH", "extract");
  if (/larger than 2 GB|more than 2 GB/.test(message)) return failure("ZIP_TOO_LARGE", "extract");
  if (/holds no files/.test(message)) return failure("ZIP_EMPTY", "extract");
  if (/too many files/.test(message)) return failure("ZIP_TOO_MANY", "extract");
  return failure("ZIP_INVALID", "extract");
};

const createPrismImportHandlers = ({ dialog, state, envService, buildService, sendToRenderer }) => {
  let session = null;

  const strings = (locale) => DIALOG_STRINGS[locale === "ja" ? "ja" : "en"];

  const progress = (sessionId, payload) => {
    if (!session || session.id !== sessionId) return;
    sendToRenderer("prism:progress", { sessionId, ...payload });
  };

  const projectOf = (payload) => {
    if (!session || payload?.sessionId !== session.id) throw failure("SESSION_ENDED");
    const project = session.projects.find((entry) => entry.id === payload?.projectId);
    if (!project) throw failure("UNKNOWN_PROJECT");
    return project;
  };

  const writeProjectSettings = async (project, mainFile, profile) => {
    const directory = path.join(project.root, ".tex64");
    await fsp.mkdir(directory, { recursive: true });
    const settingsPath = path.join(directory, "settings.json");
    let settings = {};
    try {
      settings = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
      if (!settings || typeof settings !== "object") settings = {};
    } catch {
      settings = {};
    }
    settings.rootFile = mainFile;
    if (profile) {
      const others = (Array.isArray(settings.buildProfiles) ? settings.buildProfiles : [])
        .filter((entry) => entry && typeof entry === "object" && entry.id !== PROFILE_ID);
      settings.buildProfiles = [profile, ...others];
      settings.buildProfileId = PROFILE_ID;
    }
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  };

  const publicProject = (project) => ({
    id: project.id,
    name: project.name,
    root: project.root,
    analysis: project.analysis,
    notes: project.notes,
    missingPackages: project.missingPackages,
  });

  const detectEnv = async () => {
    const report = await envService.detectEnvironment({ force: true }).catch(() => null);
    const ready = Boolean(report?.ready);
    if (ready) {
      for (const project of session.projects) {
        const located = await envService.locateTexFiles(project.analysis.packages).catch(() => null);
        project.missingPackages = located ? located.missing : [];
      }
    }
    session.env = {
      ready,
      hasEngine: Boolean(report?.hasEngine),
      distribution: report?.distribution?.name || "",
      autoInstall: typeof envService.isManagedLightweight === "function" ? envService.isManagedLightweight() : false,
    };
    return session.env;
  };

  const chooseZip = async (payload = {}) => {
    const labels = strings(payload.locale);
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: labels.zipTitle,
      buttonLabel: labels.zipButton,
      properties: ["openFile"],
      filters: [{ name: "zip", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { zipPath: result.filePaths[0] };
  };

  const start = async (payload = {}) => {
    const zipPath = typeof payload.zipPath === "string" ? payload.zipPath : "";
    if (!zipPath || !/\.zip$/i.test(zipPath)) throw failure("ZIP_NOT_ZIP", "extract");
    const zipStat = await fsp.stat(zipPath).catch(() => null);
    if (!zipStat?.isFile()) throw failure("ZIP_NOT_FOUND", "extract");
    const labels = strings(payload.locale);
    const chosen = await dialog.showOpenDialog(state.mainWindow, {
      title: labels.destTitle,
      message: labels.destMessage,
      buttonLabel: labels.destButton,
      properties: ["openDirectory", "createDirectory"],
      defaultPath: path.dirname(zipPath),
    });
    if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true };
    const zipName = path.basename(zipPath, path.extname(zipPath)).replace(/[\\/:*?"<>|]/g, "-") || "prism";
    const destination = await uniqueFolder(chosen.filePaths[0], zipName);
    if (session?.building) buildService.cancelCurrentRun();
    session = { id: crypto.randomUUID(), zipPath, destination, projects: [], env: null, building: false };
    const sessionId = session.id;

    progress(sessionId, { step: "extract", status: "running" });
    let extracted;
    try {
      extracted = await prism.extractZip(zipPath, destination, {
        onProgress: ({ current, total }) => progress(sessionId, { step: "extract", status: "running", current, total }),
      });
    } catch (error) {
      await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw classifyExtractError(error);
    }
    if (!session || session.id !== sessionId) return { canceled: true };
    const { root, files } = extracted;
    progress(sessionId, { step: "extract", status: "done", current: files.length, total: files.length });

    progress(sessionId, { step: "analyze", status: "running" });
    const projectDirs = prism.findProjects(files.map((file) => file.relativePath));
    if (projectDirs.length === 0) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
      throw failure("NO_TEX", "analyze");
    }
    for (const relative of projectDirs) {
      const projectRoot = relative ? path.join(root, ...relative.split("/")) : root;
      const list = await prism.walkProject(projectRoot);
      const analysis = prism.analyzeProject(list);
      const notes = await prism.writeConversationNotes(projectRoot, analysis.conversations);
      const project = {
        id: crypto.randomUUID(),
        name: projectNameOf(relative, zipName),
        root: projectRoot,
        analysis,
        notes,
        missingPackages: [],
        preserved: new Set(),
        lastBibTool: null,
        lastIssues: [],
      };
      if (analysis.mainFile) {
        await writeProjectSettings(project, analysis.mainFile, buildProfileFor(analysis.engine, analysis.bibTool));
      }
      session.projects.push(project);
    }
    progress(sessionId, { step: "analyze", status: "done", current: session.projects.length, total: session.projects.length });

    progress(sessionId, { step: "env", status: "running" });
    const env = await detectEnv();
    progress(sessionId, { step: "env", status: env.ready ? "done" : "failed" });
    return { sessionId, destination: root, env, projects: session.projects.map(publicProject) };
  };

  // After the onboarding installed TeX the dialog asks again for the
  // environment and the missing packages, without unpacking a second time.
  const recheckEnv = async (payload = {}) => {
    if (!session || payload.sessionId !== session.id) throw failure("SESSION_ENDED");
    const env = await detectEnv();
    return { env, projects: session.projects.map(publicProject) };
  };

  // A PDF the zip brought along must survive the first build that writes
  // the same path. The copy is made once per path, before our own output
  // could have replaced it; Prism's main PDF is compared from its copy.
  const preserveExistingPdf = async (project, pdfPath) => {
    if (project.preserved.has(pdfPath)) return;
    const stat = await fsp.stat(pdfPath).catch(() => null);
    if (!stat?.isFile()) { project.preserved.add(pdfPath); return; }
    const copy = path.join(path.dirname(pdfPath), `${path.basename(pdfPath, ".pdf")}.prism.pdf`);
    await fsp.copyFile(pdfPath, copy);
    project.preserved.add(pdfPath);
    const relative = path.relative(project.root, pdfPath).split(path.sep).join("/");
    if (project.analysis.prismPdf === relative) {
      project.analysis = { ...project.analysis, prismPdf: path.relative(project.root, copy).split(path.sep).join("/") };
    }
  };

  const removeBibArtifacts = async (project, pdfPath) => {
    const stem = pdfPath.replace(/\.pdf$/i, "");
    for (const extension of BIB_ARTIFACTS) await fsp.rm(`${stem}${extension}`, { force: true }).catch(() => {});
  };

  const build = async (payload = {}) => {
    const project = projectOf(payload);
    const mainFile = typeof payload.mainFile === "string" ? prism.normalizeZipPath(payload.mainFile) : null;
    if (!mainFile || !project.analysis.texFiles.includes(mainFile)) throw failure("NO_MAIN", "build");
    const engine = ENGINES.has(payload.engine) ? payload.engine : project.analysis.engine;
    const bibTool = BIB_TOOLS.has(payload.bibTool) ? payload.bibTool : project.analysis.bibTool;
    if (!session.env?.ready) throw failure("TEX_MISSING", "env");
    if (buildService.isBuilding) throw failure("BUILD_BUSY", "build");
    const profile = buildProfileFor(engine, bibTool);
    await writeProjectSettings(project, mainFile, profile);
    const output = buildService.resolveBuildOutputProfile(project.root, mainFile, profile);
    await preserveExistingPdf(project, output.pdfPath);
    if (project.lastBibTool !== null && project.lastBibTool !== bibTool) await removeBibArtifacts(project, output.pdfPath);
    project.lastBibTool = bibTool;

    const sessionId = session.id;
    progress(sessionId, { step: "build", status: "running", projectId: project.id });
    session.building = true;
    let result;
    try {
      result = await buildService.build(project.root, mainFile, engine, profile);
      const installed = new Set();
      for (let attempt = 0; attempt < 4 && result.kind === "failure"; attempt += 1) {
        if (typeof envService.installMissingPackagesFromLog !== "function") break;
        const recovery = await envService.installMissingPackagesFromLog(result.log, {
          excludePackages: [...installed],
          onPackagesResolved: (packages) => progress(sessionId, { step: "build", status: "running", projectId: project.id, installing: packages }),
        }).catch(() => null);
        if (!recovery?.success || !Array.isArray(recovery.packages) || recovery.packages.length === 0) break;
        recovery.packages.forEach((name) => installed.add(name));
        result = await buildService.build(project.root, mainFile, engine, profile);
      }
      result.installed = [...installed];
    } finally {
      if (session?.id === sessionId) session.building = false;
    }
    if (!session || session.id !== sessionId) return { canceled: true };
    const ok = result.kind === "success";
    let issues = Array.isArray(result.issues) ? result.issues : [];
    if (!ok && result.kind === "failure") issues = await explainFailure(buildService, project.root, output.pdfPath, issues, result.log);
    project.lastIssues = { summary: result.summary || "", issues };
    const buildReport = {
      ok,
      kind: result.kind,
      issues: issues.slice(0, 3).map((issue) => ({ severity: issue.severity, message: issue.message, path: issue.path ?? null, line: issue.line ?? null })),
      issueCount: issues.length,
      pdfPath: ok ? path.relative(project.root, output.pdfPath).split(path.sep).join("/") : null,
      installed: result.installed,
    };
    progress(sessionId, { step: "build", status: ok ? "done" : "failed", projectId: project.id });
    if (!ok) return { build: buildReport, diff: null };

    progress(sessionId, { step: "compare", status: "running", projectId: project.id });
    let diff = null;
    let compareError = null;
    if (project.analysis.prismPdf) {
      const prismPdfPath = path.join(project.root, ...project.analysis.prismPdf.split("/"));
      try {
        const [prismOutline, localOutline] = await Promise.all([
          prism.readPdfOutline(prismPdfPath),
          prism.readPdfOutline(output.pdfPath),
        ]);
        diff = prism.comparePdfOutlines(prismOutline, localOutline);
      } catch {
        compareError = "COMPARE_FAILED";
      }
    } else {
      compareError = "NO_PRISM_PDF";
    }
    progress(sessionId, { step: "compare", status: diff ? "done" : "failed", projectId: project.id });
    return { build: buildReport, diff, compareError, prismPdf: project.analysis.prismPdf };
  };

  const cancel = (payload = {}) => {
    if (session && payload.sessionId === session.id && session.building) buildService.cancelCurrentRun();
    return {};
  };

  // The renderer shows these in the Issues panel once the project is open.
  const showIssues = (payload = {}) => {
    const project = projectOf(payload);
    const { summary, issues } = project.lastIssues || { summary: "", issues: [] };
    return { summary, issues };
  };

  const request = async (action, payload = {}) => {
    switch (action) {
      case "choose-zip": return chooseZip(payload);
      case "start": return start(payload);
      case "recheck-env": return recheckEnv(payload);
      case "build": return build(payload);
      case "cancel": return cancel(payload);
      case "show-issues": return showIssues(payload);
      case "end":
        if (session && payload.sessionId === session.id) {
          if (session.building) buildService.cancelCurrentRun();
          session = null;
        }
        return {};
      default:
        throw failure("UNKNOWN_ACTION");
    }
  };

  return { request };
};

module.exports = { createPrismImportHandlers };
