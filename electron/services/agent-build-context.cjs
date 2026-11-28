"use strict";

const ENGINE_LABELS = { lualatex: "LuaLaTeX", pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", uplatex: "upLaTeX" };
const isBuildEngine = (value) => typeof value === "string" && Object.hasOwn(ENGINE_LABELS, value);
const configuredProfiles = (settings) =>
  (Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : []).filter(p => p && typeof p.id === "string" && p.id);

function selectedBuildProfile(settings) {
  const activeId = typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
  const selected = configuredProfiles(settings).find(profile => profile.id === activeId);
  if (!selected) return null;
  const stringOrNull = value => typeof value === "string" && value.trim() ? value.trim() : null;
  const engine = stringOrNull(selected.engine);
  return { outDir: stringOrNull(selected.outDir), extraArgs: stringOrNull(selected.extraArgs), engine: isBuildEngine(engine) ? engine : null };
}

// Only these two project settings are writable through Axiom. In particular,
// a model cannot supply command-line flags or change arbitrary .tex64 state.
function changeBuildSettings(settings, args) {
  if (!args || typeof args !== "object") throw new Error("Provide a profileId or an engine.");
  const hasProfile = args.profileId !== undefined;
  if (hasProfile && typeof args.profileId !== "string") throw new Error("Invalid profileId.");
  if (!hasProfile && args.engine === undefined) throw new Error("Provide a profileId or an engine.");
  if (args.engine !== undefined && !isBuildEngine(args.engine)) throw new Error("Unsupported TeX engine.");
  const profiles = configuredProfiles(settings);
  let id = hasProfile ? args.profileId : settings.buildProfileId || "";
  const profile = profiles.find(p => p.id === id);
  if (id && !profile) throw new Error("That project build profile does not exist.");
  const sameEngine = profile?.engine === args.engine;
  if (args.engine && !sameEngine) {
    if (profile) {
      settings.buildProfiles = settings.buildProfiles.map(p => p === profile ? { ...p, engine: args.engine } : p);
    } else {
      const matching = profiles.find(p => p.engine === args.engine && !p.outDir && !p.extraArgs);
      if (matching) id = matching.id;
      else {
        if (profiles.length >= 20) throw new Error("Choose an existing build profile to change its engine.");
        id = require("node:crypto").randomUUID();
        const existing = Array.isArray(settings.buildProfiles) ? settings.buildProfiles : [];
        settings.buildProfiles = [...existing, { id, name: ENGINE_LABELS[args.engine], engine: args.engine }];
      }
    }
  }
  const changed = id !== (settings.buildProfileId || "") || Boolean(args.engine && !sameEngine);
  if (id) settings.buildProfileId = id;
  else delete settings.buildProfileId;
  return changed;
}

async function readBuildContext(service, context, targetFile) {
  const settings = await service.workspace.loadSettings();
  const root = await service.workspace.rootInfo();
  const profile = selectedBuildProfile(settings);
  return {
    activeFile: context?.activeFilePath || null,
    targetFile: targetFile || null,
    configuredRoot: root?.path || null,
    rootSource: root?.source || null,
    profileId: settings?.buildProfileId || null,
    profiles: configuredProfiles(settings).map(p => ({ id: p.id, name: p.name || p.id, engine: p.engine || null })),
    engine: profile?.engine || (isBuildEngine(context?.appBuildEngine) ? context.appBuildEngine : "lualatex"),
    outDir: profile?.outDir || null,
    extraArgs: profile?.extraArgs || null,
    lastBuild: targetFile ? service.getLastBuild?.(targetFile) ?? null : null,
  };
}

// Build events from the toolbar and from agent tools share the same history.
function createBuildHistory(getRoot, getGeneration) {
  const entries = new Map();
  const keyFor = target => JSON.stringify([getGeneration(), getRoot(), target]);
  return {
    get: target => entries.get(keyFor(target)) || null,
    record(payload, detail) {
      if (!payload.targetFile || payload.workspaceRoot !== getRoot() ||
          (payload.workspaceGeneration != null && payload.workspaceGeneration !== getGeneration())) return;
      const key = keyFor(payload.targetFile);
      entries.delete(key);
      entries.set(key, {
        state: payload.state, summary: payload.message || "", targetFile: payload.targetFile,
        engine: payload.engine || null, pdfPath: payload.state === "success" ? payload.pdfPath || null : null,
        issues: (detail?.issues || payload.issues || []).slice(0, 15).map(({ severity, message, path, line }) => ({ severity, message, path, line })),
        log: typeof detail?.log === "string" ? detail.log.slice(-4000) : null,
      });
      if (entries.size > 24) entries.delete(entries.keys().next().value);
    },
  };
}

module.exports = { isBuildEngine, selectedBuildProfile, changeBuildSettings, readBuildContext, createBuildHistory };
