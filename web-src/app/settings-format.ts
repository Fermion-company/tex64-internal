import {
  DEFAULT_ENV_REGISTRY,
  getEnvBaseName,
  normalizeEnvName,
} from "./env-registry.js";
import type { EnvRegistryApi } from "./env-registry-ui.js";
import type {
  EditorFormatAlignEnvs,
  EditorFormatSettings,
  FormatSettingsPayload,
} from "./types.js";

export const defaultEditorFormatSettings: EditorFormatSettings = {
  enabled: true,
  indentStyle: "spaces-2",
  beginEndOnOwnLine: true,
  documentNoIndent: true,
  alignMathDelims: true,
  alignTableDelims: true,
  blankLines: "condense",
  customVerbatim: [],
};

export const normalizeVerbatimInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const match = trimmed.match(/\\(?:begin|end)\{([^}]+)\}/);
  let name = match ? match[1] : trimmed;
  name = name.replace(/[{}]/g, "");
  name = name.replace(/^\\+/, "");
  return getEnvBaseName(normalizeEnvName(name));
};

export const normalizeEditorVerbatimList = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry) => {
    if (typeof entry !== "string") {
      return;
    }
    const normalized = normalizeVerbatimInput(entry);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    entries.push(normalized);
  });
  return entries;
};

export const normalizeEditorFormatSettings = (value: unknown): EditorFormatSettings => {
  const settings: EditorFormatSettings = {
    ...defaultEditorFormatSettings,
  };
  if (!value || typeof value !== "object") {
    return settings;
  }
  const data = value as Partial<EditorFormatSettings>;
  if (typeof data.enabled === "boolean") {
    settings.enabled = data.enabled;
  }
  if (
    data.indentStyle === "spaces-2" ||
    data.indentStyle === "spaces-4" ||
    data.indentStyle === "tab"
  ) {
    settings.indentStyle = data.indentStyle;
  }
  if (typeof data.beginEndOnOwnLine === "boolean") {
    settings.beginEndOnOwnLine = data.beginEndOnOwnLine;
  }
  if (typeof data.documentNoIndent === "boolean") {
    settings.documentNoIndent = data.documentNoIndent;
  }
  if (typeof data.alignMathDelims === "boolean") {
    settings.alignMathDelims = data.alignMathDelims;
  }
  if (typeof data.alignTableDelims === "boolean") {
    settings.alignTableDelims = data.alignTableDelims;
  }
  if (
    data.blankLines === "preserve" ||
    data.blankLines === "condense" ||
    data.blankLines === "remove"
  ) {
    settings.blankLines = data.blankLines;
  }
  settings.customVerbatim = normalizeEditorVerbatimList(data.customVerbatim);
  return settings;
};

export const buildEditorFormatAlignEnvs = (
  envRegistry: EnvRegistryApi
): EditorFormatAlignEnvs => {
  const math = new Set<string>();
  const table = new Set<string>();
  DEFAULT_ENV_REGISTRY.concat(envRegistry.getCustomEnvRegistry()).forEach((entry) => {
    const base = getEnvBaseName(normalizeEnvName(entry.name));
    if (!base) {
      return;
    }
    if (entry.kind === "table") {
      table.add(base);
    } else {
      math.add(base);
    }
  });
  return {
    math: Array.from(math).sort((a, b) => a.localeCompare(b, "ja")),
    table: Array.from(table).sort((a, b) => a.localeCompare(b, "ja")),
  };
};

export const buildFormatSettingsPayload = (
  editorFormatSettings: EditorFormatSettings,
  envRegistry: EnvRegistryApi
): FormatSettingsPayload => ({
  ...editorFormatSettings,
  alignEnvs: buildEditorFormatAlignEnvs(envRegistry),
});
