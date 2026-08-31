const path = require("path");
const fsp = require("fs/promises");
const { migrateLegacyAxiomModel } = require("./openprism/llm-config.cjs");
const {
  resolveMaxAgentIterations,
} = require("./openprism/run-budget.cjs");

const MAX_RECENT_PROJECTS = 10;

const DEFAULT_SETTINGS = {
  agent: {
    model: "Axiom1.0",
    endpoint: "",
    maxIterations: 24,
    stream: true,
    autoApply: true,
    autoBuild: true,
    allowRunCommand: false,
    maxFileBytes: 400_000,
    maxReadFiles: 16,
    openFileMaxBytes: 0,
    openFileMaxChars: 12000,
    allowedTopLevel: [],
    blockedTopLevel: [
      ".git",
      ".tex64",
      ".ssh",
      ".aws",
      ".gnupg",
      ".npm",
      ".yarn",
      ".pnpm-store",
      ".cache",
      "node_modules",
      "build",
      "dist",
      "out",
      "coverage",
      ".next",
      ".swiftpm",
      "DerivedData",
      "tex64.xcodeproj",
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".env.test",
      ".npmrc",
      ".yarnrc",
      ".yarnrc.yml",
      ".pypirc",
      ".netrc",
    ],
    textExtensions: [
      "tex",
      "bib",
      "sty",
      "cls",
      "ltx",
      "dtx",
      "md",
      "txt",
      "log",
      "json",
      "yaml",
      "yml",
      "toml",
      "csv",
      "tsv",
      "xml",
      "html",
      "css",
      "svg",
      "js",
      "ts",
      "cjs",
      "mjs",
      "sh",
      "py",
    ],
    extraTextExtensions: [
      "aux",
      "toc",
      "out",
      "bbl",
      "blg",
      "fls",
      "fdb_latexmk",
    ],
    costInputPerMillion: 0,
    costOutputPerMillion: 0,
  },
  recentProjects: [],
  dismissedAnnouncementIds: [],
};

const MAX_DISMISSED_ANNOUNCEMENT_IDS = 200;

const clone = (value) => JSON.parse(JSON.stringify(value));

class UserSettingsService {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "tex64-user-settings.json");
    this.state = null;
  }

  async load() {
    // Always re-read from disk: a long-lived in-memory copy plus the
    // whole-state save() below used to clobber the file with stale data
    // whenever two app instances overlapped, and a single failed read
    // cached "defaults" (empty recents) for the rest of the session —
    // the next save then wiped the user's real history (observed live).
    const stored = await fsp
      .readFile(this.filePath, "utf8")
      .then((content) => JSON.parse(content))
      .catch(async (error) => {
        if (error && error.code === "ENOENT") {
          return null; // fresh install — defaults are correct
        }
        // A corrupt/unreadable settings file must never silently become
        // defaults that later get persisted over the user's data; keep
        // the evidence, then fall back.
        await fsp
          .copyFile(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
          .catch(() => {});
        console.warn(
          "[user-settings] settings file unreadable, backed up:",
          error?.message ?? error
        );
        return null;
      });
    const storedObject = stored && typeof stored === "object" ? stored : {};
    const storedAgent =
      storedObject.agent && typeof storedObject.agent === "object"
        ? storedObject.agent
        : {};
    const mergedAgent = {
      ...clone(DEFAULT_SETTINGS.agent),
      ...storedAgent,
    };
    const didDisableRunCommand = mergedAgent.allowRunCommand !== false;
    mergedAgent.allowRunCommand = false;
    const safeMaxIterations = resolveMaxAgentIterations(mergedAgent.maxIterations);
    const didClampMaxIterations = safeMaxIterations !== mergedAgent.maxIterations;
    mergedAgent.maxIterations = safeMaxIterations;
    const migratedModel = migrateLegacyAxiomModel(mergedAgent.model);
    const didMigrateModel = migratedModel !== mergedAgent.model;
    if (didMigrateModel || didDisableRunCommand || didClampMaxIterations) {
      mergedAgent.model = migratedModel;
    }

    this.state = {
      ...clone(DEFAULT_SETTINGS),
      ...storedObject,
      agent: mergedAgent,
      recentProjects: Array.isArray(storedObject.recentProjects)
        ? storedObject.recentProjects
        : clone(DEFAULT_SETTINGS.recentProjects),
      dismissedAnnouncementIds: Array.isArray(storedObject.dismissedAnnouncementIds)
        ? storedObject.dismissedAnnouncementIds.filter(
            (id) => typeof id === "string" && id.trim()
          )
        : clone(DEFAULT_SETTINGS.dismissedAnnouncementIds),
    };
    if (didMigrateModel || didDisableRunCommand || didClampMaxIterations) {
      // Persist canonical, safe settings so every renderer and future launch
      // sees the same model and a legacy toggle cannot resurrect shell access.
      // Loading still succeeds if a transient disk error prevents this
      // best-effort migration write.
      await this.save().catch(() => {});
    }
    return clone(this.state);
  }

  async getAgentSettings() {
    const state = await this.load();
    return clone(state.agent ?? DEFAULT_SETTINGS.agent);
  }

  async updateAgentSettings(partial) {
    const state = await this.load();
    state.agent = {
      ...state.agent,
      ...(partial && typeof partial === "object" ? partial : {}),
    };
    state.agent.model = migrateLegacyAxiomModel(state.agent.model);
    state.agent.allowRunCommand = false;
    state.agent.maxIterations = resolveMaxAgentIterations(
      state.agent.maxIterations,
    );
    this.state = state;
    await this.save();
    return clone(state.agent);
  }

  async save() {
    if (!this.state) {
      return;
    }
    // Atomic replace: a torn write must never produce a half-written file
    // that the next load treats as corrupt.
    const payload = JSON.stringify(this.state, null, 2);
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    await fsp.writeFile(tmpPath, payload, "utf8");
    await fsp.rename(tmpPath, this.filePath);
  }

  async getRecentProjects() {
    const state = await this.load();
    return clone(state.recentProjects ?? []);
  }

  async addRecentProject(projectPath) {
    if (!projectPath || typeof projectPath !== "string") {
      return;
    }
    const state = await this.load();
    const existing = state.recentProjects ?? [];
    
    // Remove if already exists (to move it to top)
    const filtered = existing.filter((p) => p.path !== projectPath);
    
    // Get folder name from path
    const name = path.basename(projectPath);
    
    // Add to the front
    const updated = [
      { path: projectPath, name, openedAt: Date.now() },
      ...filtered,
    ].slice(0, MAX_RECENT_PROJECTS);
    
    state.recentProjects = updated;
    this.state = state;
    await this.save();
    return clone(updated);
  }

  async removeRecentProject(projectPath) {
    const state = await this.load();
    const existing = state.recentProjects ?? [];
    const filtered = existing.filter((p) => p.path !== projectPath);
    state.recentProjects = filtered;
    this.state = state;
    await this.save();
    return clone(filtered);
  }

  async clearRecentProjects() {
    const state = await this.load();
    state.recentProjects = [];
    this.state = state;
    await this.save();
    return [];
  }

  async getDismissedAnnouncementIds() {
    const state = await this.load();
    return clone(state.dismissedAnnouncementIds ?? []);
  }

  async addDismissedAnnouncementId(id) {
    if (typeof id !== "string" || !id.trim()) {
      return clone(this.state?.dismissedAnnouncementIds ?? []);
    }
    const trimmed = id.trim();
    const state = await this.load();
    const existing = Array.isArray(state.dismissedAnnouncementIds)
      ? state.dismissedAnnouncementIds
      : [];
    if (existing.includes(trimmed)) {
      return clone(existing);
    }
    const updated = [...existing, trimmed].slice(-MAX_DISMISSED_ANNOUNCEMENT_IDS);
    state.dismissedAnnouncementIds = updated;
    this.state = state;
    await this.save();
    return clone(updated);
  }
}

module.exports = {
  UserSettingsService,
  MAX_RECENT_PROJECTS,
  MAX_DISMISSED_ANNOUNCEMENT_IDS,
};
