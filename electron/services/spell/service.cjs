"use strict";

// Spell-check service (main process). Wraps nspell + the en_US Hunspell
// dictionary (dictionary-en) and a persisted user dictionary. The renderer does
// the LaTeX-aware tokenization and sends prose words here to be checked, mirroring
// the math-ocr / texlab service convention. English only for now.

const fsp = require("fs/promises");
const path = require("path");

class SpellService {
  constructor({ userDataPath } = {}) {
    this.userDataPath = typeof userDataPath === "string" ? userDataPath : "";
    this.userDictPath = this.userDataPath
      ? path.join(this.userDataPath, "tex64-user-dictionary.json")
      : "";
    this.spell = null;
    this.loading = null;
    this.userWords = new Set();
  }

  async ensureLoaded() {
    if (this.spell) {
      return;
    }
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      // nspell is CommonJS; dictionary-en is ESM (dynamic import from CJS).
      const nspell = require("nspell");
      const dictMod = await import("dictionary-en");
      const dict = dictMod.default || dictMod;
      const spell = nspell(dict);
      await this.loadUserWords();
      this.userWords.forEach((word) => spell.add(word));
      this.spell = spell;
    })();
    try {
      await this.loading;
    } catch (error) {
      this.loading = null;
      throw error;
    }
  }

  async loadUserWords() {
    if (!this.userDictPath) {
      return;
    }
    try {
      const raw = await fsp.readFile(this.userDictPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((word) => {
          if (typeof word === "string" && word) {
            this.userWords.add(word);
          }
        });
      }
    } catch {
      // no user dictionary yet
    }
  }

  async saveUserWords() {
    if (!this.userDictPath) {
      return;
    }
    try {
      await fsp.mkdir(path.dirname(this.userDictPath), { recursive: true });
      await fsp.writeFile(this.userDictPath, JSON.stringify(Array.from(this.userWords)), "utf8");
    } catch (error) {
      console.warn("[spell] failed to save user dictionary", error);
    }
  }

  // Returns the subset of `words` that are misspelled.
  async check(words) {
    if (!Array.isArray(words) || words.length === 0) {
      return [];
    }
    await this.ensureLoaded();
    const misspelled = [];
    for (const word of words) {
      if (typeof word === "string" && word && !this.spell.correct(word)) {
        misspelled.push(word);
      }
    }
    return misspelled;
  }

  async suggest(word) {
    if (typeof word !== "string" || !word) {
      return [];
    }
    await this.ensureLoaded();
    return this.spell.suggest(word).slice(0, 8);
  }

  async addWord(word) {
    if (typeof word !== "string" || !word.trim()) {
      return false;
    }
    await this.ensureLoaded();
    const trimmed = word.trim();
    this.spell.add(trimmed);
    this.userWords.add(trimmed);
    await this.saveUserWords();
    return true;
  }
}

module.exports = { SpellService };
