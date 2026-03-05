const path = require("path");
const fsp = require("fs/promises");

const MAX_RECENT_PROJECTS = 10;

const DEFAULT_SETTINGS = {
  agent: {
    model: "gemini-3-flash-preview",
    inlineModel: "gemini-2.5-flash-lite",
    temperature: 0.2,
    maxOutputTokens: 16384,
    maxIterations: 500,
    stream: true,
    autoApply: true,
    autoBuild: true,
    allowRunCommand: true,
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
};

const clone = (value) => JSON.parse(JSON.stringify(value));

class UserSettingsService {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "tex64-user-settings.json");
    this.state = null;
  }

  async load() {
    if (this.state) {
      return clone(this.state);
    }
    const stored = await fsp
      .readFile(this.filePath, "utf8")
      .then((content) => JSON.parse(content))
      .catch(() => null);
    const storedObject = stored && typeof stored === "object" ? stored : {};
    this.state = {
      ...clone(DEFAULT_SETTINGS),
      ...storedObject,
      agent: {
        ...clone(DEFAULT_SETTINGS.agent),
        ...(storedObject.agent && typeof storedObject.agent === "object"
          ? storedObject.agent
          : {}),
      },
      recentProjects: Array.isArray(storedObject.recentProjects)
        ? storedObject.recentProjects
        : clone(DEFAULT_SETTINGS.recentProjects),
    };
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
    this.state = state;
    await this.save();
    return clone(state.agent);
  }

  async save() {
    if (!this.state) {
      return;
    }
    const payload = JSON.stringify(this.state, null, 2);
    await fsp.writeFile(this.filePath, payload, "utf8");
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
}

module.exports = {
  UserSettingsService,
  MAX_RECENT_PROJECTS,
};
