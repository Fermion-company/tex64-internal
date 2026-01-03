window.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => {
    document.body.classList.add("is-ready");
  });

  type TabKey = "files" | "outline" | "blocks" | "git" | "search" | "settings";
  type CreateKind = "file" | "folder";
  type DragPayload = { path: string; kind: "file" | "dir" };

  const tabConfig: Record<
    TabKey,
    {
      label: string;
      outline: string;
      title: string;
      desc: string;
      hint: string;
    }
  > = {
    files: {
      label: "ファイル",
      outline: "ミニアウトライン: main.tex",
      title: "編集エリア",
      desc: "Monacoで編集します。",
      hint: "ファイルタブが選択されています。",
    },
    outline: {
      label: "アウトライン",
      outline: "章節 / 図表 / TODO",
      title: "アウトライン",
      desc: "章節や図表、TODO、参照を一覧で表示します。",
      hint: "クリックで定義に移動します。",
    },
    blocks: {
      label: "ブロック",
      outline: "ブロック一覧",
      title: "ブロック",
      desc: "数式と表をブロックとして挿入します。",
      hint: "プレビュー後に確定します。",
    },
    git: {
      label: "Git",
      outline: "Gitステータス",
      title: "Git",
      desc: "変更ファイルの一覧を表示します。",
      hint: "更新で再取得します。",
    },
    search: {
      label: "検索",
      outline: "検索結果",
      title: "検索",
      desc: "ワークスペース内を検索します。",
      hint: "Enterで検索できます。",
    },
    settings: {
      label: "設定",
      outline: "設定",
      title: "設定",
      desc: "最低限の設定を表示します。",
      hint: "自動ビルドはここでも切替可能です。",
    },
  };

  let monacoEditor: unknown = null;
  let diffEditor: unknown = null;
  let diffOriginalModel: { setValue?: (value: string) => void; dispose?: () => void } | null =
    null;
  let diffModifiedModel: { setValue?: (value: string) => void; dispose?: () => void } | null =
    null;
  let monacoApi: Record<string, unknown> | null = null;
  let quickInsertDecorations: string[] = [];
  let quickInsertWidget: {
    getId: () => string;
    getDomNode: () => HTMLElement;
    getPosition: () => unknown;
  } | null = null;
  let quickInsertWidgetNode: HTMLDivElement | null = null;
  let quickInsertWidgetBody: HTMLPreElement | null = null;
  let quickInsertTarget = { lineNumber: 1, column: 1 };

  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]")
  );
  const miniOutline = document.getElementById("mini-outline");
  const editorTitle = document.getElementById("editor-title");
  const editorDesc = document.getElementById("editor-desc");
  const editorHint = document.getElementById("editor-hint");
  const quickInsertButton = document.getElementById("quick-insert-button");
  const quickInsertPanel = document.getElementById("quick-insert");
  const quickInsertTargetLabel = document.getElementById("quick-target");
  const quickInsertInput = document.getElementById("quick-input");
  const quickInsertHint = document.getElementById("quick-hint");
  const quickInsertAccept = document.getElementById("quick-accept");
  const quickInsertCancel = document.getElementById("quick-cancel");
  const buildButton = document.getElementById("build-button");
  const autoBuildButton = document.getElementById("auto-build-button");
  const issuesCount = document.getElementById("issues-count");
  const issuesHint = document.getElementById("issues-hint");
  const issuesBar = document.getElementById("issues-bar");
  const issuesPanel = document.getElementById("issues-panel");
  const issuesList = document.getElementById("issues-list");
  const issuesEmpty = document.getElementById("issues-empty");
  const issuesClose = document.getElementById("issues-close");
  const breadcrumbs = document.getElementById("breadcrumbs");
  const editorTabs = document.getElementById("editor-tabs");
  const editorTabsList = document.getElementById("editor-tabs-list");
  const launcher = document.getElementById("launcher");
  const launcherCreateButton = document.getElementById("launcher-create");
  const launcherOpenButton = document.getElementById("launcher-open");
  const launcherStatus = document.getElementById("launcher-status");
  const launcherStatusText = document.getElementById("launcher-status-text");
  const launcherStatusSpinner = document.getElementById("launcher-status-spinner");
  const launcherTemplateButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".launcher-template-button")
  );
  const sidebarPanels = Array.from(
    document.querySelectorAll<HTMLElement>(".panel[data-panel]")
  );
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const sidebarPanel = document.querySelector<HTMLElement>(".sidebar-panel");
  const outlineEmpty = document.getElementById("outline-empty");
  const outlineSections = document.getElementById("outline-sections");
  const outlineTodos = document.getElementById("outline-todos");
  const outlineLabels = document.getElementById("outline-labels");
  const outlineCitations = document.getElementById("outline-citations");
  const workspaceLabel = document.getElementById("workspace-label");
  const fileTree = document.getElementById("file-tree");
  const saveFileButton = document.getElementById("save-file-button");
  const blockToggleButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".block-toggle-button")
  );
  const blockForms = Array.from(
    document.querySelectorAll<HTMLElement>(".block-form")
  );
  const blockTarget = document.getElementById("block-target");
  let blockMathInput: HTMLElement | null = null;
  let blockMathInputFallback: { value: string } | null = null;
  const blockMathInputContainer = document.getElementById("block-math-input-container");
  const blockMathPreviewWrap = document.getElementById("block-math-preview-wrap");
  const blockMathPreview = document.getElementById("block-math-preview");
  const blockTableRows = document.getElementById("block-table-rows");
  const blockTableCols = document.getElementById("block-table-cols");
  const blockTableGrid = document.getElementById("block-table-grid");
  const blockTableRaw = document.getElementById("block-table-raw");
  const blockTableRawInput = document.getElementById("block-table-raw-input");
  const blockInsertButton = document.getElementById("block-insert-button");
  const blockFormatHint = document.getElementById("block-format-hint");
  const blockTableFormatHint = document.getElementById("block-table-format-hint");
  const blocksPanelBody = document.querySelector<HTMLElement>(".blocks-panel");
  const isE2E = new URLSearchParams(window.location.search).get("e2e") === "1";
  if (isE2E) {
    (
      window as {
        __tex180SetMathInputFallback?: (value: string | null) => void;
        __tex180GetMathInputFallback?: () => string | null;
      }
    ).__tex180SetMathInputFallback = (value) => {
      blockMathInputFallback = typeof value === "string" ? { value } : null;
    };
    (
      window as { __tex180GetMathInputFallback?: () => string | null }
    ).__tex180GetMathInputFallback = () =>
      blockMathInputFallback ? blockMathInputFallback.value : null;
  }
  
  // Context-Aware Editing Types
  // Wrapper type is now implicit in prefix/suffix
  
  type BlockContext = {
    type: "math" | "table";
    originalSnippet: string;
    prefix: string;
    suffix: string;
    envName?: string; // Kept for potential UI usage, but not used for reconstruction
  };

  type DetectedBlockSnapshot = {
    type: BlockType;
    start: number;
    end: number;
    snippet: string;
    context: BlockContext | null;
    modelVersion: number;
  };

  type PendingBlockApply = {
    mode: BlockApplyMode;
    draft: { snippet: string; content: BlockContent };
    detectedSnapshot?: DetectedBlockSnapshot | null;
    insertPosition?: { lineNumber: number; column: number } | null;
  };

  let activeBlockContext: BlockContext | null = null;
  let currentBlockDraft: { snippet: string; content: any } | null = null;
  const diffModal = document.getElementById("diff-modal");
  const diffTitle = document.getElementById("diff-modal-title");
  const diffModalCancel = document.getElementById("diff-modal-cancel");
  const diffModalSubmit = document.getElementById("diff-modal-submit");
  const blockDiffContainer = document.getElementById("block-diff-container");
  const diffSummary = document.getElementById("diff-summary");
  const diffFileName = document.getElementById("diff-file-name");
  const mathKeyboardDock = document.getElementById("math-keyboard-dock");
  const mathKeyboardGrid = document.getElementById("math-keyboard-grid");
  const mathKeyboardFixedGrid = document.getElementById("math-keyboard-fixed-grid");
  const mathKeyboardShiftButton = document.getElementById("math-keyboard-shift");
  const mathKeyboardTabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".math-keyboard-tab")
  );
  const searchInput = document.getElementById("search-input");
  const searchButton = document.getElementById("search-button");
  const searchResults = document.getElementById("search-results");
  const gitStatus = document.getElementById("git-status");
  const gitRefreshButton = document.getElementById("git-refresh");
  const settingsAutoBuildButton = document.getElementById("settings-auto-build");
  const settingsRootSelect = document.getElementById("settings-root-select");
  const settingsRootAuto = document.getElementById("settings-root-auto");
  const settingsWorkspace = document.getElementById("settings-workspace");
  const envRegistryInput = document.getElementById("env-registry-input");
  const envRegistryKind = document.getElementById("env-registry-kind");
  const envRegistryAdd = document.getElementById("env-registry-add");
  const envRegistryHint = document.getElementById("env-registry-hint");
  const envRegistryMathList = document.getElementById("env-registry-math");
  const envRegistryTableList = document.getElementById("env-registry-table");
  const createModal = document.getElementById("create-modal");
  const createModalTitle = document.getElementById("create-modal-title");
  const createModalSubtitle = document.getElementById("create-modal-subtitle");
  const createModalParent = document.getElementById("create-modal-parent");
  const createModalLabel = document.getElementById("create-modal-label");
  const createModalInput = document.getElementById("create-modal-input");
  const createModalHelp = document.getElementById("create-modal-help");
  const createModalCancel = document.getElementById("create-modal-cancel");
  const createModalSubmit = document.getElementById("create-modal-submit");
  const renameModal = document.getElementById("rename-modal");
  const renameModalTitle = document.getElementById("rename-modal-title");
  const renameModalTarget = document.getElementById("rename-modal-target");
  const renameModalInput = document.getElementById("rename-modal-input");
  const renameModalHelp = document.getElementById("rename-modal-help");
  const renameModalCancel = document.getElementById("rename-modal-cancel");
  const renameModalSubmit = document.getElementById("rename-modal-submit");
  const contextMenu = document.getElementById("context-menu");
  const contextMenuPanel = document.getElementById("context-menu-panel");

  const setText = (element: HTMLElement | null, text: string) => {
    if (element) {
      element.textContent = text;
    }
  };

  const setTableEditMode = (mode: "grid" | "raw") => {
    tableEditMode = mode;
    if (blockTableGrid instanceof HTMLElement) {
      blockTableGrid.classList.toggle("is-hidden", mode === "raw");
    }
    if (blockTableRaw instanceof HTMLElement) {
      blockTableRaw.classList.toggle("is-active", mode === "raw");
    }
    if (blockTableFormatHint instanceof HTMLElement) {
      blockTableFormatHint.classList.toggle("is-hidden", mode !== "raw");
    }
  };

  const setAutoDetectedUi = (enabled: boolean, lineNumber?: number) => {
    if (blocksPanelBody instanceof HTMLElement) {
      blocksPanelBody.classList.toggle("is-auto-detected", enabled);
    }
    if (blockFormatHint instanceof HTMLElement) {
      blockFormatHint.classList.toggle("is-hidden", !enabled);
    }
    if (blockTarget instanceof HTMLElement) {
      if (enabled && typeof lineNumber === "number") {
        setText(blockTarget, `自動判定: 行 ${lineNumber}`);
      } else {
        setText(blockTarget, "自動判定: 未検出");
      }
    }
  };

  // ============================================
  // LaTeX Block Auto-Detection
  // ============================================
  type DetectedLatexBlock = {
    type: "math" | "table";
    content: string;
    start: number;
    end: number;
    envName?: string | null;
    inline?: boolean;
    fullMatch?: string;
  };

  let currentDetectedBlock: DetectedLatexBlock | null = null;
  let blockDetectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  type LatexEnvKind = "math" | "table";
  type LatexEnvRegistryEntry = {
    name: string;
    kind: LatexEnvKind;
    package: string;
    discouraged?: boolean;
  };

  const normalizeEnvName = (name: string) => name.trim();

  const getEnvBaseName = (name: string) =>
    name.endsWith("*") ? name.slice(0, -1) : name;

  const DEFAULT_ENV_REGISTRY: LatexEnvRegistryEntry[] = [
    { name: "math", kind: "math", package: "latex" },
    { name: "displaymath", kind: "math", package: "latex" },
    { name: "equation", kind: "math", package: "amsmath" },
    { name: "eqnarray", kind: "math", package: "latex", discouraged: true },
    { name: "align", kind: "math", package: "amsmath" },
    { name: "alignat", kind: "math", package: "amsmath" },
    { name: "xalignat", kind: "math", package: "amsmath" },
    { name: "xxalignat", kind: "math", package: "amsmath" },
    { name: "flalign", kind: "math", package: "amsmath" },
    { name: "gather", kind: "math", package: "amsmath" },
    { name: "multline", kind: "math", package: "amsmath" },
    { name: "split", kind: "math", package: "amsmath" },
    { name: "aligned", kind: "math", package: "amsmath" },
    { name: "alignedat", kind: "math", package: "amsmath" },
    { name: "gathered", kind: "math", package: "amsmath" },
    { name: "multlined", kind: "math", package: "mathtools" },
    { name: "cases", kind: "math", package: "amsmath" },
    { name: "dcases", kind: "math", package: "mathtools" },
    { name: "rcases", kind: "math", package: "mathtools" },
    { name: "numcases", kind: "math", package: "mathtools" },
    { name: "subnumcases", kind: "math", package: "mathtools" },
    { name: "empheq", kind: "math", package: "empheq" },
    { name: "matrix", kind: "math", package: "amsmath" },
    { name: "pmatrix", kind: "math", package: "amsmath" },
    { name: "bmatrix", kind: "math", package: "amsmath" },
    { name: "Bmatrix", kind: "math", package: "amsmath" },
    { name: "vmatrix", kind: "math", package: "amsmath" },
    { name: "Vmatrix", kind: "math", package: "amsmath" },
    { name: "smallmatrix", kind: "math", package: "amsmath" },
    { name: "array", kind: "math", package: "latex" },
    { name: "subarray", kind: "math", package: "amsmath" },
    { name: "substack", kind: "math", package: "amsmath" },
    { name: "subequations", kind: "math", package: "amsmath" },
    { name: "dmath", kind: "math", package: "breqn" },
    { name: "dgroup", kind: "math", package: "breqn" },
    { name: "darray", kind: "math", package: "breqn" },
    { name: "IEEEeqnarray", kind: "math", package: "IEEEtrantools" },
    { name: "IEEEeqnarraybox", kind: "math", package: "IEEEtrantools" },
    { name: "mathpar", kind: "math", package: "mathpartir" },
    { name: "mathparpagebreakable", kind: "math", package: "mathpartir" },
    { name: "table", kind: "table", package: "latex" },
    { name: "tabular", kind: "table", package: "latex" },
    { name: "tabularx", kind: "table", package: "tabularx" },
    { name: "tabulary", kind: "table", package: "tabulary" },
    { name: "longtable", kind: "table", package: "longtable" },
    { name: "ltablex", kind: "table", package: "ltablex" },
    { name: "xltabular", kind: "table", package: "xltabular" },
    { name: "tabu", kind: "table", package: "tabu" },
    { name: "longtabu", kind: "table", package: "tabu" },
    { name: "supertabular", kind: "table", package: "supertabular" },
    { name: "tblr", kind: "table", package: "tabularray" },
    { name: "longtblr", kind: "table", package: "tabularray" },
  ];

  const CUSTOM_ENV_STORAGE_KEY = "tex180.custom-env-registry";
  const DISABLED_ENV_STORAGE_KEY = "tex180.disabled-env-registry";
  let customEnvRegistry: LatexEnvRegistryEntry[] = [];
  let disabledEnvNames = new Set<string>();
  let MATH_ENV_NAMES = new Set<string>();
  let TABLE_ENV_NAMES = new Set<string>();
  let ENV_PACKAGE_BY_NAME = new Map<string, string>();
  let DISCOURAGED_ENV_NAMES = new Set<string>();

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
        parseDisabledEnvRegistry(
          typeof localStorage === "undefined"
            ? null
            : localStorage.getItem(DISABLED_ENV_STORAGE_KEY)
        )
      );
    } catch {
      disabledEnvNames = new Set<string>();
    }
  };

  const saveDisabledEnvRegistry = () => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(
          DISABLED_ENV_STORAGE_KEY,
          JSON.stringify(Array.from(disabledEnvNames))
        );
      }
    } catch {
      // ignore storage failures
    }
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
    MATH_ENV_NAMES = math;
    TABLE_ENV_NAMES = table;
    ENV_PACKAGE_BY_NAME = packages;
    DISCOURAGED_ENV_NAMES = discouraged;
  };

  const loadEnvRegistryState = () => {
    loadDisabledEnvRegistry();
    try {
      customEnvRegistry = parseCustomEnvRegistry(
        typeof localStorage === "undefined"
          ? null
          : localStorage.getItem(CUSTOM_ENV_STORAGE_KEY)
      );
    } catch {
      customEnvRegistry = [];
    }
    rebuildEnvRegistry();
  };

  const setCustomEnvRegistry = (value: unknown) => {
    customEnvRegistry = buildCustomEnvRegistry(value);
    rebuildEnvRegistry();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(CUSTOM_ENV_STORAGE_KEY, JSON.stringify(value));
      }
    } catch {
      // ignore storage failures
    }
    handleEnvRegistryUpdate(false);
  };

  const clearCustomEnvRegistry = () => {
    customEnvRegistry = [];
    rebuildEnvRegistry();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(CUSTOM_ENV_STORAGE_KEY);
      }
    } catch {
      // ignore storage failures
    }
    handleEnvRegistryUpdate(false);
  };

  loadEnvRegistryState();

  (
    window as {
      __tex180SetCustomEnvRegistry?: (value: unknown) => void;
      __tex180ClearCustomEnvRegistry?: () => void;
      __tex180GetEnvRegistry?: () => {
        math: string[];
        table: string[];
        discouraged: string[];
      };
    }
  ).__tex180SetCustomEnvRegistry = setCustomEnvRegistry;
  (window as { __tex180ClearCustomEnvRegistry?: () => void })
    .__tex180ClearCustomEnvRegistry = clearCustomEnvRegistry;
  (
    window as {
      __tex180GetEnvRegistry?: () => {
        math: string[];
        table: string[];
        discouraged: string[];
        packages: Record<string, string>;
        disabled: string[];
      };
    }
  ).__tex180GetEnvRegistry = () => ({
    math: Array.from(MATH_ENV_NAMES),
    table: Array.from(TABLE_ENV_NAMES),
    discouraged: Array.from(DISCOURAGED_ENV_NAMES),
    packages: Object.fromEntries(ENV_PACKAGE_BY_NAME),
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

  function renderEnvRegistry() {
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
  }

  const refreshDetectedBlockAfterEnvRegistry = (allowTabSwitch = false) => {
    if (!monacoEditor) {
      return;
    }
    const editor = monacoEditor as {
      getPosition?: () => { lineNumber: number; column: number } | null;
    };
    const position = editor.getPosition?.() ?? null;
    syncDetectedBlockAtPosition(position, {
      force: true,
      allowTabSwitch,
    });
  };

  function handleEnvRegistryUpdate(allowTabSwitch = false) {
    renderEnvRegistry();
    refreshDetectedBlockAfterEnvRegistry(allowTabSwitch);
  }

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
    return (
      DEFAULT_ENV_REGISTRY.some(matches) || customEnvRegistry.some(matches)
    );
  };

  const hasRegistryEntryInOtherKind = (name: string, kind: LatexEnvKind) => {
    const base = getEnvBaseName(normalizeEnvName(name));
    const matches = (entry: LatexEnvRegistryEntry) =>
      entry.kind !== kind &&
      getEnvBaseName(normalizeEnvName(entry.name)) === base;
    return (
      DEFAULT_ENV_REGISTRY.some(matches) || customEnvRegistry.some(matches)
    );
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

    const alreadyExists = hasRegistryEntry(base, kind);
    let added = false;
    if (!alreadyExists) {
      customEnvRegistry = customEnvRegistry.concat({
        name: base,
        kind,
        package: "custom",
      });
      added = true;
    }

    const removedDisabled = disabledEnvNames.delete(base);
    if (removedDisabled) {
      saveDisabledEnvRegistry();
    }

    if (added) {
      setCustomEnvRegistry(customEnvRegistry);
      setEnvRegistryHint(`${base} を追加しました。`);
      return;
    }
    if (removedDisabled) {
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
    const action = target.dataset.envAction;
    const name = target.dataset.envName;
    const kind = target.dataset.envKind as LatexEnvKind | undefined;
    if (!action || !name || !kind) {
      return;
    }
    if (action === "toggle") {
      toggleEnvRegistryEntry(name);
    }
    if (action === "remove") {
      removeCustomEnvEntry(name, kind);
    }
  };

  const RAW_ENV_NAMES = new Set(["verbatim", "Verbatim", "lstlisting", "minted"]);

  const isEscapedAt = (text: string, index: number) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
      count += 1;
    }
    return count % 2 === 1;
  };

  const MATH_ENV_HINTS = [
    "math",
    "eqn",
    "equation",
    "align",
    "gather",
    "multline",
    "matrix",
    "cases",
    "split",
    "subeq",
    "array",
    "formula",
  ];

  const looksLikeMathEnv = (name: string) => {
    const base = getEnvBaseName(normalizeEnvName(name)).toLowerCase();
    return MATH_ENV_HINTS.some((hint) => base.includes(hint));
  };

  const classifyEnv = (name: string): DetectedLatexBlock["type"] | null => {
    const base = getEnvBaseName(normalizeEnvName(name));
    if (isEnvDisabled(base)) {
      return null;
    }
    if (TABLE_ENV_NAMES.has(base)) {
      return "table";
    }
    if (MATH_ENV_NAMES.has(base)) {
      return "math";
    }
    if (looksLikeMathEnv(base)) {
      return "math";
    }
    return null;
  };

  type MathDelimiterKind = "dollar" | "double-dollar" | "paren" | "bracket";

  const collectLatexBlocks = (text: string): DetectedLatexBlock[] => {
    const blocks: DetectedLatexBlock[] = [];
    const envStack: { name: string; start: number }[] = [];
    const rawEnvStack: string[] = [];
    let openMath: { kind: MathDelimiterKind; start: number } | null = null;

    const pushMathBlock = (start: number, end: number, kind: MathDelimiterKind) => {
      const inline = kind === "dollar" || kind === "paren";
      const openLength = kind === "double-dollar" ? 2 : kind === "dollar" ? 1 : 2;
      const closeLength = kind === "double-dollar" ? 2 : kind === "dollar" ? 1 : 2;
      const contentStart = start + openLength;
      const contentEnd = Math.max(contentStart, end - closeLength);
      const content = text.slice(contentStart, contentEnd);
      blocks.push({
        type: "math",
        content: content.trim(),
        start,
        end,
        inline,
        fullMatch: text.slice(start, end),
      });
    };

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (ch === "%" && !isEscapedAt(text, i)) {
        while (i < text.length && text[i] !== "\n") {
          i += 1;
        }
        continue;
      }

      if (rawEnvStack.length > 0) {
        if (ch === "\\" && !isEscapedAt(text, i) && text.startsWith("\\end{", i)) {
          const endBrace = text.indexOf("}", i + 5);
          if (endBrace !== -1) {
            const name = normalizeEnvName(text.slice(i + 5, endBrace));
            const base = getEnvBaseName(name);
            if (base === rawEnvStack[rawEnvStack.length - 1]) {
              rawEnvStack.pop();
            }
            i = endBrace;
          }
        }
        continue;
      }

      if (ch === "\\" && !isEscapedAt(text, i)) {
        if (text.startsWith("\\begin{", i)) {
          const endBrace = text.indexOf("}", i + 7);
          if (endBrace !== -1) {
            const name = normalizeEnvName(text.slice(i + 7, endBrace));
            const base = getEnvBaseName(name);
            if (RAW_ENV_NAMES.has(base)) {
              rawEnvStack.push(base);
            } else {
              envStack.push({ name, start: i });
            }
            i = endBrace;
            continue;
          }
        }
        if (text.startsWith("\\end{", i)) {
          const endBrace = text.indexOf("}", i + 5);
          if (endBrace !== -1) {
            const name = normalizeEnvName(text.slice(i + 5, endBrace));
            let matchIndex = -1;
            for (let j = envStack.length - 1; j >= 0; j -= 1) {
              if (envStack[j].name === name) {
                matchIndex = j;
                break;
              }
            }
            if (matchIndex >= 0) {
              const { start } = envStack[matchIndex];
              envStack.splice(matchIndex);
              const end = endBrace + 1;
              const type = classifyEnv(name);
              if (type) {
                blocks.push({
                  type,
                  content: "",
                  start,
                  end,
                  envName: name,
                  inline: false,
                  fullMatch: text.slice(start, end),
                });
              }
            }
            i = endBrace;
            continue;
          }
        }
        if (text.startsWith("\\(", i)) {
          if (!openMath) {
            openMath = { kind: "paren", start: i };
          }
          i += 1;
          continue;
        }
        if (text.startsWith("\\)", i)) {
          if (openMath?.kind === "paren") {
            const end = i + 2;
            pushMathBlock(openMath.start, end, openMath.kind);
            openMath = null;
          }
          i += 1;
          continue;
        }
        if (text.startsWith("\\[", i)) {
          if (!openMath) {
            openMath = { kind: "bracket", start: i };
          }
          i += 1;
          continue;
        }
        if (text.startsWith("\\]", i)) {
          if (openMath?.kind === "bracket") {
            const end = i + 2;
            pushMathBlock(openMath.start, end, openMath.kind);
            openMath = null;
          }
          i += 1;
          continue;
        }
      }

      if (ch === "$" && !isEscapedAt(text, i)) {
        const isDouble = text[i + 1] === "$";
        if (!openMath) {
          if (isDouble) {
            openMath = { kind: "double-dollar", start: i };
            i += 1;
          } else {
            openMath = { kind: "dollar", start: i };
          }
          continue;
        }
        if (openMath.kind === "double-dollar" && isDouble) {
          const end = i + 2;
          pushMathBlock(openMath.start, end, openMath.kind);
          openMath = null;
          i += 1;
          continue;
        }
        if (openMath.kind === "dollar" && !isDouble) {
          const end = i + 1;
          pushMathBlock(openMath.start, end, openMath.kind);
          openMath = null;
          continue;
        }
      }
    }

    return blocks;
  };

  const detectLatexBlockAtOffset = (
    text: string,
    offset: number
  ): DetectedLatexBlock | null => {
    const candidates = collectLatexBlocks(text).filter(
      (candidate) => offset >= candidate.start && offset < candidate.end
    );
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      const sizeDiff = (a.end - a.start) - (b.end - b.start);
      if (sizeDiff !== 0) {
        return sizeDiff;
      }
      if (a.type !== b.type) {
        return a.type === "math" ? -1 : 1;
      }
      return a.start - b.start;
    });
    return candidates[0];
  };

  const shouldUpdateDetectedBlock = (detected: DetectedLatexBlock) =>
    !currentDetectedBlock ||
    currentDetectedBlock.start !== detected.start ||
    currentDetectedBlock.end !== detected.end ||
    currentDetectedBlock.fullMatch !== detected.fullMatch;

  const applyDetectedBlock = (
    detected: DetectedLatexBlock,
    text: string,
    model: {
      getPositionAt: (offset: number) => { lineNumber: number; column: number };
      getVersionId?: () => number;
    },
    force = false,
    allowTabSwitch = true
  ) => {
    if (!force && !shouldUpdateDetectedBlock(detected)) {
      return;
    }
    currentDetectedBlock = detected;
    if (
      allowTabSwitch &&
      !document.querySelector('.panel[data-panel="blocks"].is-active')
    ) {
      const blocksTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="blocks"]');
      blocksTab?.click();
    }
    setActiveBlockType(detected.type);
    activeBlockEditMode = "detected";
    currentBlockDraft = null;
    const snippet = detected.fullMatch ?? text.slice(detected.start, detected.end);
    activeBlockOriginalSnippet = snippet;
    activeBlockContext = snippet ? parseBlockContext(snippet) : null;
    detectedBlockSnapshot = {
      type: detected.type,
      start: detected.start,
      end: detected.end,
      snippet,
      context: activeBlockContext,
      modelVersion: typeof model.getVersionId === "function" ? model.getVersionId() : 0,
    };
    const startPos = model.getPositionAt(detected.start);
    setAutoDetectedUi(true, startPos.lineNumber);
    const detectedInner = activeBlockContext ? getInnerContent(activeBlockContext) : detected.content;
    if (detected.type === "math") {
      setMathInputValue(detectedInner);
      setTableEditMode("grid");
    } else {
      setTableEditMode("raw");
      setTableRawValue(detectedInner);
    }
    highlightDetectedBlock(detected.start, detected.end);
  };

  const clearDetectedBlockState = () => {
    if (!currentDetectedBlock) {
      return;
    }
    currentDetectedBlock = null;
    detectedBlockSnapshot = null;
    if (activeBlockEditMode === "detected") {
      activeBlockEditMode = "none";
      activeBlockContext = null;
      activeBlockOriginalSnippet = null;
    }
    setAutoDetectedUi(false);
    setTableEditMode("grid");
    clearBlockHighlight();
  };

  const syncDetectedBlockAtPosition = (
    position: { lineNumber: number; column: number } | null | undefined,
    options?: { force?: boolean; allowTabSwitch?: boolean }
  ) => {
    if (!monacoEditor || !position) {
      return null;
    }
    const editor = monacoEditor as {
      getModel?: () => {
        getValue: () => string;
        getOffsetAt: (pos: { lineNumber: number; column: number }) => number;
        getPositionAt: (offset: number) => { lineNumber: number; column: number };
        getVersionId?: () => number;
      };
    };
    const model = editor.getModel?.();
    if (!model) {
      return null;
    }
    const text = model.getValue();
    const offset = model.getOffsetAt(position);
    const detected = detectLatexBlockAtOffset(text, offset);
    const force = options?.force ?? false;
    const allowTabSwitch = options?.allowTabSwitch ?? true;
    if (detected) {
      applyDetectedBlock(detected, text, model, force, allowTabSwitch);
      return detected;
    }
    clearDetectedBlockState();
    return null;
  };

  const handleCursorPositionChange = (position: { lineNumber: number; column: number }) => {
    if (!monacoEditor) return;
    if (blockDetectionDebounceTimer) {
      clearTimeout(blockDetectionDebounceTimer);
    }
    blockDetectionDebounceTimer = setTimeout(() => {
      syncDetectedBlockAtPosition(position);
    }, 150);
  };

  let blockHighlightDecorations: string[] = [];
  const highlightDetectedBlock = (start: number, end: number) => {
    if (!monacoEditor) return;
    const editor = monacoEditor as {
      getModel?: () => {
        getPositionAt: (offset: number) => { lineNumber: number; column: number };
      };
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    const model = editor.getModel?.();
    if (!model) return;
    const startPos = model.getPositionAt(start);
    const endPos = model.getPositionAt(end);
    blockHighlightDecorations = editor.deltaDecorations(blockHighlightDecorations, [
      {
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        options: {
          className: "detected-block-highlight",
          isWholeLine: true,
          linesDecorationsClassName: "detected-block-line",
          glyphMarginClassName: "detected-block-glyph",
        },
      },
    ]);
  };

  const clearBlockHighlight = () => {
    if (!monacoEditor) return;
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    blockHighlightDecorations = editor.deltaDecorations(blockHighlightDecorations, []);
  };

  const setLauncherVisible = (isVisible: boolean) => {
    if (launcher instanceof HTMLElement) {
      launcher.classList.toggle("is-visible", isVisible);
      launcher.setAttribute("aria-hidden", isVisible ? "false" : "true");
    }
    document.body.classList.toggle("has-launcher", isVisible);
  };

  const updateLauncherTemplate = (template: LauncherTemplate) => {
    launcherTemplate = template;
    launcherTemplateButtons.forEach((button) => {
      const isActive = button.dataset.template === template;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  };

  const setLauncherStatus = (payload: { isBusy?: boolean; message?: string | null }) => {
    if (typeof payload.isBusy === "boolean") {
      launcherBusy = payload.isBusy;
    }
    if (payload.message !== undefined) {
      launcherMessage = payload.message ?? null;
    }
    if (launcherCreateButton instanceof HTMLButtonElement) {
      launcherCreateButton.disabled = launcherBusy;
    }
    if (launcherOpenButton instanceof HTMLButtonElement) {
      launcherOpenButton.disabled = launcherBusy;
    }
    if (!(launcherStatus instanceof HTMLElement) || !(launcherStatusText instanceof HTMLElement)) {
      return;
    }
    if (!launcherBusy && !launcherMessage) {
      launcherStatus.classList.remove("is-visible", "is-busy");
      launcherStatusText.textContent = "";
      return;
    }
    launcherStatus.classList.add("is-visible");
    launcherStatus.classList.toggle("is-busy", launcherBusy);
    launcherStatusText.textContent = launcherBusy ? "準備中..." : launcherMessage ?? "";
    if (launcherStatusSpinner instanceof HTMLElement) {
      launcherStatusSpinner.hidden = !launcherBusy;
    }
  };

  type BuildState = "idle" | "building" | "success" | "failed";
  type IssuesStatus = "success" | "error" | "info";
  type IssueItem = { severity: "error" | "warning"; message: string; line?: number };
  type IndexEntry = { key: string; path: string; line: number };
  type SectionEntry = { title: string; path: string; line: number; level: number };
  type BlockType = "math" | "table";
  type MathKeyboardTab = "analysis" | "algebra" | "sets" | "logic" | "arrows" | "greek";
  type BlockContent = { formula?: string; rows?: number; cols?: number; raw?: string };
  type BlockEditMode = "none" | "detected";
  type BlockApplyMode = "detected" | "new";
  type MathKey = {
    label: string;
    latex: string;
    fallback?: string;
    shiftLabel?: string;
    shiftLatex?: string;
    shiftFallback?: string;
    displayLatex?: string;
    shiftDisplayLatex?: string;
  };
  type SearchResult = { path: string; line: number; preview: string };
  type GitEntry = { status: string; path: string };
  type FileNode = { name: string; path: string; type: "file" | "dir"; children: FileNode[] };
  type RootSource = "auto" | "manual";
  type LauncherTemplate = "paper" | "lecture";

  type WebkitHandler = { postMessage: (message: unknown) => void };
  type WebkitBridge = { messageHandlers?: { tex180?: WebkitHandler } };
  type ElectronBridge = {
    postMessage: (message: unknown) => void;
    onMessage?: (handler: (message: { type: string; payload?: unknown }) => void) => void;
  };
  type BridgeWindow = Window &
    typeof globalThis & {
      webkit?: WebkitBridge;
      tex180Bridge?: ElectronBridge;
      tex180SetBuildState?: (payload: { state: BuildState; message?: string }) => void;
      tex180UpdateIssues?: (payload: {
        count: number;
        summary: string;
        status?: IssuesStatus;
        issues?: IssueItem[];
      }) => void;
      tex180UpdateWorkspace?: (payload: {
        rootName: string;
        rootPath: string;
        files: string[];
        folders?: string[];
        rootFile?: string;
        rootSource?: RootSource;
      }) => void;
      tex180UpdateIndex?: (payload: {
        labels: IndexEntry[];
        references?: IndexEntry[];
        citations: IndexEntry[];
        sections?: SectionEntry[];
        figures?: IndexEntry[];
        tables?: IndexEntry[];
        todos?: IndexEntry[];
      }) => void;
      tex180UpdateSearch?: (payload: {
        query: string;
        results: SearchResult[];
        message?: string;
      }) => void;
      tex180UpdateGit?: (payload: { entries: GitEntry[]; message?: string }) => void;
      tex180OpenFileResult?: (payload: { path: string; content?: string; error?: string }) => void;
      tex180SaveResult?: (payload: { path: string; ok: boolean; error?: string }) => void;
      tex180RenameResult?: (payload: {
        oldPath: string;
        newPath: string;
        isDirectory: boolean;
      }) => void;
    };

  const bridgeWindow = window as BridgeWindow;

  const setIssuesStatus = (status: IssuesStatus) => {
    if (issuesBar instanceof HTMLElement) {
      issuesBar.dataset.status = status;
    }
  };

  let currentIssues: IssueItem[] = [];
  let issuesOpen = false;
  let issueDecorations: string[] = [];
  let indexLabels: IndexEntry[] = [];
  let indexCitations: IndexEntry[] = [];
  let indexSections: SectionEntry[] = [];
  let indexTodos: IndexEntry[] = [];
  let jumpDecorations: string[] = [];
  let pendingReveal: { path: string; line: number } | null = null;
  let completionRegistered = false;
  let workspaceFiles: string[] = [];
  let workspaceFolders: string[] = [];
  let workspaceName = "ワークスペース未選択";
  let workspaceRootKey: string | null = null;
  let rootFilePath: string | null = null;
  let rootSource: RootSource = "auto";
  let launcherTemplate: LauncherTemplate = "paper";
  let launcherBusy = false;
  let launcherMessage: string | null = null;
  let openFolders = new Set<string>();
  let openStateLoaded = false;
  let currentFilePath: string | null = null;
  let currentFileSavedContent: string | null = null;
  let isDirty = false;
  let isApplyingFile = false;
  let selectedTreePath: string | null = null;
  let selectedTreeType: "file" | "dir" | null = null;
  let pendingSave:
    | {
        path: string;
        content: string;
        resolve: (ok: boolean) => void;
        reject: (message: string) => void;
      }
    | null = null;
  let activeBlockType: BlockType = "math";
  let blockPreviewActive = false;
  let activeTab: TabKey = "files";
  let activeMathKeyboardTab: MathKeyboardTab = "analysis";
  let mathKeyboardShiftHeld = false;
  let mathKeyboardShiftLocked = false;
  let mathLiveReady = false;
  let mathLiveCheckScheduled = false;
  let mathKeyboardNeedsRerender = false;
  let activeBlockOriginalSnippet: string | null = null;
  let activeBlockEditMode: BlockEditMode = "none";
  let detectedBlockSnapshot: DetectedBlockSnapshot | null = null;
  let pendingBlockApply: PendingBlockApply | null = null;
  let tableEditMode: "grid" | "raw" = "grid";
  let autoBuildEnabled = false;
  let autoBuildPending = false;
  let searchResultsData: SearchResult[] = [];
  let searchMessage = "検索結果はここに表示します。";
  let lastSearchQuery = "";
  let gitEntries: GitEntry[] = [];
  let gitMessage = "Gitステータスはここに表示します。";
  let pendingAutoOpenPath: string | null = null;
  let createModalKind: CreateKind | null = null;
  let renameTargetPath: string | null = null;
  let renameTargetType: "file" | "dir" | null = null;
  let contextMenuOpen = false;
  let openTabs: string[] = [];
  let dragPayload: DragPayload | null = null;
  let treeHasFocus = false;
  let isComposing = false;
  let compositionText = "";
  let composingFilePath: string | null = null;
  let pendingCompositionAction: (() => void) | null = null;
  let fileClipboard: { path: string; kind: "file" | "dir"; mode: "copy" | "cut" } | null = null;
  type MonacoModel = { getValue: () => string; setValue: (value: string) => void };
  type MonacoModelEntry = { model: MonacoModel; savedContent: string };


  type MonacoViewState = unknown;
  const monacoModels = new Map<string, MonacoModelEntry>();
  const monacoViewStates = new Map<string, MonacoViewState>();
  const dirtyFiles = new Set<string>();

  const setIssuesOpen = (open: boolean) => {
    issuesOpen = open;
    if (issuesPanel instanceof HTMLElement) {
      issuesPanel.classList.toggle("is-open", open);
      issuesPanel.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (issuesBar instanceof HTMLElement) {
      issuesBar.setAttribute("aria-expanded", open ? "true" : "false");
    }
  };

  const clearIssueHighlight = () => {
    if (!monacoEditor || issueDecorations.length === 0) {
      return;
    }
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    issueDecorations = editor.deltaDecorations(issueDecorations, []);
  };

  const focusIssue = (issue: IssueItem) => {
    if (!monacoEditor || !monacoApi || !issue.line) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    const className =
      issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
    issueDecorations = editor.deltaDecorations(issueDecorations, [
      {
        range: new monacoApiAny.Range(issue.line, 1, issue.line, 1),
        options: {
          isWholeLine: true,
          className,
        },
      },
    ]);
    editor.revealLineInCenter(issue.line);
    editor.setPosition({ lineNumber: issue.line, column: 1 });
    editor.focus();
  };

  const clearJumpHighlight = () => {
    if (!monacoEditor || jumpDecorations.length === 0) {
      return;
    }
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    jumpDecorations = editor.deltaDecorations(jumpDecorations, []);
  };

  const revealLine = (line: number) => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    clearJumpHighlight();
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    jumpDecorations = editor.deltaDecorations(jumpDecorations, [
      {
        range: new monacoApiAny.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "jump-line-highlight",
        },
      },
    ]);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  };

  const renderIssues = (issues: IssueItem[]) => {
    currentIssues = issues;
    if (!(issuesList instanceof HTMLElement) || !(issuesEmpty instanceof HTMLElement)) {
      return;
    }
    issuesList.innerHTML = "";
    if (issues.length === 0) {
      issuesList.style.display = "none";
      issuesEmpty.style.display = "block";
      return;
    }
    issuesEmpty.style.display = "none";
    issuesList.style.display = "flex";
    issues.forEach((issue) => {
      const parseIssueMessage = () => {
        const trimmed = issue.message.trim();
        const match =
          trimmed.match(/^(.+?\.tex):(\d+):\s*(.+)$/) ??
          trimmed.match(/^(.+?):(\d+):\s*(.+)$/);
        if (match) {
          const [, path, lineRaw, rest] = match;
          const parsedLine = Number.parseInt(lineRaw, 10);
          return {
            path,
            line: Number.isFinite(parsedLine) ? parsedLine : issue.line ?? null,
            message: rest.trim(),
          };
        }
        return {
          path: null,
          line: issue.line ?? null,
          message: trimmed,
        };
      };

      const detail = parseIssueMessage();

      const item = document.createElement("button");
      item.type = "button";
      item.className = "issue-item";
      item.dataset.severity = issue.severity;

      const header = document.createElement("div");
      header.className = "issue-header";

      const badge = document.createElement("span");
      badge.className = `issue-badge issue-badge-${issue.severity}`;
      badge.textContent = issue.severity === "warning" ? "警告" : "エラー";

      const location = document.createElement("span");
      location.className = "issue-location";
      if (detail.path && detail.line) {
        location.textContent = `${detail.path}:${detail.line}`;
      } else if (detail.path) {
        location.textContent = detail.path;
      } else if (detail.line) {
        location.textContent = `行 ${detail.line}`;
      } else {
        location.textContent = "位置不明";
      }

      header.append(badge, location);

      const message = document.createElement("div");
      message.className = "issue-message";
      message.textContent = detail.message || issue.message;

      const hint = document.createElement("div");
      hint.className = "issue-hintline";
      hint.textContent = "クリックで該当行へ移動";

      item.append(header, message, hint);
      item.addEventListener("click", () => {
        focusIssue(issue);
      });
      issuesList.appendChild(item);
    });
  };

  const dedupeByKey = (entries: IndexEntry[]) => {
    const map = new Map<string, IndexEntry>();
    entries.forEach((entry) => {
      if (!map.has(entry.key)) {
        map.set(entry.key, entry);
      }
    });
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key, "ja"));
  };

  const dedupeSections = (entries: SectionEntry[]) => {
    const map = new Map<string, SectionEntry>();
    entries.forEach((entry) => {
      const token = `${entry.title}|${entry.path}|${entry.line}|${entry.level}`;
      if (!map.has(token)) {
        map.set(token, entry);
      }
    });
    return Array.from(map.values()).sort((a, b) => {
      if (a.path !== b.path) {
        return a.path.localeCompare(b.path, "ja");
      }
      return a.line - b.line;
    });
  };

  const pickCitationEntries = (entries: IndexEntry[]) => {
    const bibEntries = entries.filter((entry) => entry.path.endsWith(".bib"));
    if (bibEntries.length > 0) {
      return dedupeByKey(bibEntries);
    }
    return dedupeByKey(entries);
  };

  const renderOutlineList = (
    container: HTMLElement,
    entries: IndexEntry[],
    kind?: string
  ) => {
    container.innerHTML = "";
    if (entries.length === 0) {
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "outline-item";
      if (kind) {
        item.dataset.kind = kind;
      }

      const key = document.createElement("div");
      key.textContent = entry.key;
      item.append(key);
      item.addEventListener("click", () => {
        jumpToLocation(entry);
      });
      container.appendChild(item);
    });
  };

  const renderSectionList = (container: HTMLElement, entries: SectionEntry[]) => {
    container.innerHTML = "";
    if (entries.length === 0) {
      return;
    }
    const baseLevel = Math.min(...entries.map((entry) => entry.level));
    const counters = new Array(8).fill(0);
    const sectionLabels = ["章", "節", "小節", "項", "小項", "段落", "小段落"];
    entries.forEach((entry) => {
      const depth = Math.max(entry.level - baseLevel, 0);
      counters[depth] += 1;
      for (let i = depth + 1; i < counters.length; i += 1) {
        counters[i] = 0;
      }
      const numberParts = counters.slice(0, depth + 1).filter((value) => value > 0);
      const label = sectionLabels[depth] ?? "節";
      const prefix = `${numberParts.join(".")}${label}`;

      const item = document.createElement("button");
      item.type = "button";
      item.className = "outline-item";
      item.dataset.kind = "section";
      item.style.paddingLeft = `${8 + depth * 12}px`;

      const title = document.createElement("div");
      title.textContent = `${prefix} ${entry.title}`;

      item.append(title);
      item.addEventListener("click", () => {
        jumpToFileLine(entry.path, entry.line);
      });
      container.appendChild(item);
    });
  };

  const filterEntriesForCurrent = <T extends { path: string }>(entries: T[]) => {
    if (!currentFilePath) {
      return [];
    }
    return entries.filter((entry) => entry.path === currentFilePath);
  };

  const renderOutline = () => {
    if (
      !(outlineLabels instanceof HTMLElement) ||
      !(outlineCitations instanceof HTMLElement) ||
      !(outlineSections instanceof HTMLElement) ||
      !(outlineTodos instanceof HTMLElement)
    ) {
      return;
    }
    const sectionEntries = dedupeSections(filterEntriesForCurrent(indexSections));
    const todoEntries = dedupeByKey(filterEntriesForCurrent(indexTodos));
    const labelEntries = dedupeByKey(filterEntriesForCurrent(indexLabels));
    const citationEntries = pickCitationEntries(filterEntriesForCurrent(indexCitations));

    renderSectionList(outlineSections, sectionEntries);
    renderOutlineList(outlineTodos, todoEntries, "todo");
    renderOutlineList(outlineLabels, labelEntries);
    renderOutlineList(outlineCitations, citationEntries);

    if (outlineEmpty instanceof HTMLElement) {
      const hasItems =
        sectionEntries.length > 0 ||
        todoEntries.length > 0 ||
        labelEntries.length > 0 ||
        citationEntries.length > 0;
      outlineEmpty.classList.toggle("is-hidden", hasItems);
      if (!hasItems) {
        outlineEmpty.textContent =
          workspaceRootKey === null
            ? "ワークスペースが未選択です。"
            : currentFilePath === null
            ? "ファイルが未選択です。"
            : "インデックス項目が見つかりません。";
      }
    }
  };

  const mathKeyboardFixedKeys: MathKey[] = [
    { label: "+", latex: "+", shiftLabel: "⊕", shiftLatex: "\\oplus " },
    { label: "−", latex: "-", shiftLabel: "⊖", shiftLatex: "\\ominus " },
    { label: "×", latex: "\\times ", shiftLabel: "⊗", shiftLatex: "\\otimes " },
    { label: "÷", latex: "\\div ", shiftLabel: "⊘", shiftLatex: "\\oslash " },
    { label: "·", latex: "\\cdot ", shiftLabel: "•", shiftLatex: "\\bullet " },
    { label: "=", latex: "=", shiftLabel: "≡", shiftLatex: "\\equiv " },
    { label: "≠", latex: "\\neq ", shiftLabel: "≈", shiftLatex: "\\approx " },
    { label: "≤", latex: "\\leq ", shiftLabel: "≦", shiftLatex: "\\leqq " },
    { label: "≥", latex: "\\geq ", shiftLabel: "≧", shiftLatex: "\\geqq " },
    { label: "<", latex: "<", shiftLabel: "≪", shiftLatex: "\\ll " },
    { label: ">", latex: ">", shiftLabel: "≫", shiftLatex: "\\gg " },
    { label: "±", latex: "\\pm ", shiftLabel: "∓", shiftLatex: "\\mp " },
    {
      label: "sum",
      latex: "\\sum ",
      shiftLabel: "prod",
      shiftLatex: "\\prod ",
      displayLatex: "\\sum",
      shiftDisplayLatex: "\\prod",
    },
    {
      label: "int",
      latex: "\\int ",
      shiftLabel: "int_ab",
      shiftLatex: "\\int_{#?}^{#?}",
      shiftFallback: "\\int_{}^{}",
      displayLatex: "\\int",
      shiftDisplayLatex: "\\int_{a}^{b}",
    },
    {
      label: "∞",
      latex: "\\infty ",
      shiftLabel: "ℵ0",
      shiftLatex: "\\aleph_0 ",
      displayLatex: "\\infty",
      shiftDisplayLatex: "\\aleph_0",
    },
    {
      label: "sqrt",
      latex: "\\sqrt{#?}",
      fallback: "\\sqrt{}",
      shiftLabel: "root",
      shiftLatex: "\\sqrt[#?]{#?}",
      shiftFallback: "\\sqrt[]{}",
      displayLatex: "\\sqrt{x}",
      shiftDisplayLatex: "\\sqrt[n]{x}",
    },
    {
      label: "frac",
      latex: "\\frac{#?}{#?}",
      fallback: "\\frac{}{}",
      shiftLabel: "dfrac",
      shiftLatex: "\\dfrac{#?}{#?}",
      shiftFallback: "\\dfrac{}{}",
      displayLatex: "\\frac{a}{b}",
      shiftDisplayLatex: "\\dfrac{a}{b}",
    },
    {
      label: "pow",
      latex: "^{#?}",
      fallback: "^{}",
      shiftLabel: "x^2",
      shiftLatex: "^{2}",
      displayLatex: "x^{n}",
      shiftDisplayLatex: "x^{2}",
    },
    {
      label: "sub",
      latex: "_{#?}",
      fallback: "_{}",
      shiftLabel: "x_0",
      shiftLatex: "_{0}",
      displayLatex: "x_{n}",
      shiftDisplayLatex: "x_{0}",
    },
    {
      label: "abs",
      latex: "\\left|#?\\right|",
      fallback: "\\left|\\right|",
      shiftLabel: "inner",
      shiftLatex: "\\left\\langle#?\\right\\rangle",
      shiftFallback: "\\left\\langle\\right\\rangle",
      displayLatex: "\\left|x\\right|",
      shiftDisplayLatex: "\\langle x, y \\rangle",
    },
    {
      label: "sin",
      latex: "\\sin ",
      shiftLabel: "arcsin",
      shiftLatex: "\\arcsin ",
      displayLatex: "\\sin",
      shiftDisplayLatex: "\\arcsin",
    },
    {
      label: "cos",
      latex: "\\cos ",
      shiftLabel: "arccos",
      shiftLatex: "\\arccos ",
      displayLatex: "\\cos",
      shiftDisplayLatex: "\\arccos",
    },
    {
      label: "tan",
      latex: "\\tan ",
      shiftLabel: "arctan",
      shiftLatex: "\\arctan ",
      displayLatex: "\\tan",
      shiftDisplayLatex: "\\arctan",
    },
    {
      label: "log",
      latex: "\\log ",
      shiftLabel: "log_b",
      shiftLatex: "\\log_{#?}",
      shiftFallback: "\\log_{}",
      displayLatex: "\\log",
      shiftDisplayLatex: "\\log_{b}",
    },
    { label: "ln", latex: "\\ln ", shiftLabel: "lg", shiftLatex: "\\lg ", displayLatex: "\\ln", shiftDisplayLatex: "\\lg" },
    {
      label: "exp",
      latex: "\\exp ",
      shiftLabel: "e^",
      shiftLatex: "e^{#?}",
      shiftFallback: "e^{}",
      displayLatex: "\\exp",
      shiftDisplayLatex: "e^{x}",
    },
    {
      label: "lim",
      latex: "\\lim ",
      shiftLabel: "lim→",
      shiftLatex: "\\lim_{#? \\to #?}",
      shiftFallback: "\\lim_{}",
      displayLatex: "\\lim",
      shiftDisplayLatex: "\\lim_{x \\to a}",
    },
    { label: "→", latex: "\\to ", shiftLabel: "⇒", shiftLatex: "\\Rightarrow " },
    {
      label: "∂",
      latex: "\\partial ",
      shiftLabel: "d",
      shiftLatex: "\\mathrm{d} ",
      displayLatex: "\\partial",
      shiftDisplayLatex: "\\mathrm{d}",
    },
    {
      label: "∇",
      latex: "\\nabla ",
      shiftLabel: "Δ",
      shiftLatex: "\\Delta ",
      displayLatex: "\\nabla",
      shiftDisplayLatex: "\\Delta",
    },
  ];

  const mathKeyboardSets: Record<MathKeyboardTab, MathKey[]> = {
    analysis: [
      {
        label: "d/dx",
        latex: "\\frac{d}{d#?}#?",
        fallback: "\\frac{d}{d} ",
        shiftLabel: "d2/dx2",
        shiftLatex: "\\frac{d^2}{d#?^2}#?",
        shiftFallback: "\\frac{d^2}{d^2} ",
        displayLatex: "\\frac{d}{dx}",
        shiftDisplayLatex: "\\frac{d^2}{dx^2}",
      },
      {
        label: "∂/∂x",
        latex: "\\frac{\\partial}{\\partial #?}#?",
        fallback: "\\frac{\\partial}{\\partial} ",
        shiftLabel: "∂2/∂x2",
        shiftLatex: "\\frac{\\partial^2}{\\partial #?^2}#?",
        shiftFallback: "\\frac{\\partial^2}{\\partial^2} ",
        displayLatex: "\\frac{\\partial}{\\partial x}",
        shiftDisplayLatex: "\\frac{\\partial^2}{\\partial x^2}",
      },
      {
        label: "∮",
        latex: "\\oint ",
        shiftLabel: "∮_C",
        shiftLatex: "\\oint_{#?}",
        shiftFallback: "\\oint_{}",
        displayLatex: "\\oint",
        shiftDisplayLatex: "\\oint_{C}",
      },
      {
        label: "∬",
        latex: "\\iint ",
        shiftLabel: "∭",
        shiftLatex: "\\iiint ",
        displayLatex: "\\iint",
        shiftDisplayLatex: "\\iiint",
      },
      {
        label: "lim sup",
        latex: "\\limsup ",
        shiftLabel: "lim inf",
        shiftLatex: "\\liminf ",
        displayLatex: "\\limsup",
        shiftDisplayLatex: "\\liminf",
      },
      {
        label: "sup",
        latex: "\\sup ",
        shiftLabel: "inf",
        shiftLatex: "\\inf ",
        displayLatex: "\\sup",
        shiftDisplayLatex: "\\inf",
      },
      {
        label: "max",
        latex: "\\max ",
        shiftLabel: "min",
        shiftLatex: "\\min ",
        displayLatex: "\\max",
        shiftDisplayLatex: "\\min",
      },
      {
        label: "≈",
        latex: "\\approx ",
        shiftLabel: "∼",
        shiftLatex: "\\sim ",
        displayLatex: "\\approx",
        shiftDisplayLatex: "\\sim",
      },
      {
        label: "≃",
        latex: "\\simeq ",
        shiftLabel: "≅",
        shiftLatex: "\\cong ",
        displayLatex: "\\simeq",
        shiftDisplayLatex: "\\cong",
      },
      {
        label: "O",
        latex: "\\mathcal{O} ",
        shiftLabel: "o",
        shiftLatex: "\\mathrm{o} ",
        displayLatex: "\\mathcal{O}",
        shiftDisplayLatex: "\\mathrm{o}",
      },
      {
        label: "ℒ",
        latex: "\\mathcal{L} ",
        shiftLabel: "ℓ",
        shiftLatex: "\\ell ",
        displayLatex: "\\mathcal{L}",
        shiftDisplayLatex: "\\ell",
      },
      {
        label: "ℱ",
        latex: "\\mathcal{F} ",
        shiftLabel: "ℳ",
        shiftLatex: "\\mathcal{M} ",
        displayLatex: "\\mathcal{F}",
        shiftDisplayLatex: "\\mathcal{M}",
      },
    ],
    algebra: [
      {
        label: "⌊x⌋",
        latex: "\\left\\lfloor#?\\right\\rfloor",
        fallback: "\\left\\lfloor\\right\\rfloor",
        shiftLabel: "⌈x⌉",
        shiftLatex: "\\left\\lceil#?\\right\\rceil",
        shiftFallback: "\\left\\lceil\\right\\rceil",
        displayLatex: "\\lfloor x \\rfloor",
        shiftDisplayLatex: "\\lceil x \\rceil",
      },
      {
        label: "binom",
        latex: "\\binom{#?}{#?}",
        fallback: "\\binom{}{}",
        displayLatex: "\\binom{n}{k}",
      },
      {
        label: "cases",
        latex: "\\begin{cases}#?\\\\#?\\end{cases}",
        fallback: "\\begin{cases}\n  \\\\\n\\end{cases}",
        displayLatex: "\\begin{cases} a \\\\ b \\end{cases}",
      },
      {
        label: "matrix",
        latex: "\\begin{matrix}#?\\\\#?\\end{matrix}",
        fallback: "\\begin{matrix}\n  & \\\\\n  & \n\\end{matrix}",
        shiftLabel: "pmatrix",
        shiftLatex: "\\begin{pmatrix}#?\\\\#?\\end{pmatrix}",
        shiftFallback: "\\begin{pmatrix}\n  & \\\\\n  & \n\\end{pmatrix}",
        displayLatex: "\\begin{matrix} a & b \\\\ c & d \\end{matrix}",
        shiftDisplayLatex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
      },
      {
        label: "bmatrix",
        latex: "\\begin{bmatrix}#?\\\\#?\\end{bmatrix}",
        fallback: "\\begin{bmatrix}\n  & \\\\\n  & \n\\end{bmatrix}",
        shiftLabel: "vmatrix",
        shiftLatex: "\\begin{vmatrix}#?\\\\#?\\end{vmatrix}",
        shiftFallback: "\\begin{vmatrix}\n  & \\\\\n  & \n\\end{vmatrix}",
        displayLatex: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
        shiftDisplayLatex: "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}",
      },
      { label: "det", latex: "\\det ", shiftLabel: "adj", shiftLatex: "\\operatorname{adj} " },
      { label: "tr", latex: "\\operatorname{tr} ", shiftLabel: "diag", shiftLatex: "\\operatorname{diag} " },
      { label: "rank", latex: "\\operatorname{rank} ", shiftLabel: "null", shiftLatex: "\\operatorname{null} " },
      { label: "dim", latex: "\\dim ", shiftLabel: "deg", shiftLatex: "\\deg " },
      { label: "ker", latex: "\\ker ", shiftLabel: "span", shiftLatex: "\\operatorname{span} " },
      {
        label: "gcd",
        latex: "\\gcd ",
        shiftLabel: "lcm",
        shiftLatex: "\\operatorname{lcm} ",
      },
      {
        label: "mod",
        latex: "\\bmod ",
        shiftLabel: "mod",
        shiftLatex: "\\pmod{#?}",
        shiftFallback: "\\pmod{}",
      },
      {
        label: "vec",
        latex: "\\vec{#?}",
        fallback: "\\vec{}",
        shiftLabel: "over→",
        shiftLatex: "\\overrightarrow{#?}",
        shiftFallback: "\\overrightarrow{}",
      },
      {
        label: "hat",
        latex: "\\hat{#?}",
        fallback: "\\hat{}",
        shiftLabel: "tilde",
        shiftLatex: "\\tilde{#?}",
        shiftFallback: "\\tilde{}",
      },
      {
        label: "bar",
        latex: "\\bar{#?}",
        fallback: "\\bar{}",
        shiftLabel: "overline",
        shiftLatex: "\\overline{#?}",
        shiftFallback: "\\overline{}",
      },
      {
        label: "dot",
        latex: "\\dot{#?}",
        fallback: "\\dot{}",
        shiftLabel: "ddot",
        shiftLatex: "\\ddot{#?}",
        shiftFallback: "\\ddot{}",
      },
      {
        label: "bold",
        latex: "\\mathbf{#?}",
        fallback: "\\mathbf{}",
        shiftLabel: "boldsym",
        shiftLatex: "\\boldsymbol{#?}",
        shiftFallback: "\\boldsymbol{}",
      },
      {
        label: "bb",
        latex: "\\mathbb{#?}",
        fallback: "\\mathbb{}",
        shiftLabel: "frak",
        shiftLatex: "\\mathfrak{#?}",
        shiftFallback: "\\mathfrak{}",
      },
      {
        label: "cal",
        latex: "\\mathcal{#?}",
        fallback: "\\mathcal{}",
        shiftLabel: "scr",
        shiftLatex: "\\mathscr{#?}",
        shiftFallback: "\\mathscr{}",
      },
      {
        label: "text",
        latex: "\\text{#?}",
        fallback: "\\text{}",
        shiftLabel: "rm",
        shiftLatex: "\\mathrm{#?}",
        shiftFallback: "\\mathrm{}",
      },
    ],
    sets: [
      { label: "∈", latex: "\\in ", shiftLabel: "∉", shiftLatex: "\\notin " },
      { label: "∋", latex: "\\ni ", shiftLabel: "∌", shiftLatex: "\\not\\ni " },
      { label: "⊂", latex: "\\subset ", shiftLabel: "⊆", shiftLatex: "\\subseteq " },
      { label: "⊃", latex: "\\supset ", shiftLabel: "⊇", shiftLatex: "\\supseteq " },
      { label: "⊊", latex: "\\subsetneq ", shiftLabel: "⊋", shiftLatex: "\\supsetneq " },
      { label: "∪", latex: "\\cup ", shiftLabel: "∩", shiftLatex: "\\cap " },
      { label: "⋃", latex: "\\bigcup ", shiftLabel: "⋂", shiftLatex: "\\bigcap " },
      { label: "∅", latex: "\\emptyset ", shiftLabel: "⌀", shiftLatex: "\\varnothing " },
      { label: "∖", latex: "\\setminus ", shiftLabel: "△", shiftLatex: "\\triangle " },
      {
        label: "{x|}",
        latex: "\\{#?\\mid#?\\}",
        fallback: "\\{\\mid\\}",
        displayLatex: "\\{x \\mid y\\}",
      },
      { label: "℘", latex: "\\mathcal{P} ", shiftLabel: "ℱ", shiftLatex: "\\mathcal{F} " },
      { label: "ℕ", latex: "\\mathbb{N} ", shiftLabel: "ℤ", shiftLatex: "\\mathbb{Z} " },
      { label: "ℚ", latex: "\\mathbb{Q} ", shiftLabel: "ℝ", shiftLatex: "\\mathbb{R} " },
      { label: "ℂ", latex: "\\mathbb{C} ", shiftLabel: "ℍ", shiftLatex: "\\mathbb{H} " },
      { label: "⟂", latex: "\\perp ", shiftLabel: "∥", shiftLatex: "\\parallel " },
    ],
    logic: [
      { label: "∀", latex: "\\forall ", shiftLabel: "∃", shiftLatex: "\\exists " },
      { label: "¬", latex: "\\neg ", shiftLabel: "¬¬", shiftLatex: "\\neg\\neg " },
      { label: "∧", latex: "\\land ", shiftLabel: "∨", shiftLatex: "\\lor " },
      { label: "⇒", latex: "\\Rightarrow ", shiftLabel: "⇔", shiftLatex: "\\Leftrightarrow " },
      { label: "⇐", latex: "\\Leftarrow " },
      { label: "⊢", latex: "\\vdash ", shiftLabel: "⊨", shiftLatex: "\\models " },
      { label: "⊥", latex: "\\bot ", shiftLabel: "⊤", shiftLatex: "\\top " },
      { label: "≡", latex: "\\equiv ", shiftLabel: "≢", shiftLatex: "\\not\\equiv " },
      { label: "⊕", latex: "\\oplus ", shiftLabel: "⊗", shiftLatex: "\\otimes " },
      { label: "∴", latex: "\\therefore ", shiftLabel: "∵", shiftLatex: "\\because " },
      { label: "□", latex: "\\Box ", shiftLabel: "◇", shiftLatex: "\\Diamond " },
      { label: "∃!", latex: "\\exists!", shiftLabel: "∄", shiftLatex: "\\not\\exists " },
      { label: "⊂", latex: "\\subset ", shiftLabel: "⊆", shiftLatex: "\\subseteq " },
    ],
    arrows: [
      { label: "←", latex: "\\leftarrow ", shiftLabel: "⇐", shiftLatex: "\\Leftarrow " },
      { label: "↔", latex: "\\leftrightarrow ", shiftLabel: "⇔", shiftLatex: "\\Leftrightarrow " },
      { label: "↦", latex: "\\mapsto ", shiftLabel: "⟼", shiftLatex: "\\longmapsto " },
      {
        label: "⟶",
        latex: "\\longrightarrow ",
        shiftLabel: "⟹",
        shiftLatex: "\\Longrightarrow ",
      },
      {
        label: "⟵",
        latex: "\\longleftarrow ",
        shiftLabel: "⟸",
        shiftLatex: "\\Longleftarrow ",
      },
      {
        label: "⟷",
        latex: "\\longleftrightarrow ",
        shiftLabel: "⟺",
        shiftLatex: "\\Longleftrightarrow ",
      },
      { label: "↑", latex: "\\uparrow ", shiftLabel: "⇑", shiftLatex: "\\Uparrow " },
      { label: "↓", latex: "\\downarrow ", shiftLabel: "⇓", shiftLatex: "\\Downarrow " },
      {
        label: "↕",
        latex: "\\updownarrow ",
        shiftLabel: "⇕",
        shiftLatex: "\\Updownarrow ",
      },
      { label: "↗", latex: "\\nearrow ", shiftLabel: "↘", shiftLatex: "\\searrow " },
      { label: "↖", latex: "\\nwarrow ", shiftLabel: "↙", shiftLatex: "\\swarrow " },
      {
        label: "↪",
        latex: "\\hookrightarrow ",
        shiftLabel: "↩",
        shiftLatex: "\\hookleftarrow ",
      },
      {
        label: "↠",
        latex: "\\twoheadrightarrow ",
        shiftLabel: "↞",
        shiftLatex: "\\twoheadleftarrow ",
      },
      {
        label: "⇝",
        latex: "\\rightsquigarrow ",
        shiftLabel: "⇜",
        shiftLatex: "\\leftsquigarrow ",
      },
      {
        label: "⤳",
        latex: "\\curvearrowright ",
        shiftLabel: "⤲",
        shiftLatex: "\\curvearrowleft ",
      },
      {
        label: "⇀",
        latex: "\\rightharpoonup ",
        shiftLabel: "⇁",
        shiftLatex: "\\rightharpoondown ",
      },
      {
        label: "↼",
        latex: "\\leftharpoonup ",
        shiftLabel: "↽",
        shiftLatex: "\\leftharpoondown ",
      },
      {
        label: "⇉",
        latex: "\\rightrightarrows ",
        shiftLabel: "⇇",
        shiftLatex: "\\leftleftarrows ",
      },
    ],
    greek: [
      { label: "α", latex: "\\alpha ", shiftLabel: "Α", shiftLatex: "A " },
      { label: "β", latex: "\\beta ", shiftLabel: "Β", shiftLatex: "B " },
      { label: "γ", latex: "\\gamma ", shiftLabel: "Γ", shiftLatex: "\\Gamma " },
      { label: "δ", latex: "\\delta ", shiftLabel: "Δ", shiftLatex: "\\Delta " },
      { label: "ε", latex: "\\epsilon ", shiftLabel: "Ε", shiftLatex: "E " },
      { label: "ϵ", latex: "\\varepsilon ", shiftLabel: "Ε", shiftLatex: "E " },
      { label: "ζ", latex: "\\zeta ", shiftLabel: "Ζ", shiftLatex: "Z " },
      { label: "η", latex: "\\eta ", shiftLabel: "Η", shiftLatex: "H " },
      { label: "θ", latex: "\\theta ", shiftLabel: "Θ", shiftLatex: "\\Theta " },
      { label: "ϑ", latex: "\\vartheta ", shiftLabel: "Θ", shiftLatex: "\\Theta " },
      { label: "ι", latex: "\\iota ", shiftLabel: "Ι", shiftLatex: "I " },
      { label: "κ", latex: "\\kappa ", shiftLabel: "Κ", shiftLatex: "K " },
      { label: "λ", latex: "\\lambda ", shiftLabel: "Λ", shiftLatex: "\\Lambda " },
      { label: "μ", latex: "\\mu ", shiftLabel: "Μ", shiftLatex: "M " },
      { label: "ν", latex: "\\nu ", shiftLabel: "Ν", shiftLatex: "N " },
      { label: "ξ", latex: "\\xi ", shiftLabel: "Ξ", shiftLatex: "\\Xi " },
      { label: "π", latex: "\\pi ", shiftLabel: "Π", shiftLatex: "\\Pi " },
      { label: "ϖ", latex: "\\varpi ", shiftLabel: "Π", shiftLatex: "\\Pi " },
      { label: "ρ", latex: "\\rho ", shiftLabel: "Ρ", shiftLatex: "P " },
      { label: "ϱ", latex: "\\varrho ", shiftLabel: "Ρ", shiftLatex: "P " },
      { label: "σ", latex: "\\sigma ", shiftLabel: "Σ", shiftLatex: "\\Sigma " },
      { label: "ς", latex: "\\varsigma ", shiftLabel: "Σ", shiftLatex: "\\Sigma " },
      { label: "τ", latex: "\\tau ", shiftLabel: "Τ", shiftLatex: "T " },
      { label: "υ", latex: "\\upsilon ", shiftLabel: "Υ", shiftLatex: "\\Upsilon " },
      { label: "φ", latex: "\\phi ", shiftLabel: "Φ", shiftLatex: "\\Phi " },
      { label: "ϕ", latex: "\\varphi ", shiftLabel: "Φ", shiftLatex: "\\Phi " },
      { label: "χ", latex: "\\chi ", shiftLabel: "Χ", shiftLatex: "X " },
      { label: "ψ", latex: "\\psi ", shiftLabel: "Ψ", shiftLatex: "\\Psi " },
      { label: "ω", latex: "\\omega ", shiftLabel: "Ω", shiftLatex: "\\Omega " },
    ],
  };

  const normalizeMathKeyboardTab = (tab?: string | null): MathKeyboardTab => {
    if (
      tab === "analysis" ||
      tab === "algebra" ||
      tab === "sets" ||
      tab === "logic" ||
      tab === "arrows" ||
      tab === "greek"
    ) {
      return tab;
    }
    return "analysis";
  };

  const isMathKeyboardShiftActive = () => mathKeyboardShiftHeld || mathKeyboardShiftLocked;

  const markMathLiveReady = () => {
    if (mathLiveReady) {
      return;
    }
    mathLiveReady = true;
    mathLiveCheckScheduled = false;
    if (mathKeyboardNeedsRerender) {
      renderMathKeyboard(activeMathKeyboardTab);
      renderMathKeyboardFixed();
      mathKeyboardNeedsRerender = false;
    }
  };

  const ensureMathLiveReady = () => {
    if (mathLiveReady || mathLiveCheckScheduled) {
      return;
    }
    mathLiveCheckScheduled = true;
    const check = () => {
      if (mathLiveReady) {
        return;
      }
      const MathLiveGlobal = (window as any).MathLive;
      if (MathLiveGlobal?.convertLatexToMarkup) {
        markMathLiveReady();
        return;
      }
      setTimeout(check, 120);
    };
    check();
    window.addEventListener("mathlive-ready", markMathLiveReady, { once: true });
  };

  const resolveMathKey = (key: MathKey, shiftActive: boolean): MathKey => {
    if (!shiftActive) {
      return key;
    }
    const hasShift = key.shiftLabel || key.shiftLatex || key.shiftFallback || key.shiftDisplayLatex;
    if (!hasShift) {
      return key;
    }
    return {
      label: key.shiftLabel ?? key.label,
      latex: key.shiftLatex ?? key.latex,
      fallback: key.shiftFallback ?? key.fallback,
      displayLatex: key.shiftDisplayLatex ?? key.displayLatex,
    };
  };

  const buildMathKeyDisplayLatex = (key: MathKey) => {
    const source = key.displayLatex ?? key.latex ?? key.fallback;
    if (!source) {
      return null;
    }
    const placeholders = ["x", "y", "z", "a", "b", "c"];
    let index = 0;
    return source.replace(/#\?/g, () => {
      const value = placeholders[index] ?? "x";
      index += 1;
      return value;
    });
  };

  const renderMathKeyLabel = (button: HTMLButtonElement, key: MathKey) => {
    const MathLiveGlobal = (window as any).MathLive;
    const displayLatex = buildMathKeyDisplayLatex(key);
    if (displayLatex && MathLiveGlobal?.convertLatexToMarkup) {
      try {
        const latexToRender = `\\displaystyle ${displayLatex}`;
        const wrapper = document.createElement("span");
        wrapper.className = "math-keyboard-math";
        wrapper.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
        button.textContent = "";
        button.appendChild(wrapper);
        button.classList.add("has-math");
        button.setAttribute("aria-label", key.label);
        return;
      } catch (error) {
        console.warn("MathLive render failed:", error);
      }
    }
    if (displayLatex) {
      mathKeyboardNeedsRerender = true;
      ensureMathLiveReady();
    }
    button.classList.remove("has-math");
    button.textContent = key.label;
    button.removeAttribute("aria-label");
  };

  const renderMathKeyboardKeys = (target: HTMLElement | null, keys: MathKey[]) => {
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const shiftActive = isMathKeyboardShiftActive();
    target.innerHTML = "";
    keys.forEach((key) => {
      const resolved = resolveMathKey(key, shiftActive);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "math-keyboard-key";
      renderMathKeyLabel(button, resolved);
      if (!button.classList.contains("has-math")) {
        const labelLength = Array.from(resolved.label).length;
        if (labelLength > 4) {
          button.classList.add("is-compact");
        }
        if (labelLength > 7) {
          button.classList.add("is-tiny");
        }
      }
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", () => {
        insertMathKey(resolved);
        if (blockMathInput instanceof HTMLElement) {
          (blockMathInput as HTMLElement & { focus?: () => void }).focus?.();
        }
      });
      target.appendChild(button);
    });
  };

  const renderMathKeyboardFixed = () => {
    renderMathKeyboardKeys(mathKeyboardFixedGrid, mathKeyboardFixedKeys);
  };

  const updateMathKeyboardShiftState = () => {
    const isActive = isMathKeyboardShiftActive();
    if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
      mathKeyboardShiftButton.classList.toggle("is-active", isActive);
      mathKeyboardShiftButton.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
    if (mathKeyboardDock instanceof HTMLElement && mathKeyboardDock.classList.contains("is-open")) {
      renderMathKeyboard(activeMathKeyboardTab);
      renderMathKeyboardFixed();
    }
  };

  const updateMathKeyboardVisibility = () => {
    if (!(mathKeyboardDock instanceof HTMLElement)) {
      return;
    }
    const shouldShow = activeTab === "blocks" && activeBlockType === "math";
    mathKeyboardDock.classList.toggle("is-open", shouldShow);
    mathKeyboardDock.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    if (!shouldShow) {
      return;
    }
    if (mathKeyboardGrid instanceof HTMLElement && mathKeyboardGrid.childElementCount === 0) {
      renderMathKeyboard(activeMathKeyboardTab);
    }
    if (mathKeyboardFixedGrid instanceof HTMLElement && mathKeyboardFixedGrid.childElementCount === 0) {
      renderMathKeyboardFixed();
    }
    updateMathKeyboardShiftState();
  };

  const insertMathKey = (key: MathKey) => {
    if (!blockMathInput) {
      return;
    }
    const mathField = blockMathInput as {
      insert?: (value: string, options?: Record<string, unknown>) => void;
      executeCommand?: (...args: unknown[]) => boolean;
      focus?: () => void;
      value?: string;
    };

    // フォーカスを先に戻す
    mathField.focus?.();

    // executeCommandを優先（より信頼性が高い）
    if (typeof mathField.executeCommand === "function") {
      try {
        mathField.executeCommand("insert", key.latex);
        refreshBlockPreview();
        updateMathPreview();
        return;
      } catch (e) {
        console.warn("executeCommand failed:", e);
      }
    }

    // insertメソッドをフォールバック
    if (typeof mathField.insert === "function") {
      mathField.insert(key.latex, { focus: true, feedback: false });
      refreshBlockPreview();
      updateMathPreview();
      return;
    }

    // 最終フォールバック：value直接操作
    const insertValue = key.fallback ?? key.latex;
    if (blockMathInput instanceof HTMLTextAreaElement) {
      const start = blockMathInput.selectionStart ?? blockMathInput.value.length;
      const end = blockMathInput.selectionEnd ?? blockMathInput.value.length;
      blockMathInput.value =
        blockMathInput.value.slice(0, start) + insertValue + blockMathInput.value.slice(end);
      const nextPos = start + insertValue.length;
      blockMathInput.setSelectionRange(nextPos, nextPos);
      blockMathInput.focus();
    } else if (typeof mathField.value === "string") {
      mathField.value += insertValue;
    }
    blockMathInput.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const renderMathKeyboard = (tab: MathKeyboardTab) => {
    const keys = mathKeyboardSets[tab] ?? [];
    renderMathKeyboardKeys(mathKeyboardGrid, keys);
  };

  const setMathKeyboardTab = (tab: MathKeyboardTab) => {
    activeMathKeyboardTab = tab;
    mathKeyboardTabs.forEach((button) => {
      const isActive = button.dataset.mathTab === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    renderMathKeyboard(tab);
  };

  const setActiveBlockType = (type: BlockType) => {
    activeBlockType = type;
    blockToggleButtons.forEach((button) => {
      const isActive = button.dataset.block === type;
      button.classList.toggle("is-active", isActive);
    });
    blockForms.forEach((form) => {
      const isActive = form.dataset.form === type;
      form.classList.toggle("is-active", isActive);
    });
    if (blockPreviewActive) {
      refreshBlockPreview();
    }
    updateMathKeyboardVisibility();
    if (type === "math") {
      updateMathPreview();
      setTableEditMode("grid");
    } else if (activeBlockEditMode !== "detected") {
      setTableEditMode("grid");
    }
  };

  let currentMathValue = "";

  const readMathFieldValue = (
    mathField: { getValue?: (format?: string) => unknown; value?: unknown } | null
  ) => {
    if (!mathField) {
      return "";
    }
    if (typeof mathField.getValue === "function") {
      const nextValue = mathField.getValue("latex");
      if (typeof nextValue === "string") {
        return nextValue;
      }
    }
    if (typeof mathField.value === "string") {
      return mathField.value;
    }
    return "";
  };

  const writeMathFieldValue = (
    mathField: { setValue?: (value: string) => void; value?: string } | null,
    value: string
  ) => {
    if (!mathField) {
      return;
    }
    if (typeof mathField.setValue === "function") {
      mathField.setValue(value);
      return;
    }
    if ("value" in mathField) {
      (mathField as { value?: string }).value = value;
    }
  };

  const updateMathPreview = (value?: string) => {
    // プレビュー機能は無効化済み
  };

  const getMathInputValue = () => {
    const mathInput = blockMathInputFallback ?? blockMathInput;
    if (!mathInput) {
      return "";
    }
    // MathLiveの場合、キャッシュされた値を使用（DOMアクセスより確実）
    if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
      currentMathValue = readMathFieldValue(
        mathInput as { getValue?: (format?: string) => unknown; value?: unknown }
      );
      return currentMathValue;
    }

    if (mathInput instanceof HTMLTextAreaElement) {
      currentMathValue = mathInput.value;
      return currentMathValue;
    }
    const value = (mathInput as { value?: string }).value;
    return typeof value === "string" ? value : "";
  };
  if (isE2E) {
    (
      window as { __tex180GetMathInputValue?: () => string }
    ).__tex180GetMathInputValue = getMathInputValue;
  }

  const setMathInputValue = (value: string) => {
    currentMathValue = value;
    if (!blockMathInput) {
      return;
    }
    if (blockMathInput instanceof HTMLTextAreaElement) {
      blockMathInput.value = value;
      return;
    }
    writeMathFieldValue(
      blockMathInput as { setValue?: (value: string) => void; value?: string },
      value
    );
  };

  const getTableRawValue = () => {
    if (blockTableRawInput instanceof HTMLTextAreaElement) {
      return blockTableRawInput.value;
    }
    return "";
  };

  const setTableRawValue = (value: string) => {
    if (blockTableRawInput instanceof HTMLTextAreaElement) {
      blockTableRawInput.value = value;
    }
  };

  const attachMathInputListener = () => {
    if (!blockMathInput) {
      return;
    }
    blockMathInput.addEventListener("input", () => {
      if (blockMathInput instanceof HTMLTextAreaElement) {
        currentMathValue = blockMathInput.value;
      } else {
        currentMathValue = readMathFieldValue(
          blockMathInput as { getValue?: (format?: string) => unknown; value?: unknown }
        );
      }
      refreshBlockPreview();
    });
  };

  // =============================================================================
  // MathLive イベントハンドリング
  // =============================================================================

  const attachMathFieldEvents = (mathfield: HTMLElement) => {
    const syncMathFieldValue = () => {
      currentMathValue = readMathFieldValue(
        mathfield as { getValue?: (format?: string) => unknown; value?: unknown }
      );
      refreshBlockPreview();
    };
    // 入力変更時
    mathfield.addEventListener("input", syncMathFieldValue);
    mathfield.addEventListener("change", syncMathFieldValue);

    // キーボードイベント
    mathfield.addEventListener("keydown", (e: KeyboardEvent) => {
      // Escでフォーカス解除
      if (e.key === "Escape") {
        mathfield.blur();
        return;
      }

      // Cmd+Enter (Mac) / Ctrl+Enter (Win) で確定
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (blockInsertButton instanceof HTMLButtonElement) {
          blockInsertButton.click();
        }
        return;
      }

      // Tab移動は許可
      if (e.key === "Tab") return;

      // その他のキーは伝播を止める（Monaco干渉防止）
      e.stopPropagation();
    });

    // フォーカス時
    mathfield.addEventListener("focus", () => {
      updateMathKeyboardVisibility();
      mathfield.classList.add("is-focused");
    });

    // フォーカス喪失
    mathfield.addEventListener("blur", () => {
      mathfield.classList.remove("is-focused");
    });

    // IME対応
    mathfield.addEventListener("compositionstart", (e) => e.stopPropagation());
    mathfield.addEventListener("compositionend", (e) => e.stopPropagation());
  };

  // =============================================================================
  // サイドバーリサイズ
  // =============================================================================

  const setupResizer = () => {
    const resizer = document.getElementById("resizer");
    if (!resizer) return;
  
    let isResizing = false;
    
    const startResize = (e: MouseEvent) => {
      isResizing = true;
      resizer.classList.add("is-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      if (document.getElementById("editor")) {
        document.getElementById("editor").style.pointerEvents = "none"; // iframe対策的な
      }
    };

    const doResize = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarWidth = 52; // var(--sidebar-width)
      const minPanelWidth = 240;
      const minEditorWidth = 320;
      const maxPanelWidth = Math.max(
        minPanelWidth,
        window.innerWidth - sidebarWidth - minEditorWidth
      );
      // マウス位置から新しいパネル幅を計算
      const newWidth = Math.max(minPanelWidth, Math.min(maxPanelWidth, e.clientX - sidebarWidth));
      document.documentElement.style.setProperty("--sidebar-panel-width", `${newWidth}px`);
      // Monacoのリサイズ
      const editor = monacoEditor as { layout?: () => void };
      if (editor && typeof editor.layout === "function") {
          editor.layout();
      }
    };

    const stopResize = () => {
      if (isResizing) {
        isResizing = false;
        resizer.classList.remove("is-resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (document.getElementById("editor")) {
          document.getElementById("editor").style.pointerEvents = "";
        }
        const editor = monacoEditor as { layout?: () => void };
        if (editor && typeof editor.layout === "function") {
            editor.layout();
        }
      }
    };

    resizer.addEventListener("mousedown", startResize);
    document.addEventListener("mousemove", doResize);
    document.addEventListener("mouseup", stopResize);
  };

  // =============================================================================
  // MathField 初期化
  // =============================================================================

  const setupMathField = async () => {
    if (!blockMathInputContainer) {
      console.error("MathLive container not found");
      return;
    }
    
    // 既に初期化済みなら何もしない
    if (blockMathInputContainer.querySelector("math-field")) {
      return;
    }

    // MathLiveのロード確認と手動登録
    const MathLiveGlobal = (window as any).MathLive;
    const hasMathLive = !!MathLiveGlobal;
    const hasMathfieldElement = hasMathLive && !!MathLiveGlobal.MathfieldElement;
    const loadError = (window as any).MATHLIVE_LOAD_ERROR;
    
    if (!customElements.get("math-field")) {
      if (hasMathfieldElement) {
        try {
          customElements.define("math-field", MathLiveGlobal.MathfieldElement);
        } catch (e) {
          // 既に定義済みの場合など
        }
      }
    }

    // それでも未定義なら待機
    if (!customElements.get("math-field")) {
      // デバッグ情報を表示
      const debugInfo = `MathLive: ${hasMathLive ? "OK" : "NG"}, MathfieldElement: ${hasMathfieldElement ? "OK" : "NG"}, LoadError: ${loadError || "none"}`;
      blockMathInputContainer.textContent = `Loading... (${debugInfo})`;
      try {
        await Promise.race([
          customElements.whenDefined("math-field"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
        ]);
        blockMathInputContainer.textContent = "";
      } catch (e) {
        // 失敗時にデバッグ情報を表示
        blockMathInputContainer.innerHTML = `
          <div style="font-size:12px;">MathLiveの読み込みに失敗しました。</div>
          <div style="font-size:10px;color:#888;margin-top:4px;">${debugInfo}</div>
        `;
        blockMathInputContainer.style.color = "#ff6b6b";
        return;
      }
    }

    if (MathLiveGlobal?.convertLatexToMarkup) {
      markMathLiveReady();
    } else {
      ensureMathLiveReady();
    }

    // MathField要素作成
    const mathfield = document.createElement("math-field") as any;
    mathfield.id = "block-math-input";
    mathfield.className = "block-math-field";
    
    // コンテナに追加
    blockMathInputContainer.innerHTML = "";
    blockMathInputContainer.appendChild(mathfield);
    blockMathInput = mathfield;
    if (currentMathValue) {
      writeMathFieldValue(
        mathfield as { setValue?: (value: string) => void; value?: string },
        currentMathValue
      );
    }

    // オプション設定
    if (typeof mathfield.setOptions === "function") {
      mathfield.setOptions({
        smartMode: false,
        defaultMode: "math",
        virtualKeyboardMode: "off",
        fontsDirectory: "mathlive/fonts",
        soundsDirectory: null,
        keypressSound: null,
        plonkSound: null,
        locale: "ja",
      });
    }

    // Shadow DOMスタイル注入
    const injectStyles = () => {
      if (!mathfield.shadowRoot) return;
      // 既にスタイルがあるかチェック
      if (mathfield.shadowRoot.querySelector('style[data-tex180-style]')) return;

      const style = document.createElement("style");
      style.setAttribute("data-tex180-style", "true");
      style.textContent = `
        :host {
          color: var(--text, #eef3fb) !important;
          background-color: transparent !important;
        }
        .ML__field {
          color: var(--text, #eef3fb) !important;
        }
        .ML__placeholder {
          color: #8fb3d4 !important;
          opacity: 0.85;
        }
        .ML__selection {
          background: rgba(110, 195, 255, 0.7) !important;
          color: #f8fbff !important;
        }
        .ML__caret {
          background-color: var(--accent, #5bc2ff) !important;
        }
        .ML__contains-highlight {
          background: rgba(110, 195, 255, 0.25) !important;
        }
        .ML__virtual-keyboard-toggle {
          display: none !important;
        }
        button[part="virtual-keyboard-toggle"] {
          display: none !important;
        }
      `;
      mathfield.shadowRoot.appendChild(style);
    };
    
    // 少し待ってからスタイル注入（ShadowRoot生成待ち）
    setTimeout(() => {
        injectStyles();
    }, 0);

    attachMathFieldEvents(mathfield);
  };

  const buildLineDiff = (beforeLines: string[], afterLines: string[]) => {
    const rows = beforeLines.length;
    const cols = afterLines.length;
    const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
    for (let i = 1; i <= rows; i += 1) {
      for (let j = 1; j <= cols; j += 1) {
        if (beforeLines[i - 1] === afterLines[j - 1]) {
          table[i][j] = table[i - 1][j - 1] + 1;
        } else {
          table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
        }
      }
    }
    const diff: { type: "add" | "del" | "same"; line: string }[] = [];
    let i = rows;
    let j = cols;
    while (i > 0 && j > 0) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        diff.push({ type: "same", line: beforeLines[i - 1] });
        i -= 1;
        j -= 1;
      } else if (table[i - 1][j] >= table[i][j - 1]) {
        diff.push({ type: "del", line: beforeLines[i - 1] });
        i -= 1;
      } else {
        diff.push({ type: "add", line: afterLines[j - 1] });
        j -= 1;
      }
    }
    while (i > 0) {
      diff.push({ type: "del", line: beforeLines[i - 1] });
      i -= 1;
    }
    while (j > 0) {
      diff.push({ type: "add", line: afterLines[j - 1] });
      j -= 1;
    }
    return diff.reverse();
  };

  const buildDiffPreview = (before: string, after: string) => {
    const beforeText = before.trimEnd();
    const afterText = after.trimEnd();
    if (beforeText === afterText) {
      return "変更なし";
    }
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    const header = "差分（-削除 / +追加）";
    const body = diffLines
      .map((entry) => {
        const prefix = entry.type === "add" ? "+" : entry.type === "del" ? "-" : " ";
        return `${prefix} ${entry.line}`;
      })
      .join("\n");
    return `${header}\n${body}`;
  };

  const renderDiffSummary = (before: string, after: string) => {
    if (!(diffSummary instanceof HTMLElement)) {
      return;
    }
    diffSummary.textContent = "";
    const beforeText = before.trimEnd();
    const afterText = after.trimEnd();
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    let adds = 0;
    let dels = 0;
    diffLines.forEach((entry) => {
      if (entry.type === "add") {
        adds += 1;
      } else if (entry.type === "del") {
        dels += 1;
      }
    });
    if (adds === 0 && dels === 0) {
      diffSummary.textContent = "変更なし";
      return;
    }
    const add = document.createElement("span");
    add.className = "diff-summary-item is-add";
    add.textContent = `+${adds}`;
    const del = document.createElement("span");
    del.className = "diff-summary-item is-del";
    del.textContent = `-${dels}`;
    diffSummary.append(add, del);
  };

  const renderDiffHeader = () => {
    if (diffTitle instanceof HTMLElement) {
      diffTitle.textContent = "変更内容の確認";
    }
    if (diffFileName instanceof HTMLElement) {
      const fileName = currentFilePath
        ? currentFilePath.split(/[/\\]/).pop() ?? currentFilePath
        : "未保存";
      diffFileName.textContent = fileName;
    }
  };

  const countLines = (text: string) => {
    if (!text) return 1;
    return text.split(/\r?\n/).length;
  };

  const applyDiffLineNumberOffset = (offset: number, original: string, modified: string) => {
    if (!diffEditor) return;
    const maxLine = offset + Math.max(countLines(original), countLines(modified));
    const minChars = Math.max(2, String(maxLine).length);
    const lineNumbers = (lineNumber: number) => String(lineNumber + offset);
    const options = { lineNumbers, lineNumbersMinChars: minChars };
    const editorAny = diffEditor as {
      getOriginalEditor?: () => { updateOptions?: (opts: unknown) => void };
      getModifiedEditor?: () => { updateOptions?: (opts: unknown) => void };
      updateOptions?: (opts: unknown) => void;
    };
    editorAny.getOriginalEditor?.()?.updateOptions?.(options);
    editorAny.getModifiedEditor?.()?.updateOptions?.(options);
    editorAny.updateOptions?.(options);
  };

  const buildBlockPreviewSnippet = (snippet: string) => {
    if (!activeBlockOriginalSnippet) {
      return snippet;
    }
    return buildDiffPreview(activeBlockOriginalSnippet, snippet);
  };

  // Context-Aware Helper Functions
  const MATRIX_ENV_NAMES = new Set([
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "smallmatrix",
  ]);

  const OPTIONAL_BRACKET_ENVS = new Set([
    "aligned",
    "alignedat",
    "gathered",
    "multlined",
    "empheq",
    "table",
    "tabular",
    "tabularx",
    "tabulary",
    "longtable",
    "ltablex",
    "xltabular",
    "tabu",
    "longtabu",
    "supertabular",
    "tblr",
    "longtblr",
    "mathpar",
    "mathparpagebreakable",
  ]);

  const REQUIRED_ENV_ARGS: Record<string, number> = {
    alignat: 1,
    xalignat: 1,
    xxalignat: 1,
    alignedat: 1,
    empheq: 1,
    numcases: 1,
    subnumcases: 1,
    array: 1,
    subarray: 1,
    tabular: 1,
    tabularx: 2,
    tabulary: 2,
    longtable: 1,
    ltablex: 2,
    xltabular: 2,
    tabu: 1,
    longtabu: 1,
    supertabular: 1,
    tblr: 1,
    longtblr: 1,
    IEEEeqnarray: 1,
    IEEEeqnarraybox: 1,
    darray: 1,
  };

  const skipEnvWhitespace = (text: string, index: number) => {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
    return cursor;
  };

  const readDelimitedArg = (
    text: string,
    startIndex: number,
    openChar: string,
    closeChar: string
  ) => {
    if (text[startIndex] !== openChar) {
      return null;
    }
    let depth = 0;
    for (let i = startIndex; i < text.length; i += 1) {
      const char = text[i];
      if (char === openChar && !isEscapedAt(text, i)) {
        depth += 1;
      } else if (char === closeChar && !isEscapedAt(text, i)) {
        depth -= 1;
        if (depth === 0) {
          return { end: i + 1 };
        }
      }
    }
    return null;
  };

  const consumeEnvArguments = (snippet: string, startIndex: number, envName: string) => {
    const base = getEnvBaseName(envName);
    let cursor = skipEnvWhitespace(snippet, startIndex);
    const allowOptional =
      OPTIONAL_BRACKET_ENVS.has(base) || (MATRIX_ENV_NAMES.has(base) && envName.endsWith("*"));
    if (allowOptional && snippet[cursor] === "[") {
      const optionalArg = readDelimitedArg(snippet, cursor, "[", "]");
      if (optionalArg) {
        cursor = skipEnvWhitespace(snippet, optionalArg.end);
      }
    }
    let requiredCount = REQUIRED_ENV_ARGS[base] ?? 0;
    if (base === "tabular" && envName.endsWith("*")) {
      requiredCount = 2;
    }
    for (let i = 0; i < requiredCount; i += 1) {
      cursor = skipEnvWhitespace(snippet, cursor);
      if (snippet[cursor] !== "{") {
        break;
      }
      const requiredArg = readDelimitedArg(snippet, cursor, "{", "}");
      if (!requiredArg) {
        break;
      }
      cursor = requiredArg.end;
    }
    return skipEnvWhitespace(snippet, cursor);
  };

  const parseBlockContext = (snippet: string): BlockContext => {
    // 1. Double Dollar (Display)
    const ddMatch = snippet.match(/^(\$\$)([\s\S]*?)(\$\$)$/);
    if (ddMatch) {
       return { 
         type: "math", 
         originalSnippet: snippet,
         prefix: ddMatch[1],
         suffix: ddMatch[3]
       };
    }

    // 2. Bracket Display (\[ ... \])
    const bdMatch = snippet.match(/^(\\\[)([\s\S]*?)(\\\])$/);
    if (bdMatch) {
        return { 
          type: "math", 
          originalSnippet: snippet,
          prefix: bdMatch[1],
          suffix: bdMatch[3]
        };
    }
    
    // 3. Inline ($ ... $)
    const inlineParenMatch = snippet.match(/^(\\\()([\s\S]*?)(\\\))$/);
    if (inlineParenMatch) {
        return {
          type: "math",
          originalSnippet: snippet,
          prefix: inlineParenMatch[1],
          suffix: inlineParenMatch[3],
        };
    }
    const inlineMatch = snippet.match(/^(\$)([\s\S]*?)(\$)$/);
    if (inlineMatch) {
        return { 
          type: "math", 
          originalSnippet: snippet,
          prefix: inlineMatch[1],
          suffix: inlineMatch[3]
        };
    }

    // 4. Environments (\begin{name} ... \end{name})
    const envBeginMatch = snippet.match(/^\\begin\{([^}]+)\}/);
    if (envBeginMatch) {
      const envName = normalizeEnvName(envBeginMatch[1]);
      const endToken = `\\end{${envName}}`;
      if (snippet.endsWith(endToken)) {
        const prefixEnd = consumeEnvArguments(snippet, envBeginMatch[0].length, envName);
        const prefix = snippet.slice(0, prefixEnd);
        const suffix = endToken;
        const base = getEnvBaseName(envName);
        return {
          type: TABLE_ENV_NAMES.has(base) ? "table" : "math",
          originalSnippet: snippet,
          prefix,
          suffix,
          envName,
        };
      }
    }

    // Default: Treat whole thing as content if no wrapper detected
    // This shouldn't happen often if detection works, but safe fallback
    return { 
      type: "math", 
      originalSnippet: snippet, 
      prefix: "",
      suffix: "",
      envName: undefined 
    };
  };

  const getInnerContent = (
    context: BlockContext,
    options?: { trim?: boolean }
  ): string => {
    // With Injection Strategy, we just slice off the known prefix/suffix
    // But we should be careful if originalSnippet has changed?
    // No, context.originalSnippet is the reference.
    const start = context.prefix.length;
    const end = context.originalSnippet.length - context.suffix.length;
    const content = context.originalSnippet.slice(start, end);
    return options?.trim === false ? content : content.trim();
  };

  const reconstructionBlock = (context: BlockContext, content: string): string => {
      // INJECTION STRATEGY: Simple Concatenation
      // We do NOT modify context.prefix or context.suffix at all.
      // We do NOT trim content vigorously if we want to respect user's inner spacing,
      // but usually the editor output is clean. 
      // The user requested that "no changes means 0 diff", so we must ensure 
      // that if content matches original inner, we return original.
      
      const originalInner = getInnerContent(context);
      const newInner = content.trim(); 
      
      // If the semantic content is identical to the trimmed original content,
      // we might want to preserve the ORIGINAL inner spacing too (e.g. " x " vs "x").
      // But getInnerContent returns trimmed. 
      // Let's rely on the fact that if newInner == originalInner, we return originalSnippet.
      
      if (originalInner === newInner) {
          return context.originalSnippet;
      }
      
      // If content changed, we inject it.
      // We add newlines for block environments if they are undoubtedly block-like?
      // No, strictly follow Injection Strategy: Prefix + Content + Suffix.
      // However, if the user deleted all newlines in the editor, we might get `\[x\]` instead of `\[\n x \n\]`.
      // For now, simple concatenation is the most faithful "Injection".
      // Users can add newlines in the editor if they want them.
      return context.prefix + content + context.suffix;
  };

  const buildTableSnippetFromRaw = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "";
    }
    if (activeBlockContext?.type === "table") {
      return reconstructionBlock(activeBlockContext, raw);
    }
    if (trimmed.startsWith("\\begin{")) {
      return trimmed;
    }
    return ["\\\\begin{tabular}{|c|}", trimmed, "\\\\end{tabular}", ""].join("\n");
  };

  const buildMathSnippet = (formula: string) => {
    // If we have an active context, use it to reconstruct
    if (activeBlockContext?.type === "math") {
      return reconstructionBlock(activeBlockContext, formula);
    }
    
    // Default fallback for NEW blocks (when no context exists)
    const trimmed = formula.trim();
    if (!trimmed) {
      return "";
    }

    // Check if user manually typed wrappers
    if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
        return trimmed;
    }
    if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
        return trimmed;
    }
    if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
        return trimmed;
    }
    if (trimmed.startsWith("\\begin{")) {
        return trimmed;
    }

    // Default to Display Math \[ ... \] as before
    return ["\\\\[", trimmed, "\\\\]", ""].join("\n");
  };

  const parseTableSize = () => {
    const rows =
      blockTableRows instanceof HTMLInputElement
        ? Number.parseInt(blockTableRows.value, 10)
        : NaN;
    const cols =
      blockTableCols instanceof HTMLInputElement
        ? Number.parseInt(blockTableCols.value, 10)
        : NaN;
    if (!Number.isFinite(rows) || rows < 1 || rows > 20) {
      return null;
    }
    if (!Number.isFinite(cols) || cols < 1 || cols > 12) {
      return null;
    }
    return { rows, cols };
  };

  const buildTableSnippet = (rows: number, cols: number) => {
    const columnSpec = `|${"c|".repeat(cols)}`;
    const rowCells = Array.from({ length: cols }, () => " ").join(" & ");
    const lines: string[] = [];
    lines.push(`\\\\begin{tabular}{${columnSpec}}`);
    for (let row = 0; row < rows; row += 1) {
      lines.push("\\\\hline");
      lines.push(`${rowCells} \\\\`);
    }
    lines.push("\\\\hline");
    lines.push("\\\\end{tabular}");
    lines.push("");
    return lines.join("\n");
  };

  const getBlockDraft = (): { snippet: string; content: BlockContent } | null => {
    if (activeBlockType === "math") {
      const formula = getMathInputValue();
      const snippet = buildMathSnippet(formula);
      if (!snippet.trim()) {
        return null;
      }
      return { snippet, content: { formula: formula.trim() } };
    }
    if (tableEditMode === "raw") {
      const raw = getTableRawValue();
      const snippet = buildTableSnippetFromRaw(raw);
      if (!snippet.trim()) {
        return null;
      }
      return { snippet, content: { raw } };
    }
    const size = parseTableSize();
    if (!size) {
      return null;
    }
    return {
      snippet: buildTableSnippet(size.rows, size.cols),
      content: { rows: size.rows, cols: size.cols },
    };
  };

  const refreshBlockPreview = () => {
    if (!blockPreviewActive) {
      return;
    }
    const draft = getBlockDraft();
    if (!draft) {
      setInsertPreviewText("");
      return;
    }
    setInsertPreviewText(buildBlockPreviewSnippet(draft.snippet));
  };

  const resetBlockSession = () => {
    blockPreviewActive = false;
    activeBlockOriginalSnippet = null;
    activeBlockContext = null;
    activeBlockEditMode = "none";
    detectedBlockSnapshot = null;
    pendingBlockApply = null;
    currentBlockDraft = null;
    currentDetectedBlock = null;
    setAutoDetectedUi(false);
    setTableEditMode("grid");
    clearBlockHighlight();
    clearInsertPreview();
  };

  const renderSearchResults = () => {
    if (!(searchResults instanceof HTMLElement)) {
      return;
    }
    searchResults.innerHTML = "";
    if (searchResultsData.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent = searchMessage;
      searchResults.appendChild(empty);
      return;
    }
    searchResultsData.forEach((result) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-item";

      const preview = document.createElement("div");
      preview.textContent = result.preview;
      const meta = document.createElement("div");
      meta.className = "search-item-meta";
      meta.textContent = `${result.path} · 行 ${result.line}`;

      item.append(preview, meta);
      item.addEventListener("click", () => {
        jumpToSearchResult(result);
      });
      searchResults.appendChild(item);
    });
  };

  const handleSearchUpdate = (payload: {
    query: string;
    results?: SearchResult[];
    message?: string;
  }) => {
    lastSearchQuery = payload.query;
    searchResultsData = Array.isArray(payload.results) ? payload.results : [];
    if (payload.message) {
      searchMessage = payload.message;
    } else if (searchResultsData.length === 0) {
      searchMessage =
        lastSearchQuery.trim().length === 0
          ? "検索語を入力してください。"
          : "一致する結果がありません。";
    }
    renderSearchResults();
  };

  const renderGitStatus = () => {
    if (!(gitStatus instanceof HTMLElement)) {
      return;
    }
    gitStatus.innerHTML = "";
    if (gitEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent = gitMessage;
      gitStatus.appendChild(empty);
      return;
    }
    gitEntries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "git-item";

      const title = document.createElement("div");
      title.textContent = `${entry.status}`;
      const meta = document.createElement("div");
      meta.className = "git-item-meta";
      meta.textContent = entry.path;

      item.append(title, meta);
      gitStatus.appendChild(item);
    });
  };

  const handleGitUpdate = (payload: { entries?: GitEntry[]; message?: string }) => {
    gitEntries = Array.isArray(payload.entries) ? payload.entries : [];
    if (payload.message) {
      gitMessage = payload.message;
    } else if (gitEntries.length === 0) {
      gitMessage = "変更はありません。";
    }
    renderGitStatus();
  };

  const requestSearch = (query: string) => {
    lastSearchQuery = query;
    if (!workspaceRootKey) {
      searchResultsData = [];
      searchMessage = "ワークスペースが未選択です。";
      renderSearchResults();
      return;
    }
    if (query.trim().length === 0) {
      searchResultsData = [];
      searchMessage = "検索語を入力してください。";
      renderSearchResults();
      return;
    }
    searchResultsData = [];
    searchMessage = "検索中...";
    renderSearchResults();
    postToNative({ type: "search", query });
  };

  const requestGitStatus = () => {
    if (!workspaceRootKey) {
      gitEntries = [];
      gitMessage = "ワークスペースが未選択です。";
      renderGitStatus();
      return;
    }
    gitMessage = "取得中...";
    renderGitStatus();
    postToNative({ type: "gitStatus" }, true);
  };

  const requestSetRoot = (path: string) => {
    if (!workspaceRootKey) {
      updateIssues(1, "ワークスペースが未選択です。", "error", [
        { severity: "error", message: "ワークスペースが未選択です。" },
      ]);
      return;
    }
    if (!path || path === rootFilePath) {
      return;
    }
    postToNative({ type: "setRoot", path });
  };

  const requestDetectRoot = () => {
    if (!workspaceRootKey) {
      updateIssues(1, "ワークスペースが未選択です。", "error", [
        { severity: "error", message: "ワークスペースが未選択です。" },
      ]);
      return;
    }
    postToNative({ type: "detectRoot" });
  };

  const setWorkspaceLabel = (label: string) => {
    workspaceName = label;
    setText(workspaceLabel, label);
  };

  const pickInitialFilePath = () => {
    if (rootFilePath && workspaceFiles.includes(rootFilePath)) {
      return rootFilePath;
    }
    const texFiles = workspaceFiles
      .filter((path) => path.toLowerCase().endsWith(".tex"))
      .sort((a, b) => a.localeCompare(b, "ja"));
    if (texFiles.length > 0) {
      return texFiles[0];
    }
    if (workspaceFiles.length > 0) {
      return workspaceFiles[0];
    }
    return null;
  };

  const requestInitialOpen = () => {
    const hasValidCurrent =
      currentFilePath !== null && workspaceFiles.includes(currentFilePath);
    if (hasValidCurrent) {
      return;
    }
    const path = pickInitialFilePath();
    if (!path) {
      return;
    }
    if (!monacoEditor) {
      pendingAutoOpenPath = path;
      return;
    }
    pendingAutoOpenPath = null;
    requestOpenFile(path);
  };

  const openPendingFileIfReady = () => {
    if (!pendingAutoOpenPath || !monacoEditor) {
      return;
    }
    if (currentFilePath) {
      pendingAutoOpenPath = null;
      return;
    }
    const path = pendingAutoOpenPath;
    pendingAutoOpenPath = null;
    requestOpenFile(path);
  };

  const renderRootSelector = () => {
    if (!(settingsRootSelect instanceof HTMLSelectElement)) {
      return;
    }
    settingsRootSelect.innerHTML = "";
    const texFiles = workspaceFiles
      .filter((path) => path.toLowerCase().endsWith(".tex"))
      .sort((a, b) => a.localeCompare(b, "ja"));

    const placeholder = document.createElement("option");
    if (!workspaceRootKey) {
      placeholder.textContent = "ワークスペース未選択";
    } else if (texFiles.length === 0) {
      placeholder.textContent = "TeXファイルがありません";
    } else {
      placeholder.textContent = rootFilePath ? "メインTeX" : "メインTeXを選択";
    }
    placeholder.value = "";
    placeholder.disabled = true;
    if (!rootFilePath) {
      placeholder.selected = true;
    }
    settingsRootSelect.appendChild(placeholder);

    if (rootFilePath && !texFiles.includes(rootFilePath)) {
      const missing = document.createElement("option");
      missing.value = rootFilePath;
      missing.textContent = `${rootFilePath} (見つかりません)`;
      settingsRootSelect.appendChild(missing);
    }

    texFiles.forEach((path) => {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      settingsRootSelect.appendChild(option);
    });

    settingsRootSelect.disabled = !workspaceRootKey || texFiles.length === 0;
    settingsRootSelect.value = rootFilePath ?? "";

    if (settingsRootAuto instanceof HTMLButtonElement) {
      settingsRootAuto.disabled = !workspaceRootKey || texFiles.length === 0;
      settingsRootAuto.textContent = rootSource === "manual" ? "自動に戻す" : "再検出";
    }
  };

  const autoBuildKey = () => {
    if (!workspaceRootKey) {
      return null;
    }
    return `tex180.autoBuild.${workspaceRootKey}`;
  };

  const updateAutoBuildUI = () => {
    if (autoBuildButton instanceof HTMLButtonElement) {
      autoBuildButton.disabled = false;
      autoBuildButton.classList.toggle("is-active", autoBuildEnabled);
      autoBuildButton.title = autoBuildEnabled ? "自動ビルド: ON" : "自動ビルド: OFF";
    }
    if (settingsAutoBuildButton instanceof HTMLButtonElement) {
      settingsAutoBuildButton.textContent = autoBuildEnabled ? "ON" : "OFF";
      settingsAutoBuildButton.classList.toggle("is-on", autoBuildEnabled);
    }
  };

  const loadAutoBuildState = () => {
    const key = autoBuildKey();
    if (!key) {
      autoBuildEnabled = false;
      updateAutoBuildUI();
      return;
    }
    autoBuildEnabled = localStorage.getItem(key) === "true";
    updateAutoBuildUI();
  };

  const saveAutoBuildState = () => {
    const key = autoBuildKey();
    if (!key) {
      return;
    }
    localStorage.setItem(key, autoBuildEnabled ? "true" : "false");
  };

  const toggleAutoBuild = () => {
    autoBuildEnabled = !autoBuildEnabled;
    autoBuildPending = false;
    if (autoBuildEnabled && isDirty && currentFilePath?.endsWith(".tex")) {
      autoBuildPending = true;
    }
    saveAutoBuildState();
    updateAutoBuildUI();
  };

  const openStateKey = () => {
    if (!workspaceRootKey) {
      return null;
    }
    return `tex180.tree.${workspaceRootKey}`;
  };

  const loadOpenState = () => {
    openFolders = new Set<string>();
    const key = openStateKey();
    if (!key) {
      openStateLoaded = false;
      return;
    }
    const stored = localStorage.getItem(key);
    if (!stored) {
      openStateLoaded = false;
      return;
    }
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        parsed.forEach((entry) => {
          if (typeof entry === "string") {
            openFolders.add(entry);
          }
        });
      }
      openStateLoaded = true;
    } catch {
      openFolders = new Set<string>();
      openStateLoaded = false;
    }
  };

  const saveOpenState = () => {
    const key = openStateKey();
    if (!key) {
      return;
    }
    const data = JSON.stringify(Array.from(openFolders));
    localStorage.setItem(key, data);
    openStateLoaded = true;
  };

  const clearFolderSelection = () => {
    if (!(fileTree instanceof HTMLElement)) {
      return;
    }
    fileTree
      .querySelectorAll<HTMLElement>("summary.is-selected")
      .forEach((summary) => summary.classList.remove("is-selected"));
  };

  const setTreeFocus = (value: boolean) => {
    treeHasFocus = value;
    if (fileTree instanceof HTMLElement) {
      fileTree.classList.toggle("is-focused", value);
      if (value) {
        fileTree.focus({ preventScroll: true });
      }
    }
  };

  const scheduleAfterComposition = (action: () => void) => {
    if (!isComposing) {
      action();
      return;
    }
    // Blur will trigger compositionend which handles recovery
    pendingCompositionAction = action;
    const input = editorHost?.querySelector<HTMLTextAreaElement>("textarea.inputarea");
    input?.blur();
  };

  const handleCompositionEnd = () => {
    if (!pendingCompositionAction) {
      return;
    }
    const action = pendingCompositionAction;
    pendingCompositionAction = null;
    requestAnimationFrame(() => {
      action();
    });
  };

  const selectFolderSummary = (summary: HTMLElement, path: string) => {
    clearFolderSelection();
    summary.classList.add("is-selected");
    selectedTreePath = path;
    selectedTreeType = "dir";
    setTreeFocus(true);
  };

  const updateDirtyState = (path: string, content: string, savedContent?: string) => {
    const entry = monacoModels.get(path);
    const baseSaved = savedContent ?? entry?.savedContent ?? currentFileSavedContent ?? content;
    if (entry) {
      entry.savedContent = baseSaved;
    }
    if (content !== baseSaved) {
      dirtyFiles.add(path);
    } else {
      dirtyFiles.delete(path);
    }
    if (path === currentFilePath) {
      isDirty = dirtyFiles.has(path);
    }
  };

  const storeViewState = (path: string) => {
    if (!monacoEditor) {
      return;
    }
    const editor = monacoEditor as { saveViewState?: () => unknown };
    if (!editor.saveViewState) {
      return;
    }
    const viewState = editor.saveViewState();
    if (viewState) {
      monacoViewStates.set(path, viewState);
    }
  };

  const restoreViewState = (path: string) => {
    if (!monacoEditor) {
      return;
    }
    const viewState = monacoViewStates.get(path);
    if (!viewState) {
      return;
    }
    const editor = monacoEditor as { restoreViewState?: (state: unknown) => void };
    editor.restoreViewState?.(viewState);
  };

  const cacheCurrentBuffer = () => {
    if (!currentFilePath || !monacoEditor) {
      return;
    }
    
    const editor = monacoEditor as { getValue: () => string };
    const content = editor.getValue();
    updateDirtyState(currentFilePath, content);
    storeViewState(currentFilePath);
  };

  const addOpenTab = (path: string) => {
    if (!openTabs.includes(path)) {
      openTabs = [...openTabs, path];
    }
  };

  const closeTab = (path: string) => {
    const index = openTabs.indexOf(path);
    if (index === -1) {
      return;
    }
    if (path === currentFilePath && isComposing) {
      scheduleAfterComposition(() => {
        closeTab(path);
      });
      return;
    }
    if (path === currentFilePath) {
      cacheCurrentBuffer();
    }
    openTabs = openTabs.filter((entry) => entry !== path);
    if (path === currentFilePath) {
      if (openTabs.length > 0) {
        const nextIndex = Math.min(index, openTabs.length - 1);
        const nextPath = openTabs[nextIndex];
        requestOpenFile(nextPath, true);
      } else {
        currentFilePath = null;
        currentFileSavedContent = null;
        isDirty = false;
        autoBuildPending = false;
        updateBreadcrumbs();
        updateMiniOutline();
        renderOutline();
        renderFileTree();
      }
    }
    renderEditorTabs();
  };

  const renderEditorTabs = () => {
    if (!(editorTabsList instanceof HTMLElement)) {
      return;
    }
    editorTabsList.innerHTML = "";
    if (openTabs.length === 0) {
      editorTabsList.classList.add("is-empty");
      return;
    }
    editorTabsList.classList.remove("is-empty");
    openTabs.forEach((path) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "editor-tab";
      const label = document.createElement("span");
      label.className = "editor-tab-label";
      label.textContent = path.split("/").pop() ?? path;
      tab.title = path;
      if (dirtyFiles.has(path)) {
        tab.classList.add("is-dirty");
      }
      if (path === currentFilePath) {
        tab.classList.add("is-active");
      }
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "editor-tab-close";
      closeButton.textContent = "×";
      closeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (isComposing) {
          scheduleAfterComposition(() => {
            closeTab(path);
          });
          return;
        }
        closeTab(path);
      });
      tab.append(label, closeButton);
      tab.addEventListener("click", () => {
        if (path !== currentFilePath) {
          requestOpenFile(path);
        }
      });
      editorTabsList.appendChild(tab);
    });
  };

  const updateBreadcrumbs = () => {
    if (breadcrumbs instanceof HTMLElement) {
      const fileLabel = currentFilePath ?? "未選択";
      const dirtyMark = isDirty ? " ●" : "";
      breadcrumbs.textContent = `${fileLabel}${dirtyMark}`;
    }
    renderEditorTabs();
  };

  const updateMiniOutline = () => {
    if (!(miniOutline instanceof HTMLElement)) {
      return;
    }
    const fileLabel = currentFilePath ? currentFilePath.split("/").pop() : "未選択";
    miniOutline.textContent = `ミニアウトライン: ${fileLabel}`;
  };

  const sortNodes = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "ja");
    });
    nodes.forEach((node) => {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    });
  };

  const buildFileTree = (files: string[], folders: string[]): FileNode[] => {
    const root: FileNode = { name: "", path: "", type: "dir", children: [] };
    folders.forEach((path) => {
      const parts = path.split("/").filter(Boolean);
      let cursor = root;
      parts.forEach((part, index) => {
        const currentPath = parts.slice(0, index + 1).join("/");
        let child = cursor.children.find((node) => node.name === part);
        if (!child) {
          child = { name: part, path: currentPath, type: "dir", children: [] };
          cursor.children.push(child);
        } else if (child.type !== "dir") {
          child.type = "dir";
        }
        cursor = child;
      });
    });
    files.forEach((path) => {
      const parts = path.split("/").filter(Boolean);
      let cursor = root;
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        let child = cursor.children.find((node) => node.name === part);
        if (!child) {
          const currentPath = parts.slice(0, index + 1).join("/");
          child = {
            name: part,
            path: currentPath,
            type: isLast ? "file" : "dir",
            children: [],
          };
          cursor.children.push(child);
        }
        if (isLast) {
          child.type = "file";
          child.children = [];
        } else {
          child.type = "dir";
        }
        cursor = child;
      });
    });
    sortNodes(root.children);
    return root.children;
  };

  const getLanguageIdForPath = (path: string) => {
    if (path.endsWith(".tex")) {
      return "latex";
    }
    if (path.endsWith(".bib")) {
      return "bibtex";
    }
    return "plaintext";
  };

  const setEditorLanguage = (path: string) => {
    if (!monacoApi || !monacoEditor) {
      return;
    }
    const editor = monacoEditor as { getModel?: () => unknown };
    if (!editor.getModel) {
      return;
    }
    const model = editor.getModel();
    const monacoApiAny = monacoApi as {
      editor?: { setModelLanguage?: (model: unknown, languageId: string) => void };
    };
    const languageId = getLanguageIdForPath(path);
    if (model && monacoApiAny.editor?.setModelLanguage) {
      monacoApiAny.editor.setModelLanguage(model, languageId);
    }
  };

  const dragDataType = "application/x-tex180-item";

  const setDragData = (event: DragEvent, payload: DragPayload) => {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.clearData();
    event.dataTransfer.setData(dragDataType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  };

  const getDragData = (event: DragEvent) => {
    const raw = event.dataTransfer?.getData(dragDataType);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as DragPayload;
      if (!parsed?.path || (parsed.kind !== "file" && parsed.kind !== "dir")) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const clearDropTargets = () => {
    document
      .querySelectorAll<HTMLElement>(".is-drop-target")
      .forEach((element) => element.classList.remove("is-drop-target"));
  };

  const canDropOnFolder = (payload: DragPayload, targetFolder: string) => {
    if (!targetFolder) {
      return true;
    }
    if (payload.kind === "dir") {
      if (payload.path === targetFolder) {
        return false;
      }
      if (targetFolder.startsWith(`${payload.path}/`)) {
        return false;
      }
    }
    return true;
  };

  const requestMoveItem = (payload: DragPayload, targetFolder: string) => {
    if (!workspaceRootKey) {
      updateIssues(1, "起動時にフォルダを選択してください。", "error", [
        { severity: "error", message: "起動時にフォルダを選択してください。" },
      ]);
      return;
    }
    const currentParent = getParentPath(payload.path);
    if (currentParent === targetFolder) {
      return;
    }
    if (!canDropOnFolder(payload, targetFolder)) {
      updateIssues(1, "移動先が不正です。", "error", [
        { severity: "error", message: "移動先が不正です。" },
      ]);
      return;
    }
    if (isDirty && isPathAffected(payload.path)) {
      updateIssues(1, "未保存の変更があります。移動前に保存してください。", "error", [
        { severity: "error", message: "未保存の変更があります。移動前に保存してください。" },
      ]);
      return;
    }
    postToNative({ type: "moveItem", path: payload.path, destination: targetFolder });
  };

  const renderFileNodes = (nodes: FileNode[], container: HTMLElement, depth: number) => {
    nodes.forEach((node) => {
      if (node.type === "dir") {
        const details = document.createElement("details");
        details.className = "file-folder";
        details.dataset.path = node.path;
        if (openStateLoaded) {
          details.open = openFolders.has(node.path);
        } else {
          details.open = depth < 1;
        }
        const summary = document.createElement("summary");
        summary.textContent = node.name;
        summary.style.paddingLeft = `${6 + depth * 12}px`;
        summary.draggable = true;
        summary.classList.toggle("is-open", details.open);
        if (selectedTreeType === "dir" && selectedTreePath === node.path) {
          summary.classList.add("is-selected");
        }
        const toggleFolder = (nextOpen: boolean) => {
          details.open = nextOpen;
          summary.classList.toggle("is-open", nextOpen);
          if (nextOpen) {
            openFolders.add(node.path);
          } else {
            openFolders.delete(node.path);
          }
          saveOpenState();
        };
        summary.addEventListener("mousedown", (event) => {
          // Prevent focus stealing from editor during IME composition
          if (isComposing) {
            event.preventDefault();
          }
        });
        summary.addEventListener("click", (event) => {

          event.preventDefault();
          selectFolderSummary(summary, node.path);
          toggleFolder(!details.open);
        });
        summary.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          selectFolderSummary(summary, node.path);
          openContextMenu(event.clientX, event.clientY, buildFolderContextMenu(node.path));
        });
        summary.addEventListener("dragstart", (event) => {
          const dragEvent = event as DragEvent;
          const payload: DragPayload = { path: node.path, kind: "dir" };
          setDragData(dragEvent, payload);
          dragPayload = payload;
          summary.classList.add("is-dragging");
        });
        summary.addEventListener("dragend", () => {
          dragPayload = null;
          summary.classList.remove("is-dragging");
          clearDropTargets();
        });
        summary.addEventListener("dragover", (event) => {
          const dragEvent = event as DragEvent;
          dragEvent.stopPropagation();
          const payload = dragPayload ?? getDragData(dragEvent);
          if (!payload || !canDropOnFolder(payload, node.path)) {
            return;
          }
          dragEvent.preventDefault();
          clearDropTargets();
          summary.classList.add("is-drop-target");
        });
        summary.addEventListener("dragleave", () => {
          summary.classList.remove("is-drop-target");
        });
        summary.addEventListener("drop", (event) => {
          const dragEvent = event as DragEvent;
          const payload = dragPayload ?? getDragData(dragEvent);
          dragEvent.stopPropagation();
          dragEvent.preventDefault();
          summary.classList.remove("is-drop-target");
          if (!payload) {
            return;
          }
          requestMoveItem(payload, node.path);
        });
        summary.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectFolderSummary(summary, node.path);
            toggleFolder(!details.open);
          }
        });
        const children = document.createElement("div");
        children.className = "file-folder-children";
        details.append(summary, children);
        renderFileNodes(node.children, children, depth + 1);
        container.appendChild(details);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-item";
        button.textContent = node.name;
        button.style.paddingLeft = `${18 + depth * 12}px`;
        button.dataset.path = node.path;
        button.draggable = true;
        if (dirtyFiles.has(node.path)) {
          button.classList.add("is-dirty");
        }
        if (node.path === currentFilePath) {
          button.classList.add("is-active");
        }
        button.addEventListener("click", () => {
          const opened = requestOpenFile(node.path);
          if (opened) {
            selectedTreePath = node.path;
            selectedTreeType = "file";
            setTreeFocus(true);
          }
        });
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          selectedTreePath = node.path;
          selectedTreeType = "file";
          setTreeFocus(true);
          openContextMenu(event.clientX, event.clientY, buildFileContextMenu(node.path));
        });
        button.addEventListener("dragstart", (event) => {
          const dragEvent = event as DragEvent;
          const payload: DragPayload = { path: node.path, kind: "file" };
          setDragData(dragEvent, payload);
          dragPayload = payload;
          button.classList.add("is-dragging");
        });
        button.addEventListener("dragend", () => {
          dragPayload = null;
          button.classList.remove("is-dragging");
          clearDropTargets();
        });
        button.addEventListener("dragover", (event) => {
          const dragEvent = event as DragEvent;
          dragEvent.stopPropagation();
          const payload = dragPayload ?? getDragData(dragEvent);
          const targetFolder = getParentPath(node.path);
          if (!payload || !canDropOnFolder(payload, targetFolder)) {
            return;
          }
          const dropContainer =
            button.parentElement instanceof HTMLElement ? button.parentElement : null;
          dragEvent.preventDefault();
          clearDropTargets();
          if (dropContainer) {
            dropContainer.classList.add("is-drop-target");
          }
          button.classList.add("is-drop-target");
        });
        button.addEventListener("dragleave", () => {
          const dropContainer =
            button.parentElement instanceof HTMLElement ? button.parentElement : null;
          if (dropContainer) {
            dropContainer.classList.remove("is-drop-target");
          }
          button.classList.remove("is-drop-target");
        });
        button.addEventListener("drop", (event) => {
          const dragEvent = event as DragEvent;
          const payload = dragPayload ?? getDragData(dragEvent);
          const targetFolder = getParentPath(node.path);
          dragEvent.stopPropagation();
          dragEvent.preventDefault();
          const dropContainer =
            button.parentElement instanceof HTMLElement ? button.parentElement : null;
          if (dropContainer) {
            dropContainer.classList.remove("is-drop-target");
          }
          button.classList.remove("is-drop-target");
          if (!payload) {
            return;
          }
          requestMoveItem(payload, targetFolder);
        });
        container.appendChild(button);
      }
    });
  };

  const renderFileTree = () => {
    if (!(fileTree instanceof HTMLElement)) {
      return;
    }
    fileTree.innerHTML = "";
    if (workspaceFiles.length === 0 && workspaceFolders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent =
        workspaceName === "ワークスペース未選択"
          ? "フォルダを開いてください。"
          : "ファイルが見つかりません。";
      fileTree.appendChild(empty);
      return;
    }
    const tree = buildFileTree(workspaceFiles, workspaceFolders);
    renderFileNodes(tree, fileTree, 0);
  };

  const ensureModelEntry = (path: string, content: string, savedContent?: string) => {
    if (!monacoApi) {
      return null;
    }
    const entry = monacoModels.get(path);
    if (entry) {
      const isEntryDirty = dirtyFiles.has(path);
      if (!isEntryDirty && savedContent !== undefined && entry.savedContent !== savedContent) {
        entry.model.setValue(content);
        entry.savedContent = savedContent;
        updateDirtyState(path, content, savedContent);
      }
      return entry;
    }
    const monacoApiAny = monacoApi as {
      editor?: { createModel?: (value: string, languageId: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    const model = monacoApiAny.editor.createModel(
      content,
      getLanguageIdForPath(path)
    ) as MonacoModel;
    const nextEntry = { model, savedContent: savedContent ?? content };
    monacoModels.set(path, nextEntry);
    updateDirtyState(path, content, nextEntry.savedContent);
    return nextEntry;
  };

  const applyFileContent = (path: string, content: string, savedContent?: string) => {
    if (!monacoEditor || !monacoApi) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    const editor = monacoEditor as {
      setModel?: (model: unknown) => void;
      setValue?: (value: string) => void;
      getValue?: () => string;
      restoreViewState?: (state: unknown) => void;
      focus?: () => void;
    };
    const entry = ensureModelEntry(path, content, savedContent ?? content);
    clearJumpHighlight();
    isApplyingFile = true;
    if (entry && editor.setModel) {
      editor.setModel(entry.model as unknown);
    } else if (editor.setValue) {
      editor.setValue(content);
    }
    isApplyingFile = false;
    currentFilePath = path;
    currentFileSavedContent = entry?.savedContent ?? (savedContent ?? content);
    if (entry) {
      updateDirtyState(path, entry.model.getValue(), entry.savedContent);
    } else if (editor.getValue) {
      updateDirtyState(path, editor.getValue(), currentFileSavedContent ?? content);
    } else {
      updateDirtyState(path, content, currentFileSavedContent ?? content);
    }
    restoreViewState(path);
    autoBuildPending = false;
    selectedTreePath = path;
    selectedTreeType = "file";
    addOpenTab(path);
    setEditorLanguage(path);
    updateBreadcrumbs();
    updateMiniOutline();
    renderOutline();
    renderFileTree();
    blockPreviewActive = false;
    clearInsertPreview();
    setAutoDetectedUi(false);
    if (pendingReveal && pendingReveal.path === path) {
      revealLine(pendingReveal.line);
      pendingReveal = null;
    }
    if (editor.focus) {
      editor.focus();
      setTreeFocus(false);
    }
  };

  const requestOpenFile = (path: string, force = false) => {
    if (currentFilePath === path) {
      return false;
    }
    // Always cache buffer immediately (preserves IME composition text)
    if (!force) {
      cacheCurrentBuffer();
    }
    const ok = postToNative({ type: "openFile", path });
    if (!ok) {
      updateIssues(1, "ファイルを開けません。", "error", [
        { severity: "error", message: "ファイルを開けません。" },
      ]);
    }
    return ok;
  };

  const jumpToFileLine = (path: string, line: number) => {
    if (currentFilePath === path) {
      revealLine(line);
      return;
    }
    const requested = requestOpenFile(path);
    if (requested) {
      pendingReveal = { path, line };
    }
  };

  const jumpToLocation = (entry: IndexEntry) => {
    if (!entry.path || !entry.line) {
      return;
    }
    jumpToFileLine(entry.path, entry.line);
  };

  const jumpToSearchResult = (result: SearchResult) => {
    jumpToFileLine(result.path, result.line);
  };

  const saveCurrentFileInternal = () => {
    if (!currentFilePath || !monacoEditor) {
      updateIssues(1, "保存するファイルが選択されていません。", "error", [
        { severity: "error", message: "保存するファイルが選択されていません。" },
      ]);
      return Promise.resolve(false);
    }
    const editor = monacoEditor as { getValue: () => string };
    const content = editor.getValue();
    return new Promise<boolean>((resolve, reject) => {
      pendingSave = { path: currentFilePath as string, content, resolve, reject };
      const ok = postToNative({ type: "saveFile", path: currentFilePath, content });
      if (!ok) {
        pendingSave = null;
        reject("ネイティブ連携が利用できません。");
      }
    });
  };

  const saveCurrentFile = () => {
    if (!isComposing) {
      return saveCurrentFileInternal();
    }
    return new Promise<boolean>((resolve, reject) => {
      scheduleAfterComposition(() => {
        saveCurrentFileInternal().then(resolve).catch(reject);
      });
    });
  };

  const normalizeInputPath = (value: string) => {
    return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  };

  const validatePath = (value: string, kind: "file" | "folder") => {
    if (!value) {
      return "名前を入力してください。";
    }
    if (value.includes("..")) {
      return "親ディレクトリを含む名前は使えません。";
    }
    if (value.startsWith("/")) {
      return "絶対パスは使えません。";
    }
    if (kind === "file" && value.endsWith("/")) {
      return "ファイル名に末尾の / は使えません。";
    }
    return null;
  };

  const isPathAffected = (relativePath: string) => {
    if (!currentFilePath) {
      return false;
    }
    if (currentFilePath === relativePath) {
      return true;
    }
    return currentFilePath.startsWith(`${relativePath}/`);
  };

  const getParentPath = (value: string) => {
    const parts = value.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  };

  const resolveCreateBasePath = () => {
    if (selectedTreeType === "dir" && selectedTreePath) {
      return selectedTreePath;
    }
    if (selectedTreeType === "file" && selectedTreePath) {
      return getParentPath(selectedTreePath);
    }
    if (currentFilePath) {
      return getParentPath(currentFilePath);
    }
    return "";
  };

  const resolvePasteTarget = () => {
    if (selectedTreeType === "dir" && selectedTreePath) {
      return selectedTreePath;
    }
    if (selectedTreeType === "file" && selectedTreePath) {
      return getParentPath(selectedTreePath);
    }
    if (currentFilePath) {
      return getParentPath(currentFilePath);
    }
    return "";
  };

  const setCreateModalOpen = (open: boolean) => {
    if (!createModal) {
      return;
    }
    createModal.classList.toggle("is-open", open);
    createModal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const setCreateModalHelp = (message: string, isError = false) => {
    if (!createModalHelp) {
      return;
    }
    createModalHelp.textContent = message;
    createModalHelp.classList.toggle("is-error", isError);
  };

  const openCreateModal = (kind: CreateKind) => {
    if (!createModal) {
      return;
    }
    createModalKind = kind;
    const basePath = resolveCreateBasePath();
    setText(createModalTitle, kind === "file" ? "新規ファイルを作成" : "新規フォルダを作成");
    setText(
      createModalSubtitle,
      kind === "file"
        ? "作成するファイル名を入力してください。"
        : "作成するフォルダ名を入力してください。"
    );
    setText(createModalParent, basePath ? basePath : "ワークスペース直下");
    setText(createModalLabel, kind === "file" ? "ファイル名（拡張子付き）" : "フォルダ名");
    if (createModalInput instanceof HTMLInputElement) {
      createModalInput.value = "";
      createModalInput.placeholder =
        kind === "file" ? "例: sections/intro.tex" : "例: sections";
      requestAnimationFrame(() => {
        createModalInput.focus();
      });
    }
    setCreateModalHelp("");
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    createModalKind = null;
    setCreateModalHelp("");
    setCreateModalOpen(false);
  };

  const submitCreateModal = () => {
    if (!createModalKind) {
      return;
    }
    if (!workspaceRootKey) {
      updateIssues(1, "起動時にフォルダを選択してください。", "error", [
        { severity: "error", message: "起動時にフォルダを選択してください。" },
      ]);
      return;
    }
    if (!(createModalInput instanceof HTMLInputElement)) {
      return;
    }
    const rawValue = createModalInput.value.trim();
    if (!rawValue) {
      setCreateModalHelp("名前を入力してください。", true);
      return;
    }
    let value = normalizeInputPath(rawValue);
    if (createModalKind === "folder") {
      value = value.replace(/\/+$/, "");
    }
    const basePath = resolveCreateBasePath();
    const fullPath = basePath ? `${basePath}/${value}` : value;
    const error = validatePath(fullPath, createModalKind === "file" ? "file" : "folder");
    if (error) {
      setCreateModalHelp(error, true);
      updateIssues(1, error, "error", [{ severity: "error", message: error }]);
      return;
    }
    const payload = {
      type: createModalKind === "file" ? "createFile" : "createFolder",
      path: fullPath,
    };
    postToNative(payload);
    closeCreateModal();
  };

  const requestCreate = (kind: CreateKind) => {
    if (!workspaceRootKey) {
      updateIssues(1, "起動時にフォルダを選択してください。", "error", [
        { severity: "error", message: "起動時にフォルダを選択してください。" },
      ]);
      return;
    }
    if (createModal instanceof HTMLElement) {
      openCreateModal(kind);
      return;
    }
    const title =
      kind === "file"
        ? "新規ファイル名を入力してください（例: chapter/intro.tex）"
        : "新規フォルダ名を入力してください（例: chapter）";
    const input = window.prompt(title);
    if (!input) {
      return;
    }
    const value = normalizeInputPath(input);
    const error = validatePath(value, kind);
    if (error) {
      updateIssues(1, error, "error", [{ severity: "error", message: error }]);
      return;
    }
    const payload = { type: kind === "file" ? "createFile" : "createFolder", path: value };
    postToNative(payload);
  };

  const setRenameModalOpen = (open: boolean) => {
    if (!renameModal) {
      return;
    }
    renameModal.classList.toggle("is-open", open);
    renameModal.setAttribute("aria-hidden", open ? "false" : "true");
  };

  const setRenameModalHelp = (message: string, isError = false) => {
    if (!renameModalHelp) {
      return;
    }
    renameModalHelp.textContent = message;
    renameModalHelp.classList.toggle("is-error", isError);
  };

  const openRenameModal = (path: string, kind: "file" | "dir") => {
    if (!renameModal) {
      return;
    }
    renameTargetPath = path;
    renameTargetType = kind;
    const currentName = path.split("/").filter(Boolean).pop() ?? "";
    setText(renameModalTitle, "名前の変更");
    setText(renameModalTarget, path);
    if (renameModalInput instanceof HTMLInputElement) {
      renameModalInput.value = currentName;
      renameModalInput.placeholder = "新しい名前";
      requestAnimationFrame(() => {
        renameModalInput.focus();
        renameModalInput.select();
      });
    }
    setRenameModalHelp("");
    setRenameModalOpen(true);
  };

  const closeRenameModal = () => {
    renameTargetPath = null;
    renameTargetType = null;
    setRenameModalHelp("");
    setRenameModalOpen(false);
  };

  const submitRenameModal = () => {
    if (!renameTargetPath || !renameTargetType) {
      return;
    }
    if (isDirty && isPathAffected(renameTargetPath)) {
      const message = "未保存の変更があります。保存してから名前を変更してください。";
      setRenameModalHelp(message, true);
      updateIssues(1, message, "error", [{ severity: "error", message }]);
      return;
    }
    if (!(renameModalInput instanceof HTMLInputElement)) {
      return;
    }
    const rawValue = renameModalInput.value.trim();
    if (!rawValue) {
      setRenameModalHelp("名前を入力してください。", true);
      return;
    }
    if (rawValue.includes("/")) {
      setRenameModalHelp("名前に / は使えません。", true);
      return;
    }
    const payload = { type: "renameItem", path: renameTargetPath, newName: rawValue };
    postToNative(payload);
    closeRenameModal();
  };

  const updateIssues = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    setText(issuesCount, String(count));
    setText(issuesHint, summary);
    setIssuesStatus(status);
    renderIssues(issues);
    if (count > 0) {
      setIssuesOpen(true);
    } else {
      setIssuesOpen(false);
      clearIssueHighlight();
    }
  };

  type ContextMenuItem =
    | { type: "separator" }
    | {
        type: "action";
        label: string;
        shortcut?: string;
        danger?: boolean;
        enabled?: boolean;
        action: () => void;
      };

  const closeContextMenu = () => {
    if (!contextMenu || !contextMenuPanel) {
      return;
    }
    contextMenuOpen = false;
    contextMenu.classList.remove("is-open");
    contextMenu.setAttribute("aria-hidden", "true");
    contextMenuPanel.innerHTML = "";
  };

  const openContextMenu = (x: number, y: number, items: ContextMenuItem[]) => {
    if (!contextMenu || !contextMenuPanel) {
      return;
    }
    contextMenuPanel.innerHTML = "";
    items.forEach((item) => {
      if (item.type === "separator") {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        contextMenuPanel.appendChild(separator);
        return;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-menu-item";
      button.textContent = item.label;
      if (item.shortcut) {
        const shortcut = document.createElement("span");
        shortcut.className = "context-menu-shortcut";
        shortcut.textContent = item.shortcut;
        button.appendChild(shortcut);
      }
      if (item.danger) {
        button.classList.add("is-danger");
      }
      const enabled = item.enabled !== false;
      button.disabled = !enabled;
      if (enabled) {
        button.addEventListener("click", () => {
          item.action();
          closeContextMenu();
        });
      }
      contextMenuPanel.appendChild(button);
    });
    contextMenu.classList.add("is-open");
    contextMenu.setAttribute("aria-hidden", "false");
    contextMenuOpen = true;
    requestAnimationFrame(() => {
      const rect = contextMenuPanel.getBoundingClientRect();
      let left = x;
      let top = y;
      const padding = 8;
      if (left + rect.width > window.innerWidth - padding) {
        left = window.innerWidth - rect.width - padding;
      }
      if (top + rect.height > window.innerHeight - padding) {
        top = window.innerHeight - rect.height - padding;
      }
      if (left < padding) {
        left = padding;
      }
      if (top < padding) {
        top = padding;
      }
      contextMenuPanel.style.left = `${left}px`;
      contextMenuPanel.style.top = `${top}px`;
    });
  };

  const requestRevealInFinder = (path: string) => {
    postToNative({ type: "revealInFinder", path });
  };

  const requestDeleteItem = (path: string, kind: "file" | "dir") => {
    // TODO: re-enable confirm dialogs after fixing host input issue
    postToNative({ type: "deleteItem", path });
  };

  const requestCopyItem = (path: string, destination: string) => {
    postToNative({ type: "copyItem", path, destination });
  };

  const requestUndoFileOperation = () => {
    postToNative({ type: "undoFileOperation" });
  };

  const pasteClipboard = () => {
    if (!fileClipboard) {
      return;
    }
    const destination = resolvePasteTarget();
    if (!canDropOnFolder(fileClipboard, destination)) {
      updateIssues(1, "移動先が不正です。", "error", [
        { severity: "error", message: "移動先が不正です。" },
      ]);
      return;
    }
    if (fileClipboard.mode === "cut") {
      requestMoveItem(fileClipboard, destination);
      fileClipboard = null;
      return;
    }
    requestCopyItem(fileClipboard.path, destination);
  };

  const buildFileContextMenu = (path: string): ContextMenuItem[] => [
    {
      type: "action",
      label: "開く",
      action: () => {
        requestOpenFile(path);
      },
    },
    {
      type: "action",
      label: "新しいファイル...",
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "file";
        requestCreate("file");
      },
    },
    {
      type: "action",
      label: "新しいフォルダー...",
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "file";
        requestCreate("folder");
      },
    },
    {
      type: "action",
      label: "Finderで表示",
      action: () => requestRevealInFinder(path),
    },
    { type: "separator" },
    {
      type: "action",
      label: "名前の変更...",
      action: () => openRenameModal(path, "file"),
    },
    {
      type: "action",
      label: "削除",
      danger: true,
      action: () => requestDeleteItem(path, "file"),
    },
  ];

  const buildFolderContextMenu = (path: string): ContextMenuItem[] => [
    {
      type: "action",
      label: "新しいファイル...",
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "dir";
        requestCreate("file");
      },
    },
    {
      type: "action",
      label: "新しいフォルダー...",
      action: () => {
        selectedTreePath = path;
        selectedTreeType = "dir";
        requestCreate("folder");
      },
    },
    {
      type: "action",
      label: "Finderで表示",
      action: () => requestRevealInFinder(path),
    },
    { type: "separator" },
    {
      type: "action",
      label: "名前の変更...",
      action: () => openRenameModal(path, "dir"),
    },
    {
      type: "action",
      label: "削除",
      danger: true,
      action: () => requestDeleteItem(path, "dir"),
    },
  ];

  const setBuildState = (state: BuildState, message?: string) => {
    if (buildButton instanceof HTMLButtonElement) {
      const isBusy = state === "building";
      buildButton.disabled = isBusy;
      buildButton.classList.toggle("is-busy", isBusy);
      buildButton.textContent = isBusy ? "ビルド中..." : "ビルド";
    }
    if (message && state === "building") {
      updateIssues(0, message, "info", []);
    }
  };

  const postToNative = (
    payload: { type: string; [key: string]: unknown },
    silent = false
  ) => {
    const handler = bridgeWindow.tex180Bridge ?? bridgeWindow.webkit?.messageHandlers?.tex180;
    if (!handler || typeof handler.postMessage !== "function") {
      if (!silent) {
        updateIssues(1, "ネイティブ連携が利用できません。", "error", [
          { severity: "error", message: "ネイティブ連携が利用できません。" },
        ]);
      }
      return false;
    }
    handler.postMessage(payload);
    return true;
  };

  const startBuild = () => {
    cacheCurrentBuffer();
    
    const mainFile =
      rootFilePath ??
      (currentFilePath && currentFilePath.endsWith(".tex")
        ? currentFilePath
        : undefined);
    const payload: { type: string; mainFile?: string } = { type: "build" };
    if (mainFile) {
      payload.mainFile = mainFile;
    }
    if (postToNative(payload)) {
      setBuildState("building");
      updateIssues(0, "ビルドを開始します。", "info", []);
    }
  };

  const handleLauncherStatus = (payload: { isBusy?: boolean; message?: string }) => {
    setLauncherStatus({
      isBusy: typeof payload.isBusy === "boolean" ? payload.isBusy : undefined,
      message: payload.message ?? null,
    });
  };

  const handleWorkspaceUpdate = (payload: {
    rootName: string;
    rootPath: string;
    files: string[];
    folders?: string[];
    rootFile?: string;
    rootSource?: RootSource;
  }) => {
    const previousRoot = workspaceRootKey;
    workspaceFiles = payload.files;
    workspaceFolders = Array.isArray(payload.folders) ? payload.folders : [];
    workspaceRootKey = payload.rootPath;
    setWorkspaceLabel(payload.rootName);
    setText(settingsWorkspace, payload.rootPath);
    if (payload.rootPath) {
      setLauncherVisible(false);
      setLauncherStatus({ isBusy: false, message: null });
    }
    rootFilePath = payload.rootFile?.trim() ? payload.rootFile : null;
    rootSource =
      payload.rootSource === "manual" || payload.rootSource === "auto"
        ? payload.rootSource
        : "auto";
    if (previousRoot && previousRoot !== payload.rootPath) {
      currentFilePath = null;
      currentFileSavedContent = null;
      isDirty = false;
      pendingReveal = null;
      selectedTreePath = null;
      selectedTreeType = null;
      openTabs = [];
      monacoModels.clear();
      monacoViewStates.clear();
      dirtyFiles.clear();
    }
    if (monacoModels.size > 0) {
      Array.from(monacoModels.keys()).forEach((path) => {
        if (!workspaceFiles.includes(path)) {
          monacoModels.delete(path);
          dirtyFiles.delete(path);
        }
      });
    }
    if (monacoViewStates.size > 0) {
      Array.from(monacoViewStates.keys()).forEach((path) => {
        if (!workspaceFiles.includes(path)) {
          monacoViewStates.delete(path);
        }
      });
    }
    if (currentFilePath && !workspaceFiles.includes(currentFilePath)) {
      currentFilePath = null;
      currentFileSavedContent = null;
      isDirty = false;
      selectedTreePath = null;
      selectedTreeType = null;
    }
    if (openTabs.length > 0) {
      openTabs = openTabs.filter((path) => workspaceFiles.includes(path));
      if (currentFilePath && !openTabs.includes(currentFilePath)) {
        currentFilePath = null;
        currentFileSavedContent = null;
        isDirty = false;
      }
    }
    if (currentFilePath) {
      isDirty = dirtyFiles.has(currentFilePath);
    }
    loadOpenState();
    renderFileTree();
    updateBreadcrumbs();
    renderOutline();
    searchResultsData = [];
    searchMessage = "検索結果はここに表示します。";
    renderSearchResults();
    gitEntries = [];
    gitMessage = "Gitステータスはここに表示します。";
    renderGitStatus();
    autoBuildPending = false;
    loadAutoBuildState();
    renderRootSelector();
    requestInitialOpen();
  };

  const handleIndexUpdate = (payload: {
    labels?: IndexEntry[];
    references?: IndexEntry[];
    citations?: IndexEntry[];
    sections?: SectionEntry[];
    figures?: IndexEntry[];
    tables?: IndexEntry[];
    todos?: IndexEntry[];
  }) => {
    indexLabels = Array.isArray(payload.labels) ? payload.labels : [];
    indexCitations = Array.isArray(payload.citations) ? payload.citations : [];
    indexSections = Array.isArray(payload.sections) ? payload.sections : [];
    indexTodos = Array.isArray(payload.todos) ? payload.todos : [];
    renderOutline();
  };

  const handleOpenFileResult = (payload: {
    path: string;
    content?: string;
    error?: string;
  }) => {
    if (payload.error) {
      if (pendingReveal && pendingReveal.path === payload.path) {
        pendingReveal = null;
      }
      updateIssues(1, payload.error, "error", [
        { severity: "error", message: payload.error },
      ]);
      return;
    }
    const content = payload.content ?? "";
    applyFileContent(payload.path, content, content);
  };

  const handleSaveResult = (payload: { path: string; ok: boolean; error?: string }) => {
    let savedContent: string | null = null;
    if (pendingSave && pendingSave.path === payload.path) {
      if (payload.ok) {
        savedContent = pendingSave.content;
        pendingSave.resolve(true);
      } else {
        pendingSave.reject(payload.error ?? "保存に失敗しました。");
      }
      pendingSave = null;
    }
    if (!payload.ok) {
      updateIssues(1, payload.error ?? "保存に失敗しました。", "error", [
        { severity: "error", message: payload.error ?? "保存に失敗しました。" },
      ]);
      return;
    }
    if (savedContent !== null) {
      const entry = monacoModels.get(payload.path);
      if (entry) {
        entry.savedContent = savedContent;
      }
      dirtyFiles.delete(payload.path);
    }
    if (currentFilePath === payload.path) {
      if (savedContent !== null) {
        currentFileSavedContent = savedContent;
      }
      if (monacoEditor && currentFileSavedContent !== null) {
        const editor = monacoEditor as { getValue: () => string };
        const currentValue = editor.getValue();
        updateDirtyState(payload.path, currentValue, currentFileSavedContent);
      } else {
        isDirty = false;
      }
    } else {
      isDirty = currentFilePath ? dirtyFiles.has(currentFilePath) : false;
    }
    updateBreadcrumbs();
    renderFileTree();
    if (autoBuildEnabled && autoBuildPending && currentFilePath?.endsWith(".tex")) {
      autoBuildPending = false;
      startBuild();
    }
  };

  const handleRenameResult = (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => {
    const { oldPath, newPath } = payload;
    const remapPath = (path: string) => {
      if (payload.isDirectory) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          return newPath + path.slice(oldPath.length);
        }
        return path;
      }
      return path === oldPath ? newPath : path;
    };
    let currentPathChanged = false;
    if (payload.isDirectory) {
      openTabs = openTabs.map((entry) => {
        if (entry === oldPath || entry.startsWith(`${oldPath}/`)) {
          return newPath + entry.slice(oldPath.length);
        }
        return entry;
      });
      const updated = new Set<string>();
      openFolders.forEach((entry) => {
        if (entry === oldPath || entry.startsWith(`${oldPath}/`)) {
          updated.add(newPath + entry.slice(oldPath.length));
        } else {
          updated.add(entry);
        }
      });
      openFolders = updated;
      saveOpenState();
      if (selectedTreeType === "dir" && selectedTreePath) {
        if (selectedTreePath === oldPath || selectedTreePath.startsWith(`${oldPath}/`)) {
          selectedTreePath = newPath + selectedTreePath.slice(oldPath.length);
        }
      }
      if (currentFilePath && currentFilePath.startsWith(`${oldPath}/`)) {
        currentFilePath = newPath + currentFilePath.slice(oldPath.length);
        currentPathChanged = true;
      }
    } else if (currentFilePath === oldPath) {
      currentFilePath = newPath;
      currentPathChanged = true;
    }
    const tabIndex = openTabs.indexOf(oldPath);
    if (tabIndex !== -1) {
      openTabs = openTabs.map((entry) => (entry === oldPath ? newPath : entry));
    }
    if (monacoModels.size > 0) {
      const updatedModels = new Map<string, MonacoModelEntry>();
      monacoModels.forEach((entry, path) => {
        updatedModels.set(remapPath(path), entry);
      });
      monacoModels.clear();
      updatedModels.forEach((entry, path) => monacoModels.set(path, entry));
    }
    if (monacoViewStates.size > 0) {
      const updatedViewStates = new Map<string, MonacoViewState>();
      monacoViewStates.forEach((state, path) => {
        updatedViewStates.set(remapPath(path), state);
      });
      monacoViewStates.clear();
      updatedViewStates.forEach((state, path) => monacoViewStates.set(path, state));
    }
    if (dirtyFiles.size > 0) {
      const updatedDirty = new Set<string>();
      dirtyFiles.forEach((path) => {
        updatedDirty.add(remapPath(path));
      });
      dirtyFiles.clear();
      updatedDirty.forEach((path) => dirtyFiles.add(path));
    }
    if (currentFilePath) {
      isDirty = dirtyFiles.has(currentFilePath);
      setEditorLanguage(currentFilePath);
    }
    if (currentPathChanged && !isDirty) {
      const entry = currentFilePath ? monacoModels.get(currentFilePath) : null;
      if (entry) {
        currentFileSavedContent = entry.savedContent;
      } else if (monacoEditor) {
        const editor = monacoEditor as { getValue: () => string };
        currentFileSavedContent = editor.getValue();
      }
    }
    updateBreadcrumbs();
    updateMiniOutline();
    renderFileTree();
  };

  const normalizeTabKey = (key: string | undefined): TabKey => {
    if (key && key in tabConfig) {
      return key as TabKey;
    }
    return "files";
  };

  const setActiveTab = (tabKey: TabKey) => {
    const config = tabConfig[tabKey];

    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === tabKey;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    activeTab = tabKey;
    document.body.dataset.activeTab = tabKey;
    sidebarPanels.forEach((panel) => {
      const isActive = panel.dataset.panel === tabKey;
      panel.classList.toggle("is-active", isActive);
    });
    setText(miniOutline, config.outline);
    setText(editorTitle, config.title);
    setText(editorDesc, config.desc);
    setText(editorHint, config.hint);
    if (tabKey === "files") {
      updateMiniOutline();
    }
    if (tabKey === "git") {
      requestGitStatus();
    }
    updateMathKeyboardVisibility();
  };

  const initialTab = normalizeTabKey(
    tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.tab
  );
  setActiveTab(initialTab);
  setWorkspaceLabel(workspaceName);
  updateBreadcrumbs();
  renderFileTree();
  renderOutline();
  setActiveBlockType(activeBlockType);
  setMathKeyboardTab(activeMathKeyboardTab);
  try { setupMathField(); } catch (e: any) { 
    console.error("setupMathField error:", e);
    updateIssues(1, "数式エディタの初期化に失敗しました: " + e.message, "error", []);
  }
  try { setupResizer(); } catch (e: any) { 
    console.error("setupResizer error:", e); 
    // リサイズ機能のエラーは致命的ではないので通知しないか、infoレベルで
  }
  try { attachMathInputListener(); } catch (e: any) { 
    console.error("attachMathInputListener error:", e);
    // updateIssues(1, "数式入力リスナーのエラー: " + e.message, "error", []);
  }
  try { updateMathPreview(); } catch (e: any) { console.error("updateMathPreview error:", e); }
  renderSearchResults();
  renderGitStatus();
  renderRootSelector();
  updateIssues(0, "ビルド結果はここに要約します。", "info", []);
  updateLauncherTemplate(launcherTemplate);
  if (!workspaceRootKey) {
    setLauncherVisible(true);
    setLauncherStatus({ isBusy: false, message: null });
  }
  postToNative({ type: "ready" }, true);

  if (autoBuildButton instanceof HTMLButtonElement) {
    updateAutoBuildUI();
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(normalizeTabKey(tab.dataset.tab));
    });
  });

  launcherTemplateButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const template = button.dataset.template === "lecture" ? "lecture" : "paper";
      updateLauncherTemplate(template);
    });
  });

  if (launcherCreateButton instanceof HTMLButtonElement) {
    launcherCreateButton.addEventListener("click", () => {
      if (launcherBusy) {
        return;
      }
      setLauncherStatus({ isBusy: true, message: null });
      postToNative({ type: "createProject", template: launcherTemplate });
    });
  }

  if (launcherOpenButton instanceof HTMLButtonElement) {
    launcherOpenButton.addEventListener("click", () => {
      if (launcherBusy) {
        return;
      }
      setLauncherStatus({ isBusy: true, message: null });
      postToNative({ type: "openWorkspace" });
    });
  }

  const editorHost = document.getElementById("editor");
  const fallback = document.getElementById("editor-fallback");

  if (editorHost instanceof HTMLElement) {
    editorHost.addEventListener("mousedown", () => {
      setTreeFocus(false);
    });
  }

  const updateFallback = (message: string) => {
    if (!fallback) {
      return;
    }
    const body = fallback.querySelector("p");
    if (body) {
      body.textContent = message;
    }
  };

  const registerCompletionProvider = (monaco: {
    languages?: {
      register?: (config: { id: string }) => void;
      registerCompletionItemProvider?: (
        languageId: string,
        provider: {
          triggerCharacters?: string[];
          provideCompletionItems: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number }
          ) => { suggestions: unknown[] };
        }
      ) => void;
      CompletionItemKind?: { Reference?: number; Value?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  }) => {
    if (completionRegistered || !monaco.languages?.registerCompletionItemProvider) {
      return;
    }
    monaco.languages.register?.({ id: "latex" });
    monaco.languages.register?.({ id: "bibtex" });

    const provideItems = (
      model: { getLineContent: (lineNumber: number) => string },
      position: { lineNumber: number; column: number }
    ) => {
      if (!currentFilePath || !currentFilePath.endsWith(".tex")) {
        return { suggestions: [] };
      }
      const line = model.getLineContent(position.lineNumber);
      const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
      const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
      const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);

      let entries: IndexEntry[] = [];
      let partial = "";

      if (refMatch) {
        entries = dedupeByKey(indexLabels);
        partial = refMatch[1] ?? "";
      } else if (citeMatch) {
        entries = pickCitationEntries(indexCitations);
        const raw = citeMatch[1] ?? "";
        const parts = raw.split(",");
        partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
      } else {
        return { suggestions: [] };
      }

      const range = monaco.Range
        ? new monaco.Range(
            position.lineNumber,
            position.column - partial.length,
            position.lineNumber,
            position.column
          )
        : undefined;

      const kind =
        monaco.languages?.CompletionItemKind?.Reference ??
        monaco.languages?.CompletionItemKind?.Value ??
        17;

      const suggestions = entries.map((entry) => ({
        label: entry.key,
        kind,
        insertText: entry.key,
        range,
        detail: entry.path,
      }));

      return { suggestions };
    };

    ["latex", "plaintext"].forEach((languageId) => {
      monaco.languages?.registerCompletionItemProvider?.(languageId, {
        triggerCharacters: ["{", ",", "\\"],
        provideCompletionItems: provideItems,
      });
    });

    completionRegistered = true;
  };

  const setQuickInsertOpen = (isOpen: boolean) => {
    if (quickInsertPanel) {
      quickInsertPanel.classList.toggle("is-open", isOpen);
      quickInsertPanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
    }
    if (quickInsertButton instanceof HTMLElement) {
      quickInsertButton.classList.toggle("is-active", isOpen);
    }
  };

  const buildPreviewText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return "プレビューなし";
    }
    const lines = trimmed.split(/\r?\n/);
    const maxLines = 6;
    if (lines.length <= maxLines) {
      return trimmed;
    }
    const visible = lines.slice(0, maxLines).join("\n");
    return `${visible}\n…（残り${lines.length - maxLines}行）`;
  };

  const clearInsertPreview = () => {
    clearQuickInsertDecorations();
    if (quickInsertWidget && monacoEditor) {
      const editor = monacoEditor as { removeContentWidget: (widget: unknown) => void };
      editor.removeContentWidget(quickInsertWidget);
      quickInsertWidget = null;
    }
  };

  const setInsertPreviewText = (text: string) => {
    const previewText = buildPreviewText(text);
    if (quickInsertWidgetBody) {
      quickInsertWidgetBody.textContent = previewText;
    }
    if (monacoEditor && quickInsertWidget) {
      const editor = monacoEditor as { layoutContentWidget: (widget: unknown) => void };
      editor.layoutContentWidget(quickInsertWidget);
    }
  };

  const updateQuickInsertPreview = () => {
    const value =
      quickInsertInput instanceof HTMLTextAreaElement
        ? quickInsertInput.value
        : "";
    setInsertPreviewText(value);
    if (quickInsertAccept instanceof HTMLButtonElement) {
      quickInsertAccept.disabled = value.trim().length === 0;
    }
  };

  const ensureQuickInsertWidget = () => {
    resetBlockSession();
    const editor = monacoEditor as {
      addContentWidget: (widget: unknown) => void;
      removeContentWidget: (widget: unknown) => void;
    };
    if (quickInsertWidget) {
      editor.removeContentWidget(quickInsertWidget);
    }
    const container = document.createElement("div");
    container.className = "quick-insert-widget";
    const body = document.createElement("pre");
    body.className = "quick-insert-body";
    container.appendChild(body);
    quickInsertWidgetNode = container;
    quickInsertWidgetBody = body;
    setInsertPreviewText("");

    const monacoApiAny = monacoApi as {
      editor: {
        ContentWidgetPositionPreference: { BELOW: unknown; ABOVE: unknown };
      };
    };

    quickInsertWidget = {
      getId: () => "tex180.quickInsertWidget",
      getDomNode: () => container,
      getPosition: () => ({
        position: {
          lineNumber: quickInsertTarget.lineNumber,
          column: quickInsertTarget.column,
        },
        preference: [
          monacoApiAny.editor.ContentWidgetPositionPreference.BELOW,
          monacoApiAny.editor.ContentWidgetPositionPreference.ABOVE,
        ],
      }),
    };
    editor.addContentWidget(quickInsertWidget);
  };

  const showDiffModal = (original: string, modified: string, lineOffset = 0) => {
    if (!monacoApi) return;
    const monacoApiAny = monacoApi as {
      editor: {
        createDiffEditor: (el: HTMLElement, options: unknown) => unknown;
        createModel: (val: string, lang: string) => unknown;
      };
    };
    const container = blockDiffContainer;
    if (!container) return;
    
    if (diffModal) {
      diffModal.classList.add("is-open");
      diffModal.setAttribute("aria-hidden", "false");
    }
    
    if (!diffEditor) {
       container.innerHTML = ""; // Clear only if initializing
       diffEditor = monacoApiAny.editor.createDiffEditor(container, {
        originalEditable: false,
        readOnly: true,
        renderSideBySide: false,
        renderIndicators: true,
        renderMarginRevertIcon: false,
        diffWordWrap: "off",
        wordWrap: "off",
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        lineNumbers: "on",
        fontSize: 13,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      });
    } else {
        const diffEditorAny = diffEditor as {
          getDomNode?: () => HTMLElement | null;
          getContainerDomNode?: () => HTMLElement | null;
          layout?: () => void;
        };
        const diffNode =
          diffEditorAny.getDomNode?.() ?? diffEditorAny.getContainerDomNode?.() ?? null;
        if (diffNode && !container.contains(diffNode)) {
          container.innerHTML = "";
          container.appendChild(diffNode);
        }
        diffEditorAny.layout?.();
    }

    renderDiffHeader();
    renderDiffSummary(original, modified);
    applyDiffLineNumberOffset(lineOffset, original, modified);

    const diffEditorAny = diffEditor as {
      setModel?: (model: { original: unknown; modified: unknown }) => void;
      getModel?: () => { original?: unknown; modified?: unknown } | null;
    };

    diffOriginalModel?.dispose?.();
    diffModifiedModel?.dispose?.();
    diffOriginalModel = monacoApiAny.editor.createModel(original, "latex");
    diffModifiedModel = monacoApiAny.editor.createModel(modified, "latex");
    diffEditorAny.setModel?.({
      original: diffOriginalModel,
      modified: diffModifiedModel,
    });
    if (isE2E) {
      (window as {
        __tex180LastDiff?: { original: string; modified: string; lineOffset: number };
        __tex180DiffEditor?: unknown;
      }).__tex180LastDiff = { original, modified, lineOffset };
      (window as { __tex180DiffEditor?: unknown }).__tex180DiffEditor = diffEditor;
    }
    if (typeof (diffEditor as any).layout === "function") {
      (diffEditor as any).layout();
    }
  };

  const closeDiffModal = () => {
    if (diffModal) {
      diffModal.classList.remove("is-open");
      diffModal.setAttribute("aria-hidden", "true");
    }
    if (diffSummary instanceof HTMLElement) {
      diffSummary.textContent = "";
    }
    if (diffFileName instanceof HTMLElement) {
      diffFileName.textContent = "";
    }
  };

  const startBlockPreview = (
    snippet: string,
    target?: { lineNumber: number; column: number }
  ) => {
    // Deprecated flow but kept for compatibility logic if needed
    // Now redirected to diff modal flow via blockInsertButton
  };

  const applyBlockInsert = (payload?: PendingBlockApply) => {
    const applyPayload = payload ?? pendingBlockApply;
    if (!applyPayload && !blockPreviewActive) {
      updateIssues(1, "プレビューを確認してから確定してください。", "error", [
        { severity: "error", message: "プレビューを確認してから確定してください。" },
      ]);
      return;
    }
    const draft = applyPayload?.draft ?? getBlockDraft();
    if (!draft) {
      updateIssues(1, "ブロック内容が空です。", "error", [
        { severity: "error", message: "ブロック内容が空です。" },
      ]);
      return;
    }
    if (!monacoEditor || !monacoApi) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    if (!currentFilePath || !currentFilePath.endsWith(".tex")) {
      updateIssues(1, "ブロックは .tex ファイルでのみ挿入できます。", "error", [
        { severity: "error", message: "ブロックは .tex ファイルでのみ挿入できます。" },
      ]);
      return;
    }

    const editor = monacoEditor as {
      executeEdits: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus: () => void;
      getPosition: () => { lineNumber: number; column: number } | null;
      getModel?: () => {
        getValue: () => string;
        getPositionAt?: (offset: number) => { lineNumber: number; column: number };
        getOffsetAt?: (pos: { lineNumber: number; column: number }) => number;
      };
    };
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };

    let range: unknown;
    const model = editor.getModel?.();

    const mode: BlockApplyMode =
      applyPayload?.mode ?? (detectedBlockSnapshot ? "detected" : "new");

    if (mode === "detected") {
      const snapshot = applyPayload?.detectedSnapshot ?? detectedBlockSnapshot;
      if (!snapshot || !model?.getPositionAt) {
        updateIssues(1, "対象の数式/表を特定できません。", "error", [
          { severity: "error", message: "対象の数式/表を特定できません。" },
        ]);
        return;
      }
      const content = model.getValue();
      const slice = content.slice(snapshot.start, snapshot.end);
      if (slice !== snapshot.snippet) {
        updateIssues(1, "対象が変更されています。カーソルを置き直してください。", "error", [
          { severity: "error", message: "対象が変更されています。カーソルを置き直してください。" },
        ]);
        return;
      }
      const startPos = model.getPositionAt(snapshot.start);
      const endPos = model.getPositionAt(snapshot.end);
      range = new monacoApiAny.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column
      );
    } else {
      const position = applyPayload?.insertPosition ?? editor.getPosition?.();
      const insertAt = position ?? quickInsertTarget;
      range = new monacoApiAny.Range(
        insertAt.lineNumber,
        insertAt.column,
        insertAt.lineNumber,
        insertAt.column
      );
    }

    editor.executeEdits("block-insert", [
      {
        range,
        text: draft.snippet,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();
    pendingBlockApply = null;
    currentBlockDraft = null;
    resetBlockSession();
  };

  const applyQuickInsertDecorations = () => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    quickInsertDecorations = editor.deltaDecorations(quickInsertDecorations, [
      {
        range: new monacoApiAny.Range(
          quickInsertTarget.lineNumber,
          1,
          quickInsertTarget.lineNumber,
          1
        ),
        options: {
          isWholeLine: true,
          className: "quick-insert-line",
          glyphMarginClassName: "quick-insert-glyph",
        },
      },
    ]);
  };

  const clearQuickInsertDecorations = () => {
    if (!monacoEditor) {
      return;
    }
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    quickInsertDecorations = editor.deltaDecorations(quickInsertDecorations, []);
  };

  const openQuickInsert = () => {
    if (!monacoEditor || !monacoApi) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    resetBlockSession();
    const editor = monacoEditor as {
      getPosition: () => { lineNumber: number; column: number } | null;
      layoutContentWidget: (widget: unknown) => void;
    };
    const position = editor.getPosition();
    quickInsertTarget = position
      ? { lineNumber: position.lineNumber, column: position.column }
      : { lineNumber: 1, column: 1 };
    setText(quickInsertTargetLabel, `挿入先: 行 ${quickInsertTarget.lineNumber}`);
    setQuickInsertOpen(true);
    applyQuickInsertDecorations();
    ensureQuickInsertWidget();
    updateQuickInsertPreview();
    if (quickInsertInput instanceof HTMLTextAreaElement) {
      quickInsertInput.focus();
      quickInsertInput.select();
    }
  };

  const closeQuickInsert = () => {
    setQuickInsertOpen(false);
    clearInsertPreview();
    if (quickInsertInput instanceof HTMLTextAreaElement) {
      quickInsertInput.value = "";
    }
    updateQuickInsertPreview();
  };

  const acceptQuickInsert = () => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    const value =
      quickInsertInput instanceof HTMLTextAreaElement
        ? quickInsertInput.value
        : "";
    if (value.trim().length === 0) {
      if (quickInsertHint) {
        setText(quickInsertHint, "挿入内容が空のため確定できません。");
      }
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      executeEdits: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus: () => void;
    };
    editor.executeEdits("quick-insert", [
      {
        range: new monacoApiAny.Range(
          quickInsertTarget.lineNumber,
          quickInsertTarget.column,
          quickInsertTarget.lineNumber,
          quickInsertTarget.column
        ),
        text: value,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();
    if (quickInsertHint) {
      setText(quickInsertHint, "確定しました。⌘Zで取り消せます。");
    }
    closeQuickInsert();
  };

  if (quickInsertButton instanceof HTMLButtonElement) {
    quickInsertButton.addEventListener("click", () => {
      const isOpen = quickInsertPanel?.classList.contains("is-open");
      if (isOpen) {
        closeQuickInsert();
      } else {
        if (quickInsertHint) {
          setText(quickInsertHint, "プレビュー中。確定後は⌘Zで取り消しできます。");
        }
        openQuickInsert();
      }
    });
  }

  if (quickInsertInput instanceof HTMLTextAreaElement) {
    quickInsertInput.addEventListener("input", () => {
      if (quickInsertHint) {
        setText(quickInsertHint, "プレビュー中。確定後は⌘Zで取り消しできます。");
      }
      ensureQuickInsertWidget();
      updateQuickInsertPreview();
    });
  }

  if (quickInsertCancel instanceof HTMLButtonElement) {
    quickInsertCancel.addEventListener("click", () => {
      closeQuickInsert();
    });
  }

  if (quickInsertAccept instanceof HTMLButtonElement) {
    quickInsertAccept.addEventListener("click", () => {
      acceptQuickInsert();
    });
  }

  blockToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.block === "table" ? "table" : "math";
      setActiveBlockType(type);
    });
  });

  if (blockInsertButton instanceof HTMLElement) {
    blockInsertButton.addEventListener("click", () => {
      const editorForDetect = monacoEditor as {
        getPosition?: () => { lineNumber: number; column: number } | null;
      };
      const detectPosition = editorForDetect?.getPosition?.() ?? null;
      if (!detectedBlockSnapshot && detectPosition) {
        syncDetectedBlockAtPosition(detectPosition, { force: true });
      }
      const draft = getBlockDraft();
      if (isE2E) {
        (window as {
          __tex180LastDraft?: {
            formula: string;
            snippet: string | null;
            detectedSnippet: string | null;
          };
        }).__tex180LastDraft = {
          formula: getMathInputValue(),
          snippet: draft ? draft.snippet : null,
          detectedSnippet: detectedBlockSnapshot?.snippet ?? null,
        };
      }
      if (!draft) return;

      const mode: BlockApplyMode = detectedBlockSnapshot ? "detected" : "new";

      const editor = monacoEditor as { getPosition?: () => { lineNumber: number; column: number } | null };
      const insertPosition = mode === "new" ? editor.getPosition?.() ?? null : null;

      pendingBlockApply = {
        mode,
        draft,
        detectedSnapshot: mode === "detected" ? detectedBlockSnapshot : null,
        insertPosition,
      };

      const contextForDiff =
        mode === "detected" ? detectedBlockSnapshot?.context ?? null : null;

      let lineOffset = 0;
      if (contextForDiff && detectedBlockSnapshot) {
        const editorModel = (
          monacoEditor as {
            getModel?: () => {
              getPositionAt?: (offset: number) => { lineNumber: number; column: number };
            };
          }
        ).getModel?.();
        if (editorModel?.getPositionAt) {
          const innerOffset = detectedBlockSnapshot.start + contextForDiff.prefix.length;
          const lineNumber = editorModel.getPositionAt(innerOffset).lineNumber;
          lineOffset = Math.max(0, lineNumber - 1);
        }
      } else if (insertPosition) {
        lineOffset = Math.max(0, insertPosition.lineNumber - 1);
      }

      if (contextForDiff) {
        const originalInner = getInnerContent(contextForDiff, { trim: false });
        const draftContext = parseBlockContext(draft.snippet);
        const modifiedInner = getInnerContent(draftContext, { trim: false });
        showDiffModal(originalInner, modifiedInner, lineOffset);
      } else {
        const originalSnippet =
          mode === "detected" ? detectedBlockSnapshot?.snippet ?? "" : "";
        showDiffModal(originalSnippet, draft.snippet, lineOffset);
      }

      currentBlockDraft = draft;
    });
  }
  if (diffModalSubmit instanceof HTMLButtonElement) {
    diffModalSubmit.addEventListener("click", () => {
      // Simulate "preview active" state so applyBlockInsert proceeds
      blockPreviewActive = true; 
      applyBlockInsert(pendingBlockApply ?? undefined);
      closeDiffModal();
      blockPreviewActive = false;
      pendingBlockApply = null;
      currentBlockDraft = null;
    });
  }

  if (diffModalCancel instanceof HTMLButtonElement) {
    diffModalCancel.addEventListener("click", () => {
      closeDiffModal();
      pendingBlockApply = null;
      currentBlockDraft = null;
    });
  }

  /*
  if (blockCancelButton instanceof HTMLButtonElement) {
    blockCancelButton.addEventListener("click", () => {
      resetBlockSession();
    });
  }
  */

  if (blockTableRows instanceof HTMLInputElement) {
    blockTableRows.addEventListener("input", () => {
      refreshBlockPreview();
    });
  }

  if (blockTableCols instanceof HTMLInputElement) {
    blockTableCols.addEventListener("input", () => {
      refreshBlockPreview();
    });
  }

  if (blockTableRawInput instanceof HTMLTextAreaElement) {
    blockTableRawInput.addEventListener("input", () => {
      refreshBlockPreview();
    });
  }

  mathKeyboardTabs.forEach((button) => {
    button.addEventListener("click", () => {
      setMathKeyboardTab(normalizeMathKeyboardTab(button.dataset.mathTab));
    });
  });

  if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
    mathKeyboardShiftButton.addEventListener("click", () => {
      mathKeyboardShiftLocked = !mathKeyboardShiftLocked;
      updateMathKeyboardShiftState();
    });
  }

  if (autoBuildButton instanceof HTMLButtonElement) {
    autoBuildButton.addEventListener("click", () => {
      toggleAutoBuild();
    });
  }

  if (settingsAutoBuildButton instanceof HTMLButtonElement) {
    settingsAutoBuildButton.addEventListener("click", () => {
      toggleAutoBuild();
    });
  }

  if (settingsRootSelect instanceof HTMLSelectElement) {
    settingsRootSelect.addEventListener("change", () => {
      requestSetRoot(settingsRootSelect.value);
    });
  }

  if (settingsRootAuto instanceof HTMLButtonElement) {
    settingsRootAuto.addEventListener("click", () => {
      requestDetectRoot();
    });
  }

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
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      envRegistryAdd?.dispatchEvent(new MouseEvent("click"));
    });
  }

  if (envRegistryMathList instanceof HTMLElement) {
    envRegistryMathList.addEventListener("click", handleEnvRegistryListClick);
  }

  if (envRegistryTableList instanceof HTMLElement) {
    envRegistryTableList.addEventListener("click", handleEnvRegistryListClick);
  }

  renderEnvRegistry();

  if (searchButton instanceof HTMLButtonElement) {
    searchButton.addEventListener("click", () => {
      const value =
        searchInput instanceof HTMLInputElement ? searchInput.value.trim() : "";
      requestSearch(value);
    });
  }

  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        requestSearch(searchInput.value.trim());
      }
    });
  }

  if (gitRefreshButton instanceof HTMLButtonElement) {
    gitRefreshButton.addEventListener("click", () => {
      requestGitStatus();
    });
  }

  if (createModalCancel instanceof HTMLButtonElement) {
    createModalCancel.addEventListener("click", () => {
      closeCreateModal();
    });
  }

  if (createModalSubmit instanceof HTMLButtonElement) {
    createModalSubmit.addEventListener("click", () => {
      submitCreateModal();
    });
  }

  if (createModalInput instanceof HTMLInputElement) {
    createModalInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitCreateModal();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeCreateModal();
      }
    });
  }

  if (createModal instanceof HTMLElement) {
    createModal.addEventListener("click", (event) => {
      if (event.target === createModal) {
        closeCreateModal();
      }
    });
  }

  if (renameModalCancel instanceof HTMLButtonElement) {
    renameModalCancel.addEventListener("click", () => {
      closeRenameModal();
    });
  }

  if (renameModalSubmit instanceof HTMLButtonElement) {
    renameModalSubmit.addEventListener("click", () => {
      submitRenameModal();
    });
  }

  if (renameModalInput instanceof HTMLInputElement) {
    renameModalInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitRenameModal();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeRenameModal();
      }
    });
  }

  if (renameModal instanceof HTMLElement) {
    renameModal.addEventListener("click", (event) => {
      if (event.target === renameModal) {
        closeRenameModal();
      }
    });
  }

  if (contextMenuPanel instanceof HTMLElement) {
    contextMenuPanel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    contextMenuPanel.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  if (contextMenu instanceof HTMLElement) {
    contextMenu.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  if (fileTree instanceof HTMLElement) {
    fileTree.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    fileTree.addEventListener("mousedown", () => {
      setTreeFocus(true);
    });
    fileTree.addEventListener("dragover", (event) => {
      const dragEvent = event as DragEvent;
      const payload = dragPayload ?? getDragData(dragEvent);
      if (!payload) {
        return;
      }
      if (!canDropOnFolder(payload, "")) {
        return;
      }
      const target = dragEvent.target as HTMLElement | null;
      if (target && target.closest(".file-item, summary, .file-folder-children")) {
        return;
      }
      dragEvent.preventDefault();
      clearDropTargets();
      fileTree.classList.add("is-drop-target");
    });
    fileTree.addEventListener("dragleave", () => {
      fileTree.classList.remove("is-drop-target");
    });
    fileTree.addEventListener("drop", (event) => {
      const dragEvent = event as DragEvent;
      const payload = dragPayload ?? getDragData(dragEvent);
      dragEvent.preventDefault();
      fileTree.classList.remove("is-drop-target");
      if (!payload) {
        return;
      }
      const target = dragEvent.target as HTMLElement | null;
      if (target && target.closest(".file-item, summary, .file-folder-children")) {
        return;
      }
      requestMoveItem(payload, "");
    });
  }

  document.addEventListener("click", () => {
    if (contextMenuOpen) {
      closeContextMenu();
    }
  });

  window.addEventListener("blur", () => {
    if (contextMenuOpen) {
      closeContextMenu();
    }
    if (mathKeyboardShiftHeld) {
      mathKeyboardShiftHeld = false;
      updateMathKeyboardShiftState();
    }
  });

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Shift" && !mathKeyboardShiftHeld) {
        mathKeyboardShiftHeld = true;
        updateMathKeyboardShiftState();
      }
    },
    true
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key === "Shift" && mathKeyboardShiftHeld) {
        mathKeyboardShiftHeld = false;
        updateMathKeyboardShiftState();
      }
    },
    true
  );

  window.addEventListener(
    "scroll",
    () => {
      if (contextMenuOpen) {
        closeContextMenu();
      }
    },
    true
  );

  window.addEventListener("resize", () => {
    if (contextMenuOpen) {
      closeContextMenu();
    }
  });

  if (saveFileButton instanceof HTMLButtonElement) {
    saveFileButton.addEventListener("click", () => {
      saveCurrentFile().catch((message: string) => {
        updateIssues(1, message, "error", [{ severity: "error", message }]);
      });
    });
  }

  window.addEventListener("keydown", (event) => {
    const targetElement = event.target as HTMLElement | null;
    const isTreeShortcutTarget =
      treeHasFocus &&
      !!targetElement &&
      ((fileTree instanceof HTMLElement && fileTree.contains(targetElement)) ||
        (contextMenu instanceof HTMLElement && contextMenu.contains(targetElement)));
    if (event.metaKey && isTreeShortcutTarget) {
      const key = event.key.toLowerCase();
      if ((key === "c" || key === "x") && selectedTreePath && selectedTreeType) {
        event.preventDefault();
        fileClipboard = {
          path: selectedTreePath,
          kind: selectedTreeType,
          mode: key === "x" ? "cut" : "copy",
        };
        return;
      }
      if (key === "v") {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (key === "z") {
        event.preventDefault();
        requestUndoFileOperation();
        return;
      }
    }
    if (event.metaKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentFile().catch((message: string) => {
        updateIssues(1, message, "error", [{ severity: "error", message }]);
      });
    }
    if (event.key === "Escape" && contextMenuOpen) {
      event.preventDefault();
      closeContextMenu();
    }
  });

  if (buildButton instanceof HTMLButtonElement) {
    buildButton.addEventListener("click", () => {
      if (buildButton.disabled) {
        return;
      }
      if (isDirty && currentFilePath) {
        saveCurrentFile()
          .then((ok) => {
            if (ok) {
              startBuild();
            }
          })
          .catch((message: string) => {
            updateIssues(1, message, "error", [
              { severity: "error", message },
            ]);
          });
        return;
      }
      startBuild();
    });
  }

  if (issuesBar instanceof HTMLElement) {
    issuesBar.addEventListener("click", () => {
      if (currentIssues.length === 0) {
        return;
      }
      setIssuesOpen(!issuesOpen);
      if (!issuesOpen) {
        clearIssueHighlight();
      }
    });
    issuesBar.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (currentIssues.length === 0) {
          return;
        }
        setIssuesOpen(!issuesOpen);
        if (!issuesOpen) {
          clearIssueHighlight();
        }
      }
    });
  }

  if (issuesClose instanceof HTMLButtonElement) {
    issuesClose.addEventListener("click", () => {
      setIssuesOpen(false);
      clearIssueHighlight();
    });
  }

  bridgeWindow.tex180SetBuildState = (payload) => {
    setBuildState(payload.state, payload.message);
  };

  bridgeWindow.tex180UpdateIssues = (payload) => {
    const status =
      payload.status ?? (payload.count > 0 ? "error" : "success");
    updateIssues(payload.count, payload.summary, status, payload.issues ?? []);
  };

  bridgeWindow.tex180UpdateWorkspace = (payload) => {
    handleWorkspaceUpdate(payload);
  };

  bridgeWindow.tex180UpdateIndex = (payload) => {
    handleIndexUpdate(payload);
  };

  bridgeWindow.tex180UpdateSearch = (payload) => {
    handleSearchUpdate(payload);
  };

  bridgeWindow.tex180UpdateGit = (payload) => {
    handleGitUpdate(payload);
  };

  bridgeWindow.tex180OpenFileResult = (payload) => {
    handleOpenFileResult(payload);
  };

  bridgeWindow.tex180SaveResult = (payload) => {
    handleSaveResult(payload);
  };

  bridgeWindow.tex180RenameResult = (payload) => {
    handleRenameResult(payload);
  };

  const handleBridgeMessage = (message: { type?: string; payload?: unknown }) => {
    if (!message?.type) {
      return;
    }
    switch (message.type) {
      case "setBuildState":
        bridgeWindow.tex180SetBuildState?.(message.payload as {
          state: BuildState;
          message?: string;
        });
        break;
      case "updateIssues":
        bridgeWindow.tex180UpdateIssues?.(message.payload as {
          count: number;
          summary: string;
          status?: IssuesStatus;
          issues?: IssueItem[];
        });
        break;
      case "updateWorkspace":
        bridgeWindow.tex180UpdateWorkspace?.(message.payload as {
          rootName: string;
          rootPath: string;
          files: string[];
          folders?: string[];
          rootFile?: string;
          rootSource?: RootSource;
        });
        break;
      case "updateIndex":
        bridgeWindow.tex180UpdateIndex?.(message.payload as {
          labels: IndexEntry[];
          references?: IndexEntry[];
          citations: IndexEntry[];
          sections?: SectionEntry[];
          figures?: IndexEntry[];
          tables?: IndexEntry[];
          todos?: IndexEntry[];
        });
        break;
      case "updateSearch":
        bridgeWindow.tex180UpdateSearch?.(message.payload as {
          query: string;
          results: SearchResult[];
          message?: string;
        });
        break;
      case "updateGit":
        bridgeWindow.tex180UpdateGit?.(message.payload as {
          entries: GitEntry[];
          message?: string;
        });
        break;
      case "openFileResult":
        bridgeWindow.tex180OpenFileResult?.(message.payload as {
          path: string;
          content?: string;
          error?: string;
        });
        break;
      case "saveResult":
        bridgeWindow.tex180SaveResult?.(message.payload as {
          path: string;
          ok: boolean;
          error?: string;
        });
        break;
      case "renameResult":
        bridgeWindow.tex180RenameResult?.(message.payload as {
          oldPath: string;
          newPath: string;
          isDirectory: boolean;
        });
        break;
      case "launcherStatus":
        handleLauncherStatus(message.payload as { isBusy?: boolean; message?: string });
        break;
      default:
        break;
    }
  };

  if (bridgeWindow.tex180Bridge?.onMessage) {
    bridgeWindow.tex180Bridge.onMessage(handleBridgeMessage);
  }

  if (!(editorHost instanceof HTMLElement)) {
    updateFallback("エディタ領域が見つかりません。");
    return;
  }

  const baseUrl = new URL("monaco/vs/", window.location.href).toString();
  const requireBase = baseUrl.replace(/\/$/, "");

  type RequireConfig = { paths: { vs: string } };
  type RequireFunction = ((
    deps: string[],
    onLoad: () => void,
    onError: () => void
  ) => void) & { config: (options: RequireConfig) => void };

  type MonacoWindow = Window &
    typeof globalThis & {
      MonacoEnvironment?: { getWorkerUrl: () => string };
      require?: RequireFunction;
      monaco?: {
        editor?: {
          create: (el: HTMLElement, options: Record<string, unknown>) => unknown;
        };
        languages?: {
          register?: (config: { id: string }) => void;
          registerCompletionItemProvider?: (
            languageId: string,
            provider: {
              triggerCharacters?: string[];
              provideCompletionItems: (
                model: { getLineContent: (lineNumber: number) => string },
                position: { lineNumber: number; column: number }
              ) => { suggestions: unknown[] };
            }
          ) => void;
          CompletionItemKind?: { Reference?: number; Value?: number };
        };
        Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
      };
    };

  const monacoWindow = window as MonacoWindow;

  monacoWindow.MonacoEnvironment = {
    getWorkerUrl: () => {
      const workerMain = `${baseUrl}base/worker/workerMain.js`;
      const workerBootstrap = [
        `self.MonacoEnvironment = { baseUrl: '${baseUrl}' };`,
        `importScripts('${workerMain}');`,
      ].join("\n");
      return URL.createObjectURL(
        new Blob([workerBootstrap], { type: "text/javascript" })
      );
    },
  };

  if (!monacoWindow.require || !monacoWindow.require.config) {
    updateFallback("Monacoのローダーが見つかりません。");
    return;
  }

  monacoWindow.require.config({ paths: { vs: requireBase } });
  monacoWindow.require(
    ["vs/editor/editor.main"],
    () => {
      if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
        updateFallback("Monacoの初期化に失敗しました。");
        return;
      }

      monacoApi = monacoWindow.monaco as Record<string, unknown>;
      registerCompletionProvider(monacoWindow.monaco);
      const editor = monacoWindow.monaco.editor.create(editorHost, {
        value: "",
        language: "latex",
        theme: "vs-dark",
        automaticLayout: true,
        glyphMargin: true,
        minimap: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        fontFamily: '"SF Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        wordWrap: "off",
      }) as {
        onDidChangeModelContent: (listener: () => void) => void;
        onDidChangeCursorPosition?: (listener: (event: { position: { lineNumber: number; column: number } }) => void) => void;
        onDidFocusEditorWidget?: (listener: () => void) => void;
        getValue: () => string;
        focus?: () => void;
      } & any; // Cast to any to access full Monaco API
      monacoEditor = editor;
      if (isE2E) {
        (window as { __tex180Editor?: unknown }).__tex180Editor = editor;
      }
      openPendingFileIfReady();
      editorHost.addEventListener("compositionstart", () => {
        isComposing = true;
        compositionText = "";
        composingFilePath = currentFilePath;
      });
      editorHost.addEventListener("compositionupdate", (e) => {
        compositionText = (e as CompositionEvent).data || "";
      });
      editorHost.addEventListener("compositionend", (e) => {
        const data = (e as CompositionEvent).data;
        
        // If compositionend has no data (cancelled by focus loss) but we have stored text
        if (!data && compositionText) {
          // Verify we are still in the same file to prevent leaking text to new tab
          if (composingFilePath === currentFilePath) {
             const editor = monacoEditor as any;
             const selection = editor.getSelection();
             if (selection) {
                editor.executeEdits("ime-recover", [{
                  range: selection,
                  text: compositionText,
                  forceMoveMarkers: true
                }]);
             }
          }
        }
        
        compositionText = "";
        isComposing = false;
        composingFilePath = null;
        handleCompositionEnd();
      });
      editor.onDidFocusEditorWidget?.(() => {
        setTreeFocus(false);
      });

      editor.onDidChangeModelContent(() => {
        if (isApplyingFile) {
          return;
        }
        clearJumpHighlight();
        if (!currentFilePath) {
          return;
        }
        const currentValue = editor.getValue();
        updateDirtyState(currentFilePath, currentValue);
        if (autoBuildEnabled && currentFilePath.endsWith(".tex")) {
          autoBuildPending = isDirty;
        } else if (!isDirty) {
          autoBuildPending = false;
        }
        updateBreadcrumbs();
        renderFileTree();
      });

      editor.onDidChangeCursorPosition?.((e: { position: { lineNumber: number; column: number } }) => {
        if (currentFilePath && currentFilePath.endsWith(".tex")) {
          handleCursorPositionChange(e.position);
        }
      });

      document.body.classList.add("has-editor");
    },
    () => {
      updateFallback("Monacoの読み込みに失敗しました。");
    }
  );
});
