const path = require("path");
const fsp = require("fs/promises");
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
    const accepted =
      partial && typeof partial === "object" && typeof partial.model === "string"
        ? { model: partial.model }
        : {};
    state.agent = {
      ...state.agent,
      ...accepted,
    };
    state.agent.model = migrateLegacyAxiomModel(state.agent.model);
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
