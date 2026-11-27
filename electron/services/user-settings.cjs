const path = require("path");
const fsp = require("fs/promises");
const lockfile = require("proper-lockfile");
const { atomicWrite } = require("./history-files.cjs");
const { migrateLegacyAxiomModel } = require("./openprism/llm-config.cjs");

const MAX_RECENT_PROJECTS = 10;

const DEFAULT_SETTINGS = {
  // The agent's behaviour (iterations, auto-apply, auto-build, file limits,
  // blocked folders, endpoint) is fixed in code; the only stored choice is
  // the model. Developer overrides stay on environment variables.
  agent: {
    model: "Axiom1.0",
  },
  recentProjects: [],
  dismissedAnnouncementIds: [],
  // Zotero: the chosen library id ("users:0", "groups:<id>", "bbt:<id>") and
  // the Web API key, stored only as the safeStorage ciphertext (base64).
  zotero: {
    library: "",
    libraryName: "",
    libraryKind: "",
    apiKeyEncrypted: "",
  },
};

const MAX_DISMISSED_ANNOUNCEMENT_IDS = 200;

const clone = (value) => JSON.parse(JSON.stringify(value));

class UserSettingsService {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "tex64-user-settings.json");
    this.pending = Promise.resolve();
  }

  async readSettings() {
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
    // Older settings files carried agent knobs; only the model survives.
    const mergedAgent = {
      ...clone(DEFAULT_SETTINGS.agent),
      ...(typeof storedAgent.model === "string" ? { model: storedAgent.model } : {}),
    };
    const hadLegacyAgentKeys = Object.keys(storedAgent).some((key) => key !== "model");
    const migratedModel = migrateLegacyAxiomModel(mergedAgent.model);
    const didMigrateModel = migratedModel !== mergedAgent.model;
    mergedAgent.model = migratedModel;
    const didDisableRunCommand = hadLegacyAgentKeys;
    const didClampMaxIterations = false;

    const state = {
      ...clone(DEFAULT_SETTINGS),
      ...storedObject,
      agent: mergedAgent,
      recentProjects: Array.isArray(storedObject.recentProjects)
        ? storedObject.recentProjects
            .filter((entry) => entry && typeof entry.path === "string" && entry.path.trim())
            .map((entry) => ({
              ...entry,
              name: typeof entry.name === "string" && entry.name.trim()
                ? entry.name
                : path.basename(entry.path),
            }))
        : clone(DEFAULT_SETTINGS.recentProjects),
      dismissedAnnouncementIds: Array.isArray(storedObject.dismissedAnnouncementIds)
        ? storedObject.dismissedAnnouncementIds.filter(
            (id) => typeof id === "string" && id.trim()
          )
        : clone(DEFAULT_SETTINGS.dismissedAnnouncementIds),
      zotero: {
        ...clone(DEFAULT_SETTINGS.zotero),
        ...(storedObject.zotero && typeof storedObject.zotero === "object"
          ? {
              library: typeof storedObject.zotero.library === "string" ? storedObject.zotero.library : "",
              libraryName: typeof storedObject.zotero.libraryName === "string" ? storedObject.zotero.libraryName : "",
              libraryKind: typeof storedObject.zotero.libraryKind === "string" ? storedObject.zotero.libraryKind : "",
              apiKeyEncrypted:
                typeof storedObject.zotero.apiKeyEncrypted === "string" ? storedObject.zotero.apiKeyEncrypted : "",
            }
          : {}),
      },
    };
    return { state, needsMigration: didMigrateModel || didDisableRunCommand || didClampMaxIterations };
  }

  async load() {
    await this.pending;
    const { state, needsMigration } = await this.readSettings();
    if (!needsMigration) return state;
    return this.update(current => current).catch(() => state);
  }

  update(change) {
    const operation = this.pending.then(async () => {
      const release = await lockfile.lock(this.filePath, {
        realpath: false,
        retries: { retries: 12, minTimeout: 20, maxTimeout: 250, randomize: true },
      });
      try {
        const { state } = await this.readSettings();
        const result = change(state);
        await atomicWrite(this.filePath, JSON.stringify(state, null, 2));
        return clone(result);
      } finally {
        await release();
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async getAgentSettings() {
    return (await this.load()).agent;
  }

  updateAgentSettings(partial) {
    return this.update(state => {
      if (typeof partial?.model === "string") state.agent.model = migrateLegacyAxiomModel(partial.model);
      return state.agent;
    });
  }

  async getRecentProjects() {
    return (await this.load()).recentProjects;
  }

  async addRecentProject(projectPath) {
    if (!projectPath || typeof projectPath !== "string") return;
    return this.update(state => {
      const other = state.recentProjects.filter(project => project.path !== projectPath);
      const project = { path: projectPath, name: path.basename(projectPath), openedAt: Date.now() };
      state.recentProjects = [project, ...other].slice(0, MAX_RECENT_PROJECTS);
      return state.recentProjects;
    });
  }

  removeRecentProject(projectPath) {
    return this.update(state => {
      state.recentProjects = state.recentProjects.filter(project => project.path !== projectPath);
      return state.recentProjects;
    });
  }

  clearRecentProjects() {
    return this.update(state => {
      state.recentProjects = [];
      return state.recentProjects;
    });
  }

  async getZoteroSettings() {
    return (await this.load()).zotero;
  }

  updateZoteroSettings(partial) {
    return this.update(state => {
      for (const key of Object.keys(DEFAULT_SETTINGS.zotero)) {
        if (typeof partial?.[key] === "string") state.zotero[key] = partial[key];
      }
      return state.zotero;
    });
  }

  async getDismissedAnnouncementIds() {
    return (await this.load()).dismissedAnnouncementIds;
  }

  async addDismissedAnnouncementId(id) {
    if (typeof id !== "string" || !id.trim()) return this.getDismissedAnnouncementIds();
    const trimmed = id.trim();
    return this.update(state => {
      if (!state.dismissedAnnouncementIds.includes(trimmed)) {
        state.dismissedAnnouncementIds = [...state.dismissedAnnouncementIds, trimmed].slice(-MAX_DISMISSED_ANNOUNCEMENT_IDS);
      }
      return state.dismissedAnnouncementIds;
    });
  }
}

module.exports = {
  UserSettingsService,
  MAX_RECENT_PROJECTS,
  MAX_DISMISSED_ANNOUNCEMENT_IDS,
};
