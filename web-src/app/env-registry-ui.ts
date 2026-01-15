import {
  DEFAULT_ENV_REGISTRY,
  getEnvBaseName,
  normalizeEnvName,
  type LatexEnvKind,
  type LatexEnvRegistryEntry,
} from "./env-registry.js";
import type { AppContext } from "./context.js";

export type EnvRegistryApi = {
  isEnvDisabled: (name: string) => boolean;
  isMathEnvName: (name: string) => boolean;
  getCustomEnvRegistry: () => LatexEnvRegistryEntry[];
  reload: (allowTabSwitch?: boolean) => void;
};

type EnvRegistryDeps = {
  getWorkspaceRootKey: () => string | null;
  onRefreshDetectedBlock: (allowTabSwitch?: boolean) => void;
};

export const initEnvRegistry = (
  context: AppContext,
  deps: EnvRegistryDeps
): EnvRegistryApi => {
  const {
    envRegistryInput,
    envRegistryKind,
    envRegistryAdd,
    envRegistryHint,
    envRegistryMathList,
    envRegistryTableList,
  } = context.dom;

  const CUSTOM_ENV_STORAGE_KEY = "tex64.custom-env-registry";
  const DISABLED_ENV_STORAGE_KEY = "tex64.disabled-env-registry";

  const readEnvRegistryStorage = (baseKey: string) => {
    if (typeof localStorage === "undefined") {
      return null;
    }
    const stored = localStorage.getItem(baseKey);
    if (stored !== null) {
      return stored;
    }
    const workspaceRootKey = deps.getWorkspaceRootKey();
    if (!workspaceRootKey) {
      return null;
    }
    const legacyKey = `${baseKey}.${workspaceRootKey}`;
    const legacyValue = localStorage.getItem(legacyKey);
    if (legacyValue !== null) {
      try {
        localStorage.setItem(baseKey, legacyValue);
      } catch {
        // ignore storage failures
      }
      return legacyValue;
    }
    return null;
  };

  const writeEnvRegistryStorage = (baseKey: string, value: string | null) => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      if (value === null) {
        localStorage.removeItem(baseKey);
      } else {
        localStorage.setItem(baseKey, value);
      }
    } catch {
      // ignore storage failures
    }
  };

  let customEnvRegistry: LatexEnvRegistryEntry[] = [];
  let disabledEnvNames = new Set<string>();
  let mathEnvNames = new Set<string>();
  let tableEnvNames = new Set<string>();
  let envPackageByName = new Map<string, string>();
  let discouragedEnvNames = new Set<string>();

  const parseCustomEnvEntry = (
    entry: unknown,
    fallbackKind: LatexEnvKind
  ): LatexEnvRegistryEntry | null => {
    if (typeof entry === "string") {
      const name = normalizeEnvName(entry);
      if (!name) {
        return null;
      }
      return { name, kind: fallbackKind, package: "custom" };
    }
    if (entry && typeof entry === "object") {
      const entryAny = entry as {
        name?: unknown;
        kind?: unknown;
        package?: unknown;
        discouraged?: unknown;
      };
      if (typeof entryAny.name !== "string") {
        return null;
      }
      const name = normalizeEnvName(entryAny.name);
      if (!name) {
        return null;
      }
      const kind =
        entryAny.kind === "table" || entryAny.kind === "math"
          ? entryAny.kind
          : fallbackKind;
      const pkg = typeof entryAny.package === "string" ? entryAny.package : "custom";
      const discouraged = entryAny.discouraged === true;
      return { name, kind, package: pkg, discouraged };
    }
    return null;
  };

  const normalizeCustomEnvList = (
    value: unknown,
    fallbackKind: LatexEnvKind
  ): LatexEnvRegistryEntry[] => {
    if (!value) {
      return [];
    }
    if (typeof value === "string") {
      return value
        .split(/[,\\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((name) => ({ name, kind: fallbackKind, package: "custom" }));
    }
    if (!Array.isArray(value)) {
      return [];
    }
    const entries: LatexEnvRegistryEntry[] = [];
    value.forEach((item) => {
      const parsed = parseCustomEnvEntry(item, fallbackKind);
      if (parsed) {
        entries.push(parsed);
      }
    });
    return entries;
  };

  const buildCustomEnvRegistry = (value: unknown): LatexEnvRegistryEntry[] => {
    if (Array.isArray(value) || typeof value === "string") {
      return normalizeCustomEnvList(value, "math");
    }
    if (value && typeof value === "object") {
      const payload = value as { entries?: unknown; math?: unknown; table?: unknown };
      const entries = normalizeCustomEnvList(payload.entries, "math");
      return entries
        .concat(normalizeCustomEnvList(payload.math, "math"))
        .concat(normalizeCustomEnvList(payload.table, "table"));
    }
    return [];
  };

  const parseCustomEnvRegistry = (raw: string | null): LatexEnvRegistryEntry[] => {
    if (!raw) {
      return [];
    }
    try {
      return buildCustomEnvRegistry(JSON.parse(raw));
    } catch {
      return buildCustomEnvRegistry(raw);
    }
  };

  const normalizeDisabledEnvNames = (names: string[]) =>
    names
      .map((name) => getEnvBaseName(normalizeEnvName(name)))
      .filter((name) => name.length > 0);

  const parseDisabledEnvRegistry = (raw: string | null): string[] => {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return normalizeDisabledEnvNames(
          parsed.filter((name) => typeof name === "string") as string[]
        );
      }
    } catch {
      // fall through to CSV parsing
    }
    return normalizeDisabledEnvNames(
      raw
        .split(/[,\\n]/)
        .map((name) => name.trim())
        .filter(Boolean)
    );
  };

  const loadDisabledEnvRegistry = () => {
    try {
      disabledEnvNames = new Set(
        parseDisabledEnvRegistry(readEnvRegistryStorage(DISABLED_ENV_STORAGE_KEY))
      );
    } catch {
      disabledEnvNames = new Set<string>();
    }
  };

  const saveDisabledEnvRegistry = () => {
    writeEnvRegistryStorage(
      DISABLED_ENV_STORAGE_KEY,
      JSON.stringify(Array.from(disabledEnvNames))
    );
  };

  const isEnvDisabled = (name: string) => disabledEnvNames.has(name);

  const rebuildEnvRegistry = () => {
    const math = new Set<string>();
    const table = new Set<string>();
    const packages = new Map<string, string>();
    const discouraged = new Set<string>();
    DEFAULT_ENV_REGISTRY.concat(customEnvRegistry).forEach((entry) => {
      const base = getEnvBaseName(normalizeEnvName(entry.name));
      if (!base) {
        return;
      }
      if (!isEnvDisabled(base)) {
        if (entry.kind === "table") {
          table.add(base);
        } else {
          math.add(base);
        }
      }
      if (entry.package) {
        packages.set(base, entry.package);
      }
      if (entry.discouraged) {
        discouraged.add(base);
      }
    });
    mathEnvNames = math;
    tableEnvNames = table;
    envPackageByName = packages;
    discouragedEnvNames = discouraged;
  };

  const loadEnvRegistryState = () => {
    loadDisabledEnvRegistry();
    try {
      customEnvRegistry = parseCustomEnvRegistry(
        readEnvRegistryStorage(CUSTOM_ENV_STORAGE_KEY)
      );
    } catch {
      customEnvRegistry = [];
    }
    rebuildEnvRegistry();
  };

  const setCustomEnvRegistry = (value: unknown) => {
    customEnvRegistry = buildCustomEnvRegistry(value);
    rebuildEnvRegistry();
    writeEnvRegistryStorage(CUSTOM_ENV_STORAGE_KEY, JSON.stringify(value));
    handleEnvRegistryUpdate(false);
  };

  const clearCustomEnvRegistry = () => {
    customEnvRegistry = [];
    rebuildEnvRegistry();
    writeEnvRegistryStorage(CUSTOM_ENV_STORAGE_KEY, null);
    handleEnvRegistryUpdate(false);
  };

  loadEnvRegistryState();

  (
    window as {
      __tex64SetCustomEnvRegistry?: (value: unknown) => void;
      __tex64ClearCustomEnvRegistry?: () => void;
      __tex64GetEnvRegistry?: () => {
        math: string[];
        table: string[];
        discouraged: string[];
      };
    }
  ).__tex64SetCustomEnvRegistry = setCustomEnvRegistry;
  (window as { __tex64ClearCustomEnvRegistry?: () => void })
    .__tex64ClearCustomEnvRegistry = clearCustomEnvRegistry;
  (
    window as {
      __tex64GetEnvRegistry?: () => {
        math: string[];
        table: string[];
        discouraged: string[];
        packages: Record<string, string>;
        disabled: string[];
      };
    }
  ).__tex64GetEnvRegistry = () => ({
    math: Array.from(mathEnvNames),
    table: Array.from(tableEnvNames),
    discouraged: Array.from(discouragedEnvNames),
    packages: Object.fromEntries(envPackageByName),
    disabled: Array.from(disabledEnvNames),
  });

  type EnvRegistryUiEntry = {
    name: string;
    kind: LatexEnvKind;
    package: string;
    discouraged: boolean;
    source: "default" | "custom";
    enabled: boolean;
  };

  const getEnvRegistryKey = (entry: { name: string; kind: LatexEnvKind }) =>
    `${entry.kind}:${getEnvBaseName(normalizeEnvName(entry.name))}`;

  const buildEnvRegistryLists = () => {
    const map = new Map<string, EnvRegistryUiEntry>();
    const pushEntry = (
      entry: LatexEnvRegistryEntry,
      source: EnvRegistryUiEntry["source"]
    ) => {
      const base = getEnvBaseName(normalizeEnvName(entry.name));
      if (!base) {
        return;
      }
      const key = `${entry.kind}:${base}`;
      if (map.has(key) && source === "custom") {
        return;
      }
      map.set(key, {
        name: base,
        kind: entry.kind,
        package: entry.package || "custom",
        discouraged: entry.discouraged === true,
        source,
        enabled: !disabledEnvNames.has(base),
      });
    };
    DEFAULT_ENV_REGISTRY.forEach((entry) => pushEntry(entry, "default"));
    customEnvRegistry.forEach((entry) => pushEntry(entry, "custom"));
    const entries = Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return {
      math: entries.filter((entry) => entry.kind === "math"),
      table: entries.filter((entry) => entry.kind === "table"),
    };
  };

  const setEnvRegistryHint = (message: string) => {
    if (envRegistryHint instanceof HTMLElement) {
      envRegistryHint.textContent = message;
    }
  };

  const renderEnvRegistry = () => {
    if (!(envRegistryMathList instanceof HTMLElement)) {
      return;
    }
    if (!(envRegistryTableList instanceof HTMLElement)) {
      return;
    }
    envRegistryMathList.innerHTML = "";
    envRegistryTableList.innerHTML = "";

    const lists = buildEnvRegistryLists();
    const renderRow = (entry: EnvRegistryUiEntry) => {
      const row = document.createElement("div");
      row.className = "env-registry-row";
      row.dataset.envName = entry.name;
      row.dataset.envKind = entry.kind;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `settings-toggle env-registry-toggle${
        entry.enabled ? " is-on" : ""
      }`;
      toggle.textContent = entry.enabled ? "ON" : "OFF";
      toggle.dataset.envAction = "toggle";
      toggle.dataset.envName = entry.name;
      toggle.dataset.envKind = entry.kind;
      toggle.setAttribute("aria-pressed", entry.enabled ? "true" : "false");
      row.appendChild(toggle);

      const label = document.createElement("div");
      label.className = "env-registry-label";

      const name = document.createElement("span");
      name.className = "env-registry-name";
      name.textContent = entry.name;
      label.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "env-registry-meta";
      meta.textContent = entry.package;
      label.appendChild(meta);

      if (entry.discouraged) {
        const flag = document.createElement("span");
        flag.className = "env-registry-flag";
        flag.textContent = "非推奨";
        label.appendChild(flag);
      }
      if (entry.source === "custom") {
        const flag = document.createElement("span");
        flag.className = "env-registry-flag is-custom";
        flag.textContent = "custom";
        label.appendChild(flag);
      }

      row.appendChild(label);

      if (entry.source === "custom") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "panel-button ghost env-registry-remove";
        remove.textContent = "削除";
        remove.dataset.envAction = "remove";
        remove.dataset.envName = entry.name;
        remove.dataset.envKind = entry.kind;
        row.appendChild(remove);
      } else {
        const spacer = document.createElement("div");
        spacer.className = "env-registry-spacer";
        row.appendChild(spacer);
      }

      return row;
    };

    lists.math.forEach((entry) => {
      envRegistryMathList.appendChild(renderRow(entry));
    });
    lists.table.forEach((entry) => {
      envRegistryTableList.appendChild(renderRow(entry));
    });
  };

  const refreshDetectedBlockAfterEnvRegistry = (allowTabSwitch = false) => {
    deps.onRefreshDetectedBlock(allowTabSwitch);
  };

  const handleEnvRegistryUpdate = (allowTabSwitch = false) => {
    renderEnvRegistry();
    refreshDetectedBlockAfterEnvRegistry(allowTabSwitch);
  };

  const normalizeEnvInput = (value: string) => {
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

  const hasRegistryEntry = (name: string, kind: LatexEnvKind) => {
    const base = getEnvBaseName(normalizeEnvName(name));
    const matches = (entry: LatexEnvRegistryEntry) =>
      entry.kind === kind &&
      getEnvBaseName(normalizeEnvName(entry.name)) === base;
    return DEFAULT_ENV_REGISTRY.some(matches) || customEnvRegistry.some(matches);
  };

  const hasRegistryEntryInOtherKind = (name: string, kind: LatexEnvKind) => {
    const base = getEnvBaseName(normalizeEnvName(name));
    const matches = (entry: LatexEnvRegistryEntry) =>
      entry.kind !== kind &&
      getEnvBaseName(normalizeEnvName(entry.name)) === base;
    return DEFAULT_ENV_REGISTRY.some(matches) || customEnvRegistry.some(matches);
  };

  const toggleEnvRegistryEntry = (name: string) => {
    const base = getEnvBaseName(normalizeEnvName(name));
    if (!base) {
      return;
    }
    if (disabledEnvNames.has(base)) {
      disabledEnvNames.delete(base);
      setEnvRegistryHint(`${base} を有効にしました。`);
    } else {
      disabledEnvNames.add(base);
      setEnvRegistryHint(`${base} を無効にしました。`);
    }
    saveDisabledEnvRegistry();
    rebuildEnvRegistry();
    handleEnvRegistryUpdate(false);
  };

  const addCustomEnvEntry = (name: string, kind: LatexEnvKind) => {
    const base = getEnvBaseName(normalizeEnvName(name));
    if (!base) {
      setEnvRegistryHint("環境名が空です。");
      return;
    }
    if (hasRegistryEntryInOtherKind(base, kind)) {
      setEnvRegistryHint("既に別カテゴリで登録されています。");
      return;
    }
    if (!hasRegistryEntry(base, kind)) {
      customEnvRegistry = customEnvRegistry.concat({
        name: base,
        kind,
        package: "custom",
      });
      const removedDisabled = disabledEnvNames.delete(base);
      if (removedDisabled) {
        saveDisabledEnvRegistry();
      }
      setCustomEnvRegistry(customEnvRegistry);
      setEnvRegistryHint(`${base} を追加しました。`);
      return;
    }
    if (disabledEnvNames.has(base)) {
      disabledEnvNames.delete(base);
      rebuildEnvRegistry();
      handleEnvRegistryUpdate(false);
      setEnvRegistryHint(`${base} を有効にしました。`);
      return;
    }
    setEnvRegistryHint("既に登録されています。");
  };

  const removeCustomEnvEntry = (name: string, kind: LatexEnvKind) => {
    const base = getEnvBaseName(normalizeEnvName(name));
    if (!base) {
      return;
    }
    const next = customEnvRegistry.filter(
      (entry) =>
        !(
          entry.kind === kind &&
          getEnvBaseName(normalizeEnvName(entry.name)) === base
        )
    );
    if (next.length === customEnvRegistry.length) {
      return;
    }
    customEnvRegistry = next;
    setCustomEnvRegistry(customEnvRegistry);
    setEnvRegistryHint(`${base} を削除しました。`);
  };

  const handleEnvRegistryListClick = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-env-action]"
    );
    if (!target) {
      return;
    }
    const name = target.dataset.envName ?? "";
    const kind = target.dataset.envKind === "table" ? "table" : "math";
    if (target.dataset.envAction === "toggle") {
      toggleEnvRegistryEntry(name);
      return;
    }
    if (target.dataset.envAction === "remove") {
      removeCustomEnvEntry(name, kind);
    }
  };

  if (envRegistryAdd instanceof HTMLButtonElement) {
    envRegistryAdd.addEventListener("click", () => {
      if (!(envRegistryInput instanceof HTMLInputElement)) {
        return;
      }
      const name = normalizeEnvInput(envRegistryInput.value);
      const kind =
        envRegistryKind instanceof HTMLSelectElement &&
        envRegistryKind.value === "table"
          ? "table"
          : "math";
      if (!name) {
        setEnvRegistryHint("環境名が空です。");
        return;
      }
      addCustomEnvEntry(name, kind);
      envRegistryInput.value = "";
      envRegistryInput.focus();
      envRegistryInput.select();
    });
  }

  if (envRegistryInput instanceof HTMLInputElement) {
    envRegistryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        envRegistryAdd?.dispatchEvent(new MouseEvent("click"));
      }
    });
  }

  if (envRegistryMathList instanceof HTMLElement) {
    envRegistryMathList.addEventListener("click", handleEnvRegistryListClick);
  }

  if (envRegistryTableList instanceof HTMLElement) {
    envRegistryTableList.addEventListener("click", handleEnvRegistryListClick);
  }

  renderEnvRegistry();

  return {
    isEnvDisabled,
    isMathEnvName: (name) => mathEnvNames.has(name),
    getCustomEnvRegistry: () => customEnvRegistry,
    reload: (allowTabSwitch = false) => {
      loadEnvRegistryState();
      handleEnvRegistryUpdate(allowTabSwitch);
    },
  };
};
