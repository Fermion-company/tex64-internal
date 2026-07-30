"use strict";

// Spell-check service (main process). Wraps nspell + English/German Hunspell
// dictionaries and a persisted user dictionary. The renderer does
// the LaTeX-aware tokenization and sends prose words here to be checked, mirroring
// the math-ocr / texlab service convention.

const fsp = require("fs/promises");
const path = require("path");

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
  async check(words, locale = "en") {
    if (!Array.isArray(words) || words.length === 0) {
      return [];
    }
    const spell = await this.ensureLoaded(locale);
    const misspelled = [];
    for (const word of words) {
      if (typeof word === "string" && word && !spell.correct(word)) {
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
    return spell.suggest(word).slice(0, 8);
  }

  async addWord(word, locale = "en") {
    if (typeof word !== "string" || !word.trim()) {
      return false;
    }
    const activeSpell = await this.ensureLoaded(locale);
    const trimmed = word.trim();
    activeSpell.add(trimmed);
    this.spellers.forEach((spell) => spell.add(trimmed));
    this.userWords.add(trimmed);
    await this.saveUserWords();
    return true;
  }
}

module.exports = { SpellService };
