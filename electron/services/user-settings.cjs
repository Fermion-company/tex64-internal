const path = require("path");
const fsp = require("fs/promises");

const DEFAULT_SETTINGS = {
  alchemy: {
    ocrLanguage: "jpn+eng",
  },
  agent: {
    temperature: 0.2,
    maxOutputTokens: 2048,
    maxIterations: 12,
    stream: true,
    autoApply: false,
    autoBuild: false,
    maxFileBytes: 0,
    maxReadFiles: 0,
    openFileMaxBytes: 0,
    openFileMaxChars: 0,
  },
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
    this.state = {
      ...clone(DEFAULT_SETTINGS),
      ...(stored && typeof stored === "object" ? stored : {}),
    };
    return clone(this.state);
  }

  async getAlchemySettings() {
    const state = await this.load();
    return clone(state.alchemy ?? DEFAULT_SETTINGS.alchemy);
  }

  async updateAlchemySettings(partial) {
    const state = await this.load();
    state.alchemy = {
      ...state.alchemy,
      ...(partial && typeof partial === "object" ? partial : {}),
    };
    this.state = state;
    await this.save();
    return clone(state.alchemy);
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
}

module.exports = {
  UserSettingsService,
};
