"use strict";

// Spell-check service (main process). Wraps nspell + English/German Hunspell
// dictionaries and a persisted user dictionary. The renderer does
// the LaTeX-aware tokenization and sends prose words here to be checked, mirroring
// the math-ocr / texlab service convention.

const fsp = require("fs/promises");
const path = require("path");
const lockfile = require("proper-lockfile");
const { atomicWrite } = require("../history-files.cjs");

class SpellService {
  constructor({ userDataPath } = {}) {
    this.userDataPath = typeof userDataPath === "string" ? userDataPath : "";
    this.userDictPath = this.userDataPath
      ? path.join(this.userDataPath, "tex64-user-dictionary.json")
      : "";
    this.spellers = new Map();
    this.loading = new Map();
    this.userWords = new Set();
    this.userWordsLoading = null;
  }

  normalizeLocale(locale) {
    return typeof locale === "string" && locale.toLowerCase().startsWith("de")
      ? "de"
      : "en";
  }

  async ensureUserWordsLoaded() {
    if (!this.userWordsLoading) {
      this.userWordsLoading = this.loadUserWords();
    }
    await this.userWordsLoading;
  }

  async ensureLoaded(locale = "en") {
    const normalizedLocale = this.normalizeLocale(locale);
    if (this.spellers.has(normalizedLocale)) {
      return this.spellers.get(normalizedLocale);
    }
    if (this.loading.has(normalizedLocale)) {
      return this.loading.get(normalizedLocale);
    }
    const loading = (async () => {
      const nspell = require("nspell");
      const dictionaryModule =
        normalizedLocale === "de"
          ? await import("dictionary-de")
          : await import("dictionary-en");
      const dictionary = dictionaryModule.default || dictionaryModule;
      const spell = nspell(dictionary);
      await this.ensureUserWordsLoaded();
      this.userWords.forEach((word) => spell.add(word));
      this.spellers.set(normalizedLocale, spell);
      return spell;
    })();
    this.loading.set(normalizedLocale, loading);
    try {
      return await loading;
    } catch (error) {
      this.loading.delete(normalizedLocale);
      throw error;
    } finally {
      if (this.spellers.has(normalizedLocale)) {
        this.loading.delete(normalizedLocale);
      }
    }
  }

  async readUserWords() {
    if (!this.userDictPath) return [];
    let raw;
    try {
      raw = await fsp.readFile(this.userDictPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const words = JSON.parse(raw);
    if (!Array.isArray(words) || words.some((word) => typeof word !== "string")) {
      throw new Error("Invalid user dictionary.");
    }
    return words.filter(Boolean).map((word) => word.normalize("NFC"));
  }

  async loadUserWords() {
    try {
      this.userWords = new Set(await this.readUserWords());
    } catch {
      // The built-in dictionaries remain usable. Adding a word retries the
      // read and leaves the file intact if it still cannot be read.
    }
  }

  async saveUserWord(word) {
    if (!this.userDictPath) return [word];
    await fsp.mkdir(path.dirname(this.userDictPath), { recursive: true });
    const release = await lockfile.lock(this.userDictPath, {
      realpath: false,
      retries: { retries: 8, minTimeout: 20, maxTimeout: 250 },
    });
    try {
      // Another TeX64 process may have added words since this one loaded them.
      const words = new Set(await this.readUserWords());
      if (!words.has(word)) {
        words.add(word);
        await atomicWrite(this.userDictPath, JSON.stringify([...words]));
      }
      return words;
    } finally {
      await release();
    }
  }

  // Returns the subset of `words` that are misspelled.
  async check(words, locale = "en") {
    if (!Array.isArray(words) || words.length === 0) {
      return [];
    }
    const spell = await this.ensureLoaded(locale);
    const misspelled = [];
    for (const word of words) {
      if (typeof word === "string" && word && !spell.correct(word.normalize("NFC"))) {
        misspelled.push(word);
      }
    }
    return misspelled;
  }

  async suggest(word, locale = "en") {
    if (typeof word !== "string" || !word) {
      return [];
    }
    const spell = await this.ensureLoaded(locale);
    return spell.suggest(word.normalize("NFC")).slice(0, 8);
  }

  async addWord(word, locale = "en") {
    if (typeof word !== "string" || !word.trim()) {
      return false;
    }
    await this.ensureLoaded(locale);
    const words = await this.saveUserWord(word.trim().normalize("NFC"));
    for (const saved of words) {
      if (this.userWords.has(saved)) continue;
      this.userWords.add(saved);
      this.spellers.forEach((spell) => spell.add(saved));
    }
    return true;
  }
}

module.exports = { SpellService };
