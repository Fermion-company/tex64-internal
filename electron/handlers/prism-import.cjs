"use strict";

// IPC side of the Prism import: pick the zip, extract it next to a folder the
// user chooses, analyze each project, check the TeX environment, build with
// the ordinary BuildService (including the missing-package recovery the
// Build button uses) and compare the result with Prism's last PDF.
// Renderer: `tex64Prism.call(action, payload)`; progress goes out as
// `prism:progress` messages.

const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const prism = require("../services/prism-import.cjs");

const ENGINES = new Set(["pdflatex", "lualatex", "xelatex", "uplatex"]);
const BIB_TOOLS = new Set(["biber", "bibtex", "none"]);

const DIALOG_STRINGS = {
  en: { zipTitle: "Prism export", zipButton: "Import", destTitle: "Where to put the projects", destMessage: "The projects are unpacked into a new folder here.", destButton: "Unpack here" },
  ja: { zipTitle: "Prism の書き出し", zipButton: "読み込む", destTitle: "プロジェクトの置き場所", destMessage: "ここに新しいフォルダを作って展開します。", destButton: "ここに展開" },
};

const uniqueFolder = async (parent, name) => {
  let candidate = path.join(parent, name);
  for (let counter = 2; counter < 1000; counter += 1) {
    const exists = await fsp.stat(candidate).then(() => true).catch(() => false);
    if (!exists) return candidate;
    candidate = path.join(parent, `${name}-${counter}`);
  }
  throw new Error("Could not find a free folder name.");
};

const projectNameOf = (relative, zipName) => {
  if (!relative) return zipName;
  return relative.split("/").pop();
};

const createPrismImportHandlers = ({ dialog, state, envService, buildService, sendToRenderer }) => {
  let session = null;

  const strings = (locale) => DIALOG_STRINGS[locale === "ja" ? "ja" : "en"];

  const progress = (payload) => {
    if (!session) return;
    sendToRenderer("prism:progress", { sessionId: session.id, ...payload });
  };

  const projectOf = (payload) => {
    if (!session || payload?.sessionId !== session.id) throw new Error("This import has ended. Start it again.");
    const project = session.projects.find((entry) => entry.id === payload?.projectId);
    if (!project) throw new Error("Unknown project.");
    return project;
  };

  const writeRootFile = async (project, mainFile) => {
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
    if (!zipPath || !/\.zip$/i.test(zipPath)) throw new Error("Choose a .zip file exported from Prism.");
    const zipStat = await fsp.stat(zipPath).catch(() => null);
    if (!zipStat?.isFile()) throw new Error("The zip file was not found.");
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
    session = { id: crypto.randomUUID(), zipPath, destination, projects: [] };
    const sessionId = session.id;

    progress({ step: "extract", status: "running" });
    const { root, files } = await prism.extractZip(zipPath, destination, {
      onProgress: ({ current, total }) => progress({ step: "extract", status: "running", current, total }),
    });
    if (!session || session.id !== sessionId) return { canceled: true };
    progress({ step: "extract", status: "done", current: files.length, total: files.length });

    progress({ step: "analyze", status: "running" });
    const projectDirs = prism.findProjects(files.map((file) => file.relativePath));
    if (projectDirs.length === 0) throw new Error("No .tex file was found in the zip.");
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
      };
      if (analysis.mainFile) await writeRootFile(project, analysis.mainFile);
      session.projects.push(project);
    }
    progress({ step: "analyze", status: "done", current: session.projects.length, total: session.projects.length });

    progress({ step: "env", status: "running" });
    const report = await envService.detectEnvironment({ force: true }).catch(() => null);
    const ready = Boolean(report?.ready);
    if (ready) {
      for (const project of session.projects) {
        const located = await envService.locateTexFiles(project.analysis.packages).catch(() => null);
        project.missingPackages = located ? located.missing : [];
      }
    }
    const env = {
      ready,
      hasEngine: Boolean(report?.hasEngine),
      distribution: report?.distribution?.name || "",
      autoInstall: typeof envService.isManagedLightweight === "function" ? envService.isManagedLightweight() : false,
    };
    progress({ step: "env", status: ready ? "done" : "failed" });
    session.env = env;
    return {
      sessionId,
      destination: root,
      env,
      projects: session.projects.map(publicProject),
    };
  };

  // After the onboarding installed TeX the dialog asks again for the
  // environment and the missing packages, without unpacking a second time.
  const recheckEnv = async (payload = {}) => {
    if (!session || payload.sessionId !== session.id) throw new Error("This import has ended. Start it again.");
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
    return { env: session.env, projects: session.projects.map(publicProject) };
  };

  const build = async (payload = {}) => {
    const project = projectOf(payload);
    const mainFile = typeof payload.mainFile === "string" ? prism.normalizeZipPath(payload.mainFile) : null;
    if (!mainFile || !project.analysis.texFiles.includes(mainFile)) throw new Error("Choose the main file.");
    const engine = ENGINES.has(payload.engine) ? payload.engine : project.analysis.engine;
    const bibTool = BIB_TOOLS.has(payload.bibTool) ? payload.bibTool : project.analysis.bibTool;
    if (!session.env?.ready) throw new Error("TeX is not installed yet.");
    if (buildService.isBuilding) throw new Error("Build is already running.");
    await writeRootFile(project, mainFile);
    project.choice = { mainFile, engine, bibTool };
    const extraArgs = bibTool === "none" ? "-bibtex-" : "-bibtex";
    const buildProfile = { id: "prism-import", name: "Prism import", outDir: null, extraArgs };

    progress({ step: "build", status: "running", projectId: project.id });
    let result = await buildService.build(project.root, mainFile, engine, buildProfile);
    const installed = new Set();
    for (let attempt = 0; attempt < 4 && result.kind === "failure"; attempt += 1) {
      if (typeof envService.installMissingPackagesFromLog !== "function") break;
      const recovery = await envService.installMissingPackagesFromLog(result.log, {
        excludePackages: [...installed],
        onPackagesResolved: (packages) => progress({ step: "build", status: "running", projectId: project.id, installing: packages }),
      }).catch(() => null);
      if (!recovery?.success || !Array.isArray(recovery.packages) || recovery.packages.length === 0) break;
      recovery.packages.forEach((name) => installed.add(name));
      result = await buildService.build(project.root, mainFile, engine, buildProfile);
    }
    const ok = result.kind === "success";
    const output = buildService.resolveBuildOutputProfile(project.root, mainFile, buildProfile);
    const pdfPath = ok ? output.pdfPath : null;
    const log = typeof result.log === "string" ? result.log : "";
    const issues = Array.isArray(result.issues) ? result.issues.slice(0, 5) : [];
    const buildReport = {
      ok,
      kind: result.kind,
      summary: result.summary || (ok ? "Build finished." : "Build failed."),
      issues,
      logTail: log.split(/\r?\n/).slice(-40).join("\n"),
      pdfPath: pdfPath ? path.relative(project.root, pdfPath).split(path.sep).join("/") : null,
      installed: [...installed],
    };
    progress({ step: "build", status: ok ? "done" : "failed", projectId: project.id });
    if (!ok) return { build: buildReport, diff: null };

    progress({ step: "compare", status: "running", projectId: project.id });
    let diff = null;
    let compareError = null;
    if (project.analysis.prismPdf) {
      const prismPdfPath = path.join(project.root, ...project.analysis.prismPdf.split("/"));
      const samePdf = path.resolve(prismPdfPath) === path.resolve(pdfPath);
      if (samePdf) {
        // The build overwrote Prism's PDF of the same name. Compare against
        // the copy BuildService keeps? None exists, so say so plainly.
        compareError = "same-name";
      } else {
        try {
          const [prismOutline, localOutline] = await Promise.all([
            prism.readPdfOutline(prismPdfPath),
            prism.readPdfOutline(pdfPath),
          ]);
          diff = prism.comparePdfOutlines(prismOutline, localOutline);
        } catch (error) {
          compareError = error?.message || String(error);
        }
      }
    } else {
      compareError = "no-prism-pdf";
    }
    progress({ step: "compare", status: diff ? "done" : "failed", projectId: project.id });
    return { build: buildReport, diff, compareError, prismPdf: project.analysis.prismPdf };
  };

  // Before the first build, move Prism's PDF aside when it carries the name
  // the build will write, so the comparison still has both sides.
  const preserveRecord = new Map();
  const preservePrismPdf = async (project, mainFile) => {
    const prismPdf = project.analysis.prismPdf;
    if (!prismPdf) return;
    const stem = mainFile.replace(/\.(tex|ltx)$/i, "");
    if (prismPdf.replace(/\.pdf$/i, "") !== stem) return;
    if (preserveRecord.has(project.id)) return;
    const source = path.join(project.root, ...prismPdf.split("/"));
    const target = path.join(path.dirname(source), `${path.basename(source, ".pdf")}.prism.pdf`);
    await fsp.copyFile(source, target);
    const relative = path.relative(project.root, target).split(path.sep).join("/");
    project.analysis = { ...project.analysis, prismPdf: relative };
    preserveRecord.set(project.id, relative);
  };

  const request = async (action, payload = {}) => {
    switch (action) {
      case "choose-zip":
        return chooseZip(payload);
      case "start":
        return start(payload);
      case "recheck-env":
        return recheckEnv(payload);
      case "build": {
        const project = projectOf(payload);
        const mainFile = typeof payload.mainFile === "string" ? prism.normalizeZipPath(payload.mainFile) : null;
        if (mainFile && project.analysis.texFiles.includes(mainFile)) await preservePrismPdf(project, mainFile);
        return build(payload);
      }
      case "end":
        if (session && payload.sessionId === session.id) session = null;
        return {};
      default:
        throw new Error(`Unknown Prism import action: ${action}`);
    }
  };

  return { request };
};

module.exports = { createPrismImportHandlers };
