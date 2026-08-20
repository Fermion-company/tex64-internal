import { DEFAULT_ENV_REGISTRY, getEnvBaseName, normalizeEnvName, } from "./env-registry.js";
export const initEnvRegistry = (context, deps) => {
    const { envRegistryInput, envRegistryKind, envRegistryAdd, envRegistryHint, envRegistryMathList, envRegistryTableList, } = context.dom;
    const CUSTOM_ENV_STORAGE_KEY = "tex64.custom-env-registry";
    const DISABLED_ENV_STORAGE_KEY = "tex64.disabled-env-registry";
    const readEnvRegistryStorage = (baseKey) => {
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
            }
            catch {
                // ignore storage failures
            }
            return legacyValue;
        }
        return null;
    };
    const writeEnvRegistryStorage = (baseKey, value) => {
        if (typeof localStorage === "undefined") {
            return;
        }
        try {
            if (value === null) {
                localStorage.removeItem(baseKey);
            }
            else {
                localStorage.setItem(baseKey, value);
            }
        }
        catch {
            // ignore storage failures
        }
    };
    let customEnvRegistry = [];
    let disabledEnvNames = new Set();
    let mathEnvNames = new Set();
    let tableEnvNames = new Set();
    let envPackageByName = new Map();
    let discouragedEnvNames = new Set();
    const parseCustomEnvEntry = (entry, fallbackKind) => {
        if (typeof entry === "string") {
            const name = normalizeEnvName(entry);
            if (!name) {
                return null;
            }
            return { name, kind: fallbackKind, package: "custom" };
        }
        if (entry && typeof entry === "object") {
            const entryAny = entry;
            if (typeof entryAny.name !== "string") {
                return null;
            }
            const name = normalizeEnvName(entryAny.name);
            if (!name) {
                return null;
            }
            const kind = entryAny.kind === "table" || entryAny.kind === "math"
                ? entryAny.kind
                : fallbackKind;
            const pkg = typeof entryAny.package === "string" ? entryAny.package : "custom";
            const discouraged = entryAny.discouraged === true;
            return { name, kind, package: pkg, discouraged };
        }
        return null;
    };
    const normalizeCustomEnvList = (value, fallbackKind) => {
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
        const entries = [];
        value.forEach((item) => {
            const parsed = parseCustomEnvEntry(item, fallbackKind);
            if (parsed) {
                entries.push(parsed);
            }
        });
        return entries;
    };
    const buildCustomEnvRegistry = (value) => {
        if (Array.isArray(value) || typeof value === "string") {
            return normalizeCustomEnvList(value, "math");
        }
        if (value && typeof value === "object") {
            const payload = value;
            const entries = normalizeCustomEnvList(payload.entries, "math");
            return entries
                .concat(normalizeCustomEnvList(payload.math, "math"))
                .concat(normalizeCustomEnvList(payload.table, "table"));
        }
        return [];
    };
    const parseCustomEnvRegistry = (raw) => {
        if (!raw) {
            return [];
        }
        try {
            return buildCustomEnvRegistry(JSON.parse(raw));
        }
        catch {
            return buildCustomEnvRegistry(raw);
        }
    };
    const normalizeDisabledEnvNames = (names) => names
        .map((name) => getEnvBaseName(normalizeEnvName(name)))
        .filter((name) => name.length > 0);
    const parseDisabledEnvRegistry = (raw) => {
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return normalizeDisabledEnvNames(parsed.filter((name) => typeof name === "string"));
            }
        }
        catch {
            // fall through to CSV parsing
        }
        return normalizeDisabledEnvNames(raw
            .split(/[,\\n]/)
            .map((name) => name.trim())
            .filter(Boolean));
    };
    const loadDisabledEnvRegistry = () => {
        try {
            disabledEnvNames = new Set(parseDisabledEnvRegistry(readEnvRegistryStorage(DISABLED_ENV_STORAGE_KEY)));
        }
        catch {
            disabledEnvNames = new Set();
        }
    };
    const saveDisabledEnvRegistry = () => {
        writeEnvRegistryStorage(DISABLED_ENV_STORAGE_KEY, JSON.stringify(Array.from(disabledEnvNames)));
    };
    const isEnvDisabled = (name) => disabledEnvNames.has(name);
    const rebuildEnvRegistry = () => {
        const math = new Set();
        const table = new Set();
        const packages = new Map();
        const discouraged = new Set();
        DEFAULT_ENV_REGISTRY.concat(customEnvRegistry).forEach((entry) => {
            const base = getEnvBaseName(normalizeEnvName(entry.name));
            if (!base) {
                return;
            }
            if (!isEnvDisabled(base)) {
                if (entry.kind === "table") {
                    table.add(base);
                }
                else {
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
            customEnvRegistry = parseCustomEnvRegistry(readEnvRegistryStorage(CUSTOM_ENV_STORAGE_KEY));
        }
        catch {
            customEnvRegistry = [];
        }
        rebuildEnvRegistry();
    };
    const setCustomEnvRegistry = (value) => {
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
    window.__tex64SetCustomEnvRegistry = setCustomEnvRegistry;
    window
        .__tex64ClearCustomEnvRegistry = clearCustomEnvRegistry;
    window.__tex64GetEnvRegistry = () => ({
        math: Array.from(mathEnvNames),
        table: Array.from(tableEnvNames),
        discouraged: Array.from(discouragedEnvNames),
        packages: Object.fromEntries(envPackageByName),
        disabled: Array.from(disabledEnvNames),
    });
    const getEnvRegistryKey = (entry) => `${entry.kind}:${getEnvBaseName(normalizeEnvName(entry.name))}`;
    const buildEnvRegistryLists = () => {
        const map = new Map();
        const pushEntry = (entry, source) => {
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
        const entries = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
        return {
            math: entries.filter((entry) => entry.kind === "math"),
            table: entries.filter((entry) => entry.kind === "table"),
        };
    };
    const setEnvRegistryHint = (message) => {
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
        const renderRow = (entry) => {
            const row = document.createElement("div");
            row.className = "env-registry-row";
            row.dataset.envName = entry.name;
            row.dataset.envKind = entry.kind;
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = `settings-toggle env-registry-toggle${entry.enabled ? " is-on" : ""}`;
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
                flag.textContent = uiText("Deprecated", "Not recommended");
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
                remove.textContent = uiText("Delete", "削除");
                remove.dataset.envAction = "remove";
                remove.dataset.envName = entry.name;
                remove.dataset.envKind = entry.kind;
                row.appendChild(remove);
            }
            else {
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
    const normalizeEnvInput = (value) => {
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
    const hasRegistryEntry = (name, kind) => {
        const base = getEnvBaseName(normalizeEnvName(name));
        const matches = (entry) => entry.kind === kind &&
            getEnvBaseName(normalizeEnvName(entry.name)) === base;
        return DEFAULT_ENV_REGISTRY.some(matches) || customEnvRegistry.some(matches);
    };
    const hasRegistryEntryInOtherKind = (name, kind) => {
        const base = getEnvBaseName(normalizeEnvName(name));
        const matches = (entry) => entry.kind !== kind &&
            getEnvBaseName(normalizeEnvName(entry.name)) === base;
        return DEFAULT_ENV_REGISTRY.some(matches) || customEnvRegistry.some(matches);
    };
    const toggleEnvRegistryEntry = (name) => {
        const base = getEnvBaseName(normalizeEnvName(name));
        if (!base) {
            return;
        }
        if (disabledEnvNames.has(base)) {
            disabledEnvNames.delete(base);
            setEnvRegistryHint(uiText(`${base} enabled.`, `${base} を有効にしました。`));
        }
        else {
            disabledEnvNames.add(base);
            setEnvRegistryHint(uiText(`${base} disabled.`, `${base} を無効にしました。`));
        }
        saveDisabledEnvRegistry();
        rebuildEnvRegistry();
        handleEnvRegistryUpdate(false);
    };
    const addCustomEnvEntry = (name, kind) => {
        const base = getEnvBaseName(normalizeEnvName(name));
        if (!base) {
            setEnvRegistryHint(uiText("Environment name is empty.", "環境名が空です。"));
            return;
        }
        if (hasRegistryEntryInOtherKind(base, kind)) {
            setEnvRegistryHint(uiText("Already registered in another category.", "既に別カテゴリで登録されています。"));
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
            setEnvRegistryHint(uiText(`${base} added.`, `${base} をadditionしました。`));
            return;
        }
        if (disabledEnvNames.has(base)) {
            disabledEnvNames.delete(base);
            rebuildEnvRegistry();
            handleEnvRegistryUpdate(false);
            setEnvRegistryHint(uiText(`${base} enabled.`, `${base} を有効にしました。`));
            return;
        }
        setEnvRegistryHint(uiText("Already registered.", "既に登録されています。"));
    };
    const removeCustomEnvEntry = (name, kind) => {
        const base = getEnvBaseName(normalizeEnvName(name));
        if (!base) {
            return;
        }
        const next = customEnvRegistry.filter((entry) => !(entry.kind === kind &&
            getEnvBaseName(normalizeEnvName(entry.name)) === base));
        if (next.length === customEnvRegistry.length) {
            return;
        }
        customEnvRegistry = next;
        setCustomEnvRegistry(customEnvRegistry);
        setEnvRegistryHint(uiText(`${base} removed.`, `${base} をDeleteしました。`));
    };
    const handleEnvRegistryListClick = (event) => {
        var _a, _b;
        const target = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest("[data-env-action]");
        if (!target) {
            return;
        }
        const name = (_b = target.dataset.envName) !== null && _b !== void 0 ? _b : "";
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
            const kind = envRegistryKind instanceof HTMLSelectElement &&
                envRegistryKind.value === "table"
                ? "table"
                : "math";
            if (!name) {
                setEnvRegistryHint(uiText("Environment name is empty.", "環境名が空です。"));
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
                envRegistryAdd === null || envRegistryAdd === void 0 ? void 0 : envRegistryAdd.dispatchEvent(new MouseEvent("click"));
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
import { uiText } from "./i18n.js";
