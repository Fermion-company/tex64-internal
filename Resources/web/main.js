window.addEventListener("DOMContentLoaded", () => {
    var _a, _b;
    requestAnimationFrame(() => {
        document.body.classList.add("is-ready");
    });
    const tabConfig = {
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
    let monacoEditor = null;
    let monacoApi = null;
    let quickInsertDecorations = [];
    let quickInsertWidget = null;
    let quickInsertWidgetNode = null;
    let quickInsertWidgetBody = null;
    let quickInsertTarget = { lineNumber: 1, column: 1 };
    const tabs = Array.from(document.querySelectorAll(".tab[data-tab]"));
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
    const launcher = document.getElementById("launcher");
    const launcherCreateButton = document.getElementById("launcher-create");
    const launcherOpenButton = document.getElementById("launcher-open");
    const launcherStatus = document.getElementById("launcher-status");
    const launcherStatusText = document.getElementById("launcher-status-text");
    const launcherStatusSpinner = document.getElementById("launcher-status-spinner");
    const launcherTemplateButtons = Array.from(document.querySelectorAll(".launcher-template-button"));
    const sidebarPanels = Array.from(document.querySelectorAll(".panel[data-panel]"));
    const sidebar = document.querySelector(".sidebar");
    const sidebarPanel = document.querySelector(".sidebar-panel");
    const outlineEmpty = document.getElementById("outline-empty");
    const outlineSections = document.getElementById("outline-sections");
    const outlineFigures = document.getElementById("outline-figures");
    const outlineTables = document.getElementById("outline-tables");
    const outlineTodos = document.getElementById("outline-todos");
    const outlineLabels = document.getElementById("outline-labels");
    const outlineCitations = document.getElementById("outline-citations");
    const workspaceLabel = document.getElementById("workspace-label");
    const fileTree = document.getElementById("file-tree");
    const saveFileButton = document.getElementById("save-file-button");
    const blockToggleButtons = Array.from(document.querySelectorAll(".block-toggle-button"));
    const blockForms = Array.from(document.querySelectorAll(".block-form"));
    const blockTarget = document.getElementById("block-target");
    let blockMathInput = null;
    const blockMathInputContainer = document.getElementById("block-math-input-container");
    const blockMathPreviewWrap = document.getElementById("block-math-preview-wrap");
    const blockMathPreview = document.getElementById("block-math-preview");
    const blockTableRows = document.getElementById("block-table-rows");
    const blockTableCols = document.getElementById("block-table-cols");
    const blockPreviewButton = document.getElementById("block-preview-button");
    const blockAcceptButton = document.getElementById("block-accept-button");
    const blockCancelButton = document.getElementById("block-cancel-button");
    const blockList = document.getElementById("block-list");
    const mathKeyboardDock = document.getElementById("math-keyboard-dock");
    const mathKeyboardGrid = document.getElementById("math-keyboard-grid");
    const mathKeyboardTabs = Array.from(document.querySelectorAll(".math-keyboard-tab"));
    const searchInput = document.getElementById("search-input");
    const searchButton = document.getElementById("search-button");
    const searchResults = document.getElementById("search-results");
    const gitStatus = document.getElementById("git-status");
    const gitRefreshButton = document.getElementById("git-refresh");
    const settingsAutoBuildButton = document.getElementById("settings-auto-build");
    const settingsRootSelect = document.getElementById("settings-root-select");
    const settingsRootAuto = document.getElementById("settings-root-auto");
    const settingsWorkspace = document.getElementById("settings-workspace");
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
    const setText = (element, text) => {
        if (element) {
            element.textContent = text;
        }
    };
    const setLauncherVisible = (isVisible) => {
        if (launcher instanceof HTMLElement) {
            launcher.classList.toggle("is-visible", isVisible);
            launcher.setAttribute("aria-hidden", isVisible ? "false" : "true");
        }
        document.body.classList.toggle("has-launcher", isVisible);
    };
    const updateLauncherTemplate = (template) => {
        launcherTemplate = template;
        launcherTemplateButtons.forEach((button) => {
            const isActive = button.dataset.template === template;
            button.classList.toggle("is-active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        });
    };
    const setLauncherStatus = (payload) => {
        var _a;
        if (typeof payload.isBusy === "boolean") {
            launcherBusy = payload.isBusy;
        }
        if (payload.message !== undefined) {
            launcherMessage = (_a = payload.message) !== null && _a !== void 0 ? _a : null;
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
        launcherStatusText.textContent = launcherBusy ? "準備中..." : launcherMessage !== null && launcherMessage !== void 0 ? launcherMessage : "";
        if (launcherStatusSpinner instanceof HTMLElement) {
            launcherStatusSpinner.hidden = !launcherBusy;
        }
    };
    const bridgeWindow = window;
    const setIssuesStatus = (status) => {
        if (issuesBar instanceof HTMLElement) {
            issuesBar.dataset.status = status;
        }
    };
    let currentIssues = [];
    let issuesOpen = false;
    let issueDecorations = [];
    let indexLabels = [];
    let indexCitations = [];
    let indexSections = [];
    let indexFigures = [];
    let indexTables = [];
    let indexTodos = [];
    let jumpDecorations = [];
    let pendingReveal = null;
    let completionRegistered = false;
    let workspaceFiles = [];
    let workspaceFolders = [];
    let workspaceName = "ワークスペース未選択";
    let workspaceRootKey = null;
    let rootFilePath = null;
    let rootSource = "auto";
    let launcherTemplate = "paper";
    let launcherBusy = false;
    let launcherMessage = null;
    let openFolders = new Set();
    let openStateLoaded = false;
    let currentFilePath = null;
    let currentFileSavedContent = null;
    let isDirty = false;
    let isApplyingFile = false;
    let selectedTreePath = null;
    let selectedTreeType = null;
    let pendingSave = null;
    let blocks = [];
    let activeBlockType = "math";
    let blockPreviewActive = false;
    let activeTab = "files";
    let activeMathKeyboardTab = "basic";
    let activeBlockEditId = null;
    let activeBlockOriginalSnippet = null;
    let activeBlockRange = null;
    let pendingBlockEdit = null;
    let autoBuildEnabled = false;
    let autoBuildPending = false;
    let searchResultsData = [];
    let searchMessage = "検索結果はここに表示します。";
    let lastSearchQuery = "";
    let gitEntries = [];
    let gitMessage = "Gitステータスはここに表示します。";
    let pendingAutoOpenPath = null;
    let createModalKind = null;
    let renameTargetPath = null;
    let renameTargetType = null;
    let contextMenuOpen = false;
    let openTabs = [];
    let dragPayload = null;
    let treeHasFocus = false;
    let isComposing = false;
    let compositionText = "";
    let composingFilePath = null;
    let pendingCompositionAction = null;
    let fileClipboard = null;
    const monacoModels = new Map();
    const monacoViewStates = new Map();
    const dirtyFiles = new Set();
    const setIssuesOpen = (open) => {
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
        const editor = monacoEditor;
        issueDecorations = editor.deltaDecorations(issueDecorations, []);
    };
    const focusIssue = (issue) => {
        if (!monacoEditor || !monacoApi || !issue.line) {
            return;
        }
        const monacoApiAny = monacoApi;
        const editor = monacoEditor;
        const className = issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
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
        const editor = monacoEditor;
        jumpDecorations = editor.deltaDecorations(jumpDecorations, []);
    };
    const revealLine = (line) => {
        if (!monacoEditor || !monacoApi) {
            return;
        }
        clearJumpHighlight();
        const monacoApiAny = monacoApi;
        const editor = monacoEditor;
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
    const renderIssues = (issues) => {
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
        issuesList.style.display = "grid";
        issues.forEach((issue) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "issue-item";
            item.dataset.severity = issue.severity;
            const message = document.createElement("div");
            message.className = "issue-message";
            message.textContent = issue.message;
            const meta = document.createElement("div");
            meta.className = "issue-meta";
            const severity = document.createElement("span");
            severity.textContent = issue.severity === "warning" ? "警告" : "エラー";
            meta.appendChild(severity);
            if (issue.line) {
                const line = document.createElement("span");
                line.className = "issue-line";
                line.textContent = `行 ${issue.line}`;
                meta.appendChild(line);
            }
            item.append(message, meta);
            item.addEventListener("click", () => {
                focusIssue(issue);
            });
            issuesList.appendChild(item);
        });
    };
    const dedupeByKey = (entries) => {
        const map = new Map();
        entries.forEach((entry) => {
            if (!map.has(entry.key)) {
                map.set(entry.key, entry);
            }
        });
        return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key, "ja"));
    };
    const dedupeSections = (entries) => {
        const map = new Map();
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
    const pickCitationEntries = (entries) => {
        const bibEntries = entries.filter((entry) => entry.path.endsWith(".bib"));
        if (bibEntries.length > 0) {
            return dedupeByKey(bibEntries);
        }
        return dedupeByKey(entries);
    };
    const renderOutlineList = (container, entries, kind) => {
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
    const renderSectionList = (container, entries) => {
        container.innerHTML = "";
        if (entries.length === 0) {
            return;
        }
        const baseLevel = Math.min(...entries.map((entry) => entry.level));
        const counters = new Array(8).fill(0);
        const sectionLabels = ["章", "節", "小節", "項", "小項", "段落", "小段落"];
        entries.forEach((entry) => {
            var _a;
            const depth = Math.max(entry.level - baseLevel, 0);
            counters[depth] += 1;
            for (let i = depth + 1; i < counters.length; i += 1) {
                counters[i] = 0;
            }
            const numberParts = counters.slice(0, depth + 1).filter((value) => value > 0);
            const label = (_a = sectionLabels[depth]) !== null && _a !== void 0 ? _a : "節";
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
    const filterEntriesForCurrent = (entries) => {
        if (!currentFilePath) {
            return [];
        }
        return entries.filter((entry) => entry.path === currentFilePath);
    };
    const renderOutline = () => {
        if (!(outlineLabels instanceof HTMLElement) ||
            !(outlineCitations instanceof HTMLElement) ||
            !(outlineSections instanceof HTMLElement) ||
            !(outlineFigures instanceof HTMLElement) ||
            !(outlineTables instanceof HTMLElement) ||
            !(outlineTodos instanceof HTMLElement)) {
            return;
        }
        const sectionEntries = dedupeSections(filterEntriesForCurrent(indexSections));
        const figureEntries = dedupeByKey(filterEntriesForCurrent(indexFigures));
        const tableEntries = dedupeByKey(filterEntriesForCurrent(indexTables));
        const todoEntries = dedupeByKey(filterEntriesForCurrent(indexTodos));
        const labelEntries = dedupeByKey(filterEntriesForCurrent(indexLabels));
        const citationEntries = pickCitationEntries(filterEntriesForCurrent(indexCitations));
        renderSectionList(outlineSections, sectionEntries);
        renderOutlineList(outlineFigures, figureEntries, "figure");
        renderOutlineList(outlineTables, tableEntries, "table");
        renderOutlineList(outlineTodos, todoEntries, "todo");
        renderOutlineList(outlineLabels, labelEntries);
        renderOutlineList(outlineCitations, citationEntries);
        if (outlineEmpty instanceof HTMLElement) {
            const hasItems = sectionEntries.length > 0 ||
                figureEntries.length > 0 ||
                tableEntries.length > 0 ||
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
    const mathKeyboardSets = {
        basic: [
            { label: "7", latex: "7" },
            { label: "8", latex: "8" },
            { label: "9", latex: "9" },
            { label: "+", latex: "+" },
            { label: "-", latex: "-" },
            { label: "=", latex: "=" },
            { label: "(", latex: "(" },
            { label: ")", latex: ")" },
            { label: "4", latex: "4" },
            { label: "5", latex: "5" },
            { label: "6", latex: "6" },
            { label: "×", latex: "\\times " },
            { label: "÷", latex: "\\div " },
            { label: "·", latex: "\\cdot " },
            { label: "[", latex: "[" },
            { label: "]", latex: "]" },
            { label: "1", latex: "1" },
            { label: "2", latex: "2" },
            { label: "3", latex: "3" },
            { label: "±", latex: "\\pm " },
            { label: "{", latex: "\\{" },
            { label: "}", latex: "\\}" },
            { label: "|", latex: "|" },
            { label: ".", latex: "." },
            { label: ",", latex: "," },
            { label: "0", latex: "0" },
        ],
        relations: [
            { label: "=", latex: "=" },
            { label: "≠", latex: "\\neq " },
            { label: "<", latex: "<" },
            { label: ">", latex: ">" },
            { label: "≤", latex: "\\leq " },
            { label: "≥", latex: "\\geq " },
            { label: "≈", latex: "\\approx " },
            { label: "≡", latex: "\\equiv " },
            { label: "∝", latex: "\\propto " },
            { label: "∼", latex: "\\sim " },
            { label: "→", latex: "\\to " },
            { label: "⇒", latex: "\\Rightarrow " },
            { label: "⇔", latex: "\\Leftrightarrow " },
            { label: "∈", latex: "\\in " },
            { label: "∉", latex: "\\notin " },
            { label: "⊂", latex: "\\subset " },
            { label: "⊆", latex: "\\subseteq " },
            { label: "⊇", latex: "\\supseteq " },
            { label: "∀", latex: "\\forall " },
            { label: "∃", latex: "\\exists " },
        ],
        operators: [
            { label: "∑", latex: "\\sum " },
            { label: "∏", latex: "\\prod " },
            { label: "∫", latex: "\\int " },
            { label: "∮", latex: "\\oint " },
            { label: "∂", latex: "\\partial " },
            { label: "∞", latex: "\\infty " },
            { label: "∇", latex: "\\nabla " },
            { label: "lim", latex: "\\lim " },
            { label: "log", latex: "\\log " },
            { label: "ln", latex: "\\ln " },
            { label: "sin", latex: "\\sin " },
            { label: "cos", latex: "\\cos " },
            { label: "tan", latex: "\\tan " },
            { label: "exp", latex: "\\exp " },
            { label: "max", latex: "\\max " },
            { label: "min", latex: "\\min " },
        ],
        greek: [
            { label: "α", latex: "\\alpha " },
            { label: "β", latex: "\\beta " },
            { label: "γ", latex: "\\gamma " },
            { label: "δ", latex: "\\delta " },
            { label: "ε", latex: "\\epsilon " },
            { label: "θ", latex: "\\theta " },
            { label: "λ", latex: "\\lambda " },
            { label: "μ", latex: "\\mu " },
            { label: "π", latex: "\\pi " },
            { label: "ρ", latex: "\\rho " },
            { label: "σ", latex: "\\sigma " },
            { label: "τ", latex: "\\tau " },
            { label: "φ", latex: "\\phi " },
            { label: "ω", latex: "\\omega " },
            { label: "κ", latex: "\\kappa " },
            { label: "ν", latex: "\\nu " },
            { label: "Γ", latex: "\\Gamma " },
            { label: "Δ", latex: "\\Delta " },
            { label: "Θ", latex: "\\Theta " },
            { label: "Λ", latex: "\\Lambda " },
            { label: "Π", latex: "\\Pi " },
            { label: "Σ", latex: "\\Sigma " },
            { label: "Φ", latex: "\\Phi " },
            { label: "Ω", latex: "\\Omega " },
        ],
        structures: [
            { label: "a/b", latex: "\\frac{#?}{#?}", fallback: "\\frac{}{}" },
            { label: "√", latex: "\\sqrt{#?}", fallback: "\\sqrt{}" },
            { label: "x^", latex: "^{#?}", fallback: "^{}" },
            { label: "x_", latex: "_{#?}", fallback: "_{}" },
            { label: "binom", latex: "\\binom{#?}{#?}", fallback: "\\binom{}{}" },
            { label: "vec", latex: "\\vec{#?}", fallback: "\\vec{}" },
            { label: "hat", latex: "\\hat{#?}", fallback: "\\hat{}" },
            { label: "bar", latex: "\\overline{#?}", fallback: "\\overline{}" },
            { label: "dot", latex: "\\dot{#?}", fallback: "\\dot{}" },
            { label: "ddot", latex: "\\ddot{#?}", fallback: "\\ddot{}" },
            { label: "text", latex: "\\text{#?}", fallback: "\\text{}" },
            {
                label: "cases",
                latex: "\\begin{cases}#?\\\\#?\\end{cases}",
                fallback: "\\begin{cases}\n  \\\\\n\\end{cases}",
            },
            {
                label: "matrix",
                latex: "\\begin{matrix}#?\\\\#?\\end{matrix}",
                fallback: "\\begin{matrix}\n  & \\\\\n  & \n\\end{matrix}",
            },
        ],
    };
    const updateMathKeyboardVisibility = () => {
        if (!(mathKeyboardDock instanceof HTMLElement)) {
            return;
        }
        const shouldShow = activeTab === "blocks" && activeBlockType === "math";
        mathKeyboardDock.classList.toggle("is-open", shouldShow);
        mathKeyboardDock.setAttribute("aria-hidden", shouldShow ? "false" : "true");
        if (shouldShow && mathKeyboardGrid instanceof HTMLElement) {
            if (mathKeyboardGrid.childElementCount === 0) {
                renderMathKeyboard(activeMathKeyboardTab);
            }
        }
    };
    const insertMathKey = (key) => {
        var _a, _b, _c, _d;
        if (!blockMathInput) {
            return;
        }
        const mathField = blockMathInput;
        // フォーカスを先に戻す
        (_a = mathField.focus) === null || _a === void 0 ? void 0 : _a.call(mathField);
        // executeCommandを優先（より信頼性が高い）
        if (typeof mathField.executeCommand === "function") {
            try {
                mathField.executeCommand("insert", key.latex);
                refreshBlockPreview();
                updateMathPreview();
                return;
            }
            catch (e) {
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
        const insertValue = (_b = key.fallback) !== null && _b !== void 0 ? _b : key.latex;
        if (blockMathInput instanceof HTMLTextAreaElement) {
            const start = (_c = blockMathInput.selectionStart) !== null && _c !== void 0 ? _c : blockMathInput.value.length;
            const end = (_d = blockMathInput.selectionEnd) !== null && _d !== void 0 ? _d : blockMathInput.value.length;
            blockMathInput.value =
                blockMathInput.value.slice(0, start) + insertValue + blockMathInput.value.slice(end);
            const nextPos = start + insertValue.length;
            blockMathInput.setSelectionRange(nextPos, nextPos);
            blockMathInput.focus();
        }
        else if (typeof mathField.value === "string") {
            mathField.value += insertValue;
        }
        blockMathInput.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const renderMathKeyboard = (tab) => {
        var _a;
        if (!(mathKeyboardGrid instanceof HTMLElement)) {
            return;
        }
        const keys = (_a = mathKeyboardSets[tab]) !== null && _a !== void 0 ? _a : [];
        mathKeyboardGrid.innerHTML = "";
        keys.forEach((key) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "math-keyboard-key";
            button.textContent = key.label;
            button.title = key.latex;
            button.addEventListener("mousedown", (event) => {
                event.preventDefault();
            });
            button.addEventListener("click", () => {
                var _a, _b;
                insertMathKey(key);
                // クリック後にMathFieldにフォーカスを戻す
                if (blockMathInput instanceof HTMLElement) {
                    (_b = (_a = blockMathInput).focus) === null || _b === void 0 ? void 0 : _b.call(_a);
                }
            });
            mathKeyboardGrid.appendChild(button);
        });
    };
    const setMathKeyboardTab = (tab) => {
        activeMathKeyboardTab = tab;
        mathKeyboardTabs.forEach((button) => {
            const isActive = button.dataset.mathTab === tab;
            button.classList.toggle("is-active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        renderMathKeyboard(tab);
    };
    const setActiveBlockType = (type) => {
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
        }
    };
    let currentMathValue = "";
    const updateMathPreview = (value) => {
        // プレビュー機能は無効化済み
    };
    const getMathInputValue = () => {
        // MathLiveの場合、キャッシュされた値を使用（DOMアクセスより確実）
        if (blockMathInput && blockMathInput.tagName.toLowerCase() === "math-field") {
            // 念のためDOM値も確認するが、基本はキャッシュ優先
            const mf = blockMathInput;
            if (mf.value)
                currentMathValue = mf.value;
            return currentMathValue;
        }
        if (!blockMathInput) {
            return "";
        }
        if (blockMathInput instanceof HTMLTextAreaElement) {
            return blockMathInput.value;
        }
        const value = blockMathInput.value;
        return typeof value === "string" ? value : "";
    };
    const setMathInputValue = (value) => {
        currentMathValue = value;
        if (!blockMathInput) {
            return;
        }
        if (blockMathInput instanceof HTMLTextAreaElement) {
            blockMathInput.value = value;
        }
        else if ("value" in blockMathInput) {
            blockMathInput.value = value;
        }
    };
    const attachMathInputListener = () => {
        if (!blockMathInput) {
            return;
        }
        blockMathInput.addEventListener("input", (e) => {
            // 値を同期
            const target = e.target;
            if (target.value !== undefined) {
                currentMathValue = target.value;
            }
            refreshBlockPreview();
        });
    };
    // =============================================================================
    // MathLive イベントハンドリング
    // =============================================================================
    const attachMathFieldEvents = (mathfield) => {
        // 入力変更時
        mathfield.addEventListener("input", (e) => {
            // MathLiveの値を同期
            const val = e.target.value;
            if (typeof val === "string") {
                currentMathValue = val;
            }
            refreshBlockPreview();
        });
        // キーボードイベント
        mathfield.addEventListener("keydown", (e) => {
            // Escでフォーカス解除
            if (e.key === "Escape") {
                mathfield.blur();
                return;
            }
            // Cmd+Enter (Mac) / Ctrl+Enter (Win) で確定
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (blockAcceptButton instanceof HTMLButtonElement) {
                    blockAcceptButton.click();
                }
                return;
            }
            // Tab移動は許可
            if (e.key === "Tab")
                return;
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
        if (!resizer)
            return;
        let isResizing = false;
        const startResize = (e) => {
            isResizing = true;
            resizer.classList.add("is-resizing");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            if (document.getElementById("editor")) {
                document.getElementById("editor").style.pointerEvents = "none"; // iframe対策的な
            }
        };
        const doResize = (e) => {
            if (!isResizing)
                return;
            const sidebarWidth = 52; // var(--sidebar-width)
            // マウス位置から新しいパネル幅を計算
            const newWidth = Math.max(200, Math.min(800, e.clientX - sidebarWidth));
            document.documentElement.style.setProperty("--sidebar-panel-width", `${newWidth}px`);
            // Monacoのリサイズ
            const editor = monacoEditor;
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
                const editor = monacoEditor;
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
        const MathLiveGlobal = window.MathLive;
        const hasMathLive = !!MathLiveGlobal;
        const hasMathfieldElement = hasMathLive && !!MathLiveGlobal.MathfieldElement;
        const loadError = window.MATHLIVE_LOAD_ERROR;
        if (!customElements.get("math-field")) {
            if (hasMathfieldElement) {
                try {
                    customElements.define("math-field", MathLiveGlobal.MathfieldElement);
                }
                catch (e) {
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
            }
            catch (e) {
                // 失敗時にデバッグ情報を表示
                blockMathInputContainer.innerHTML = `
          <div style="font-size:12px;">MathLiveの読み込みに失敗しました。</div>
          <div style="font-size:10px;color:#888;margin-top:4px;">${debugInfo}</div>
        `;
                blockMathInputContainer.style.color = "#ff6b6b";
                return;
            }
        }
        // MathField要素作成
        const mathfield = document.createElement("math-field");
        mathfield.id = "block-math-input";
        mathfield.className = "block-math-field";
        // コンテナに追加
        blockMathInputContainer.innerHTML = "";
        blockMathInputContainer.appendChild(mathfield);
        blockMathInput = mathfield;
        // オプション設定
        if (typeof mathfield.setOptions === "function") {
            mathfield.setOptions({
                smartMode: false,
                virtualKeyboardMode: "manual",
                fontsDirectory: "mathlive/fonts",
                soundsDirectory: null,
                keypressSound: null,
                plonkSound: null,
                locale: "ja",
            });
        }
        // Shadow DOMスタイル注入
        const injectStyles = () => {
            if (!mathfield.shadowRoot)
                return;
            // 既にスタイルがあるかチェック
            if (mathfield.shadowRoot.querySelector('style[data-tex180-style]'))
                return;
            const style = document.createElement("style");
            style.setAttribute("data-tex180-style", "true");
            style.textContent = `
        :host {
          color: var(--text, #e5e9f0) !important;
          background-color: transparent !important;
        }
        .ML__field {
          color: var(--text, #e5e9f0) !important;
        }
        .ML__placeholder {
          color: var(--muted, #9aa3ad) !important;
          opacity: 0.6;
        }
        .ML__selection {
          background: rgba(74, 168, 255, 0.2) !important;
          color: inherit !important;
        }
        .ML__caret {
          background-color: var(--accent, #4aa8ff) !important;
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
    const buildLineDiff = (beforeLines, afterLines) => {
        const rows = beforeLines.length;
        const cols = afterLines.length;
        const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
        for (let i = 1; i <= rows; i += 1) {
            for (let j = 1; j <= cols; j += 1) {
                if (beforeLines[i - 1] === afterLines[j - 1]) {
                    table[i][j] = table[i - 1][j - 1] + 1;
                }
                else {
                    table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
                }
            }
        }
        const diff = [];
        let i = rows;
        let j = cols;
        while (i > 0 && j > 0) {
            if (beforeLines[i - 1] === afterLines[j - 1]) {
                diff.push({ type: "same", line: beforeLines[i - 1] });
                i -= 1;
                j -= 1;
            }
            else if (table[i - 1][j] >= table[i][j - 1]) {
                diff.push({ type: "del", line: beforeLines[i - 1] });
                i -= 1;
            }
            else {
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
    const buildDiffPreview = (before, after) => {
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
    const buildBlockPreviewSnippet = (snippet) => {
        if (!activeBlockEditId || !activeBlockOriginalSnippet) {
            return snippet;
        }
        return buildDiffPreview(activeBlockOriginalSnippet, snippet);
    };
    const buildMathSnippet = (formula) => {
        const trimmed = formula.trim();
        if (!trimmed) {
            return "";
        }
        return ["\\\\[", trimmed, "\\\\]", ""].join("\n");
    };
    const parseTableSize = () => {
        const rows = blockTableRows instanceof HTMLInputElement
            ? Number.parseInt(blockTableRows.value, 10)
            : NaN;
        const cols = blockTableCols instanceof HTMLInputElement
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
    const buildTableSnippet = (rows, cols) => {
        const columnSpec = `|${"c|".repeat(cols)}`;
        const rowCells = Array.from({ length: cols }, () => " ").join(" & ");
        const lines = [];
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
    const getBlockDraft = () => {
        if (activeBlockType === "math") {
            const formula = getMathInputValue();
            const snippet = buildMathSnippet(formula);
            if (!snippet.trim()) {
                return null;
            }
            return { snippet, content: { formula: formula.trim() } };
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
        activeBlockEditId = null;
        activeBlockRange = null;
        activeBlockOriginalSnippet = null;
        pendingBlockEdit = null;
        clearInsertPreview();
        setText(blockTarget, "挿入先: 行 -");
    };
    const renderBlocksList = () => {
        if (!(blockList instanceof HTMLElement)) {
            return;
        }
        blockList.innerHTML = "";
        if (blocks.length === 0) {
            const empty = document.createElement("div");
            empty.className = "panel-placeholder";
            empty.textContent = "ブロックはまだありません。";
            blockList.appendChild(empty);
            return;
        }
        const sorted = [...blocks].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        sorted.forEach((block) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "block-item";
            const title = document.createElement("div");
            title.textContent = block.type === "math" ? "数式" : "表";
            const meta = document.createElement("div");
            meta.className = "block-item-meta";
            meta.textContent = `${block.file} · 行 ${block.line}`;
            item.append(title, meta);
            item.addEventListener("click", () => {
                startBlockEdit(block);
            });
            blockList.appendChild(item);
        });
    };
    const saveBlocks = () => {
        if (!workspaceRootKey) {
            updateIssues(1, "起動時にフォルダを選択してください。", "error", [
                { severity: "error", message: "起動時にフォルダを選択してください。" },
            ]);
            return;
        }
        postToNative({ type: "saveBlocks", blocks });
    };
    const prepareBlockEdit = (block) => {
        var _a;
        if (!monacoEditor) {
            return;
        }
        const editor = monacoEditor;
        const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
        if (!(model === null || model === void 0 ? void 0 : model.findMatches)) {
            updateIssues(1, "ブロックの検索に失敗しました。", "error", [
                { severity: "error", message: "ブロックの検索に失敗しました。" },
            ]);
            return;
        }
        const matches = model.findMatches(block.snippet, false, false, false, null, true, 1);
        if (!matches || matches.length === 0) {
            updateIssues(1, "ブロックの本文が見つかりません。", "error", [
                { severity: "error", message: "ブロックの本文が見つかりません。" },
            ]);
            return;
        }
        const range = matches[0].range;
        activeBlockRange = {
            startLineNumber: range.startLineNumber,
            startColumn: range.startColumn,
            endLineNumber: range.endLineNumber,
            endColumn: range.endColumn,
        };
        const draft = getBlockDraft();
        if (!draft) {
            return;
        }
        startBlockPreview(draft.snippet, {
            lineNumber: range.startLineNumber,
            column: range.startColumn,
        });
    };
    const startBlockEdit = (block) => {
        var _a;
        activeBlockEditId = block.id;
        activeBlockOriginalSnippet = block.snippet;
        if (block.type === "math") {
            setMathInputValue((_a = block.content.formula) !== null && _a !== void 0 ? _a : "");
        }
        else {
            if (blockTableRows instanceof HTMLInputElement && block.content.rows) {
                blockTableRows.value = String(block.content.rows);
            }
            if (blockTableCols instanceof HTMLInputElement && block.content.cols) {
                blockTableCols.value = String(block.content.cols);
            }
        }
        setActiveBlockType(block.type);
        setText(blockTarget, `${block.file} · 行 ${block.line}`);
        if (currentFilePath === block.file) {
            prepareBlockEdit(block);
            return;
        }
        pendingBlockEdit = block;
        const requested = requestOpenFile(block.file);
        if (!requested) {
            pendingBlockEdit = null;
        }
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
    const handleSearchUpdate = (payload) => {
        lastSearchQuery = payload.query;
        searchResultsData = Array.isArray(payload.results) ? payload.results : [];
        if (payload.message) {
            searchMessage = payload.message;
        }
        else if (searchResultsData.length === 0) {
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
    const handleGitUpdate = (payload) => {
        gitEntries = Array.isArray(payload.entries) ? payload.entries : [];
        if (payload.message) {
            gitMessage = payload.message;
        }
        else if (gitEntries.length === 0) {
            gitMessage = "変更はありません。";
        }
        renderGitStatus();
    };
    const requestSearch = (query) => {
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
    const requestSetRoot = (path) => {
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
    const setWorkspaceLabel = (label) => {
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
        const hasValidCurrent = currentFilePath !== null && workspaceFiles.includes(currentFilePath);
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
        }
        else if (texFiles.length === 0) {
            placeholder.textContent = "TeXファイルがありません";
        }
        else {
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
        settingsRootSelect.value = rootFilePath !== null && rootFilePath !== void 0 ? rootFilePath : "";
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
        if (autoBuildEnabled && isDirty && (currentFilePath === null || currentFilePath === void 0 ? void 0 : currentFilePath.endsWith(".tex"))) {
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
        openFolders = new Set();
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
        }
        catch {
            openFolders = new Set();
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
            .querySelectorAll("summary.is-selected")
            .forEach((summary) => summary.classList.remove("is-selected"));
    };
    const setTreeFocus = (value) => {
        treeHasFocus = value;
        if (fileTree instanceof HTMLElement) {
            fileTree.classList.toggle("is-focused", value);
            if (value) {
                fileTree.focus({ preventScroll: true });
            }
        }
    };
    const scheduleAfterComposition = (action) => {
        if (!isComposing) {
            action();
            return;
        }
        // Blur will trigger compositionend which handles recovery
        pendingCompositionAction = action;
        const input = editorHost === null || editorHost === void 0 ? void 0 : editorHost.querySelector("textarea.inputarea");
        input === null || input === void 0 ? void 0 : input.blur();
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
    const selectFolderSummary = (summary, path) => {
        clearFolderSelection();
        summary.classList.add("is-selected");
        selectedTreePath = path;
        selectedTreeType = "dir";
        setTreeFocus(true);
    };
    const updateDirtyState = (path, content, savedContent) => {
        var _a, _b;
        const entry = monacoModels.get(path);
        const baseSaved = (_b = (_a = savedContent !== null && savedContent !== void 0 ? savedContent : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _a !== void 0 ? _a : currentFileSavedContent) !== null && _b !== void 0 ? _b : content;
        if (entry) {
            entry.savedContent = baseSaved;
        }
        if (content !== baseSaved) {
            dirtyFiles.add(path);
        }
        else {
            dirtyFiles.delete(path);
        }
        if (path === currentFilePath) {
            isDirty = dirtyFiles.has(path);
        }
    };
    const storeViewState = (path) => {
        if (!monacoEditor) {
            return;
        }
        const editor = monacoEditor;
        if (!editor.saveViewState) {
            return;
        }
        const viewState = editor.saveViewState();
        if (viewState) {
            monacoViewStates.set(path, viewState);
        }
    };
    const restoreViewState = (path) => {
        var _a;
        if (!monacoEditor) {
            return;
        }
        const viewState = monacoViewStates.get(path);
        if (!viewState) {
            return;
        }
        const editor = monacoEditor;
        (_a = editor.restoreViewState) === null || _a === void 0 ? void 0 : _a.call(editor, viewState);
    };
    const cacheCurrentBuffer = () => {
        if (!currentFilePath || !monacoEditor) {
            return;
        }
        const editor = monacoEditor;
        const content = editor.getValue();
        updateDirtyState(currentFilePath, content);
        storeViewState(currentFilePath);
    };
    const addOpenTab = (path) => {
        if (!openTabs.includes(path)) {
            openTabs = [...openTabs, path];
        }
    };
    const closeTab = (path) => {
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
            }
            else {
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
        if (!(editorTabs instanceof HTMLElement)) {
            return;
        }
        editorTabs.innerHTML = "";
        if (openTabs.length === 0) {
            editorTabs.classList.add("is-empty");
            return;
        }
        editorTabs.classList.remove("is-empty");
        openTabs.forEach((path) => {
            var _a;
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "editor-tab";
            const label = document.createElement("span");
            label.className = "editor-tab-label";
            label.textContent = (_a = path.split("/").pop()) !== null && _a !== void 0 ? _a : path;
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
            editorTabs.appendChild(tab);
        });
    };
    const updateBreadcrumbs = () => {
        if (!(breadcrumbs instanceof HTMLElement)) {
            return;
        }
        const fileLabel = currentFilePath !== null && currentFilePath !== void 0 ? currentFilePath : "未選択";
        const dirtyMark = isDirty ? " ●" : "";
        breadcrumbs.textContent = `${fileLabel}${dirtyMark}`;
        renderEditorTabs();
    };
    const updateMiniOutline = () => {
        if (!(miniOutline instanceof HTMLElement)) {
            return;
        }
        const fileLabel = currentFilePath ? currentFilePath.split("/").pop() : "未選択";
        miniOutline.textContent = `ミニアウトライン: ${fileLabel}`;
    };
    const sortNodes = (nodes) => {
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
    const buildFileTree = (files, folders) => {
        const root = { name: "", path: "", type: "dir", children: [] };
        folders.forEach((path) => {
            const parts = path.split("/").filter(Boolean);
            let cursor = root;
            parts.forEach((part, index) => {
                const currentPath = parts.slice(0, index + 1).join("/");
                let child = cursor.children.find((node) => node.name === part);
                if (!child) {
                    child = { name: part, path: currentPath, type: "dir", children: [] };
                    cursor.children.push(child);
                }
                else if (child.type !== "dir") {
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
                }
                else {
                    child.type = "dir";
                }
                cursor = child;
            });
        });
        sortNodes(root.children);
        return root.children;
    };
    const getLanguageIdForPath = (path) => {
        if (path.endsWith(".tex")) {
            return "latex";
        }
        if (path.endsWith(".bib")) {
            return "bibtex";
        }
        return "plaintext";
    };
    const setEditorLanguage = (path) => {
        var _a;
        if (!monacoApi || !monacoEditor) {
            return;
        }
        const editor = monacoEditor;
        if (!editor.getModel) {
            return;
        }
        const model = editor.getModel();
        const monacoApiAny = monacoApi;
        const languageId = getLanguageIdForPath(path);
        if (model && ((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.setModelLanguage)) {
            monacoApiAny.editor.setModelLanguage(model, languageId);
        }
    };
    const dragDataType = "application/x-tex180-item";
    const setDragData = (event, payload) => {
        if (!event.dataTransfer) {
            return;
        }
        event.dataTransfer.clearData();
        event.dataTransfer.setData(dragDataType, JSON.stringify(payload));
        event.dataTransfer.effectAllowed = "move";
    };
    const getDragData = (event) => {
        var _a;
        const raw = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData(dragDataType);
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!(parsed === null || parsed === void 0 ? void 0 : parsed.path) || (parsed.kind !== "file" && parsed.kind !== "dir")) {
                return null;
            }
            return parsed;
        }
        catch {
            return null;
        }
    };
    const clearDropTargets = () => {
        document
            .querySelectorAll(".is-drop-target")
            .forEach((element) => element.classList.remove("is-drop-target"));
    };
    const canDropOnFolder = (payload, targetFolder) => {
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
    const requestMoveItem = (payload, targetFolder) => {
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
    const renderFileNodes = (nodes, container, depth) => {
        nodes.forEach((node) => {
            if (node.type === "dir") {
                const details = document.createElement("details");
                details.className = "file-folder";
                details.dataset.path = node.path;
                if (openStateLoaded) {
                    details.open = openFolders.has(node.path);
                }
                else {
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
                const toggleFolder = (nextOpen) => {
                    details.open = nextOpen;
                    summary.classList.toggle("is-open", nextOpen);
                    if (nextOpen) {
                        openFolders.add(node.path);
                    }
                    else {
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
                    const dragEvent = event;
                    const payload = { path: node.path, kind: "dir" };
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
                    const dragEvent = event;
                    dragEvent.stopPropagation();
                    const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
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
                    const dragEvent = event;
                    const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
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
            }
            else {
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
                    const dragEvent = event;
                    const payload = { path: node.path, kind: "file" };
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
                    const dragEvent = event;
                    dragEvent.stopPropagation();
                    const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
                    const targetFolder = getParentPath(node.path);
                    if (!payload || !canDropOnFolder(payload, targetFolder)) {
                        return;
                    }
                    const dropContainer = button.parentElement instanceof HTMLElement ? button.parentElement : null;
                    dragEvent.preventDefault();
                    clearDropTargets();
                    if (dropContainer) {
                        dropContainer.classList.add("is-drop-target");
                    }
                    button.classList.add("is-drop-target");
                });
                button.addEventListener("dragleave", () => {
                    const dropContainer = button.parentElement instanceof HTMLElement ? button.parentElement : null;
                    if (dropContainer) {
                        dropContainer.classList.remove("is-drop-target");
                    }
                    button.classList.remove("is-drop-target");
                });
                button.addEventListener("drop", (event) => {
                    const dragEvent = event;
                    const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
                    const targetFolder = getParentPath(node.path);
                    dragEvent.stopPropagation();
                    dragEvent.preventDefault();
                    const dropContainer = button.parentElement instanceof HTMLElement ? button.parentElement : null;
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
    const ensureModelEntry = (path, content, savedContent) => {
        var _a;
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
        const monacoApiAny = monacoApi;
        if (!((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.createModel)) {
            return null;
        }
        const model = monacoApiAny.editor.createModel(content, getLanguageIdForPath(path));
        const nextEntry = { model, savedContent: savedContent !== null && savedContent !== void 0 ? savedContent : content };
        monacoModels.set(path, nextEntry);
        updateDirtyState(path, content, nextEntry.savedContent);
        return nextEntry;
    };
    const applyFileContent = (path, content, savedContent) => {
        var _a;
        if (!monacoEditor || !monacoApi) {
            updateFallback("エディタの準備が完了していません。");
            return;
        }
        const editor = monacoEditor;
        const entry = ensureModelEntry(path, content, savedContent !== null && savedContent !== void 0 ? savedContent : content);
        clearJumpHighlight();
        isApplyingFile = true;
        if (entry && editor.setModel) {
            editor.setModel(entry.model);
        }
        else if (editor.setValue) {
            editor.setValue(content);
        }
        isApplyingFile = false;
        currentFilePath = path;
        currentFileSavedContent = (_a = entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _a !== void 0 ? _a : (savedContent !== null && savedContent !== void 0 ? savedContent : content);
        if (entry) {
            updateDirtyState(path, entry.model.getValue(), entry.savedContent);
        }
        else if (editor.getValue) {
            updateDirtyState(path, editor.getValue(), currentFileSavedContent !== null && currentFileSavedContent !== void 0 ? currentFileSavedContent : content);
        }
        else {
            updateDirtyState(path, content, currentFileSavedContent !== null && currentFileSavedContent !== void 0 ? currentFileSavedContent : content);
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
        activeBlockRange = null;
        clearInsertPreview();
        if (!pendingBlockEdit) {
            setText(blockTarget, "挿入先: 行 -");
        }
        if (pendingReveal && pendingReveal.path === path) {
            revealLine(pendingReveal.line);
            pendingReveal = null;
        }
        if (editor.focus) {
            editor.focus();
            setTreeFocus(false);
        }
    };
    const requestOpenFile = (path, force = false) => {
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
    const jumpToFileLine = (path, line) => {
        if (currentFilePath === path) {
            revealLine(line);
            return;
        }
        const requested = requestOpenFile(path);
        if (requested) {
            pendingReveal = { path, line };
        }
    };
    const jumpToLocation = (entry) => {
        if (!entry.path || !entry.line) {
            return;
        }
        jumpToFileLine(entry.path, entry.line);
    };
    const jumpToSearchResult = (result) => {
        jumpToFileLine(result.path, result.line);
    };
    const saveCurrentFileInternal = () => {
        if (!currentFilePath || !monacoEditor) {
            updateIssues(1, "保存するファイルが選択されていません。", "error", [
                { severity: "error", message: "保存するファイルが選択されていません。" },
            ]);
            return Promise.resolve(false);
        }
        const editor = monacoEditor;
        const content = editor.getValue();
        return new Promise((resolve, reject) => {
            pendingSave = { path: currentFilePath, content, resolve, reject };
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
        return new Promise((resolve, reject) => {
            scheduleAfterComposition(() => {
                saveCurrentFileInternal().then(resolve).catch(reject);
            });
        });
    };
    const normalizeInputPath = (value) => {
        return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    };
    const validatePath = (value, kind) => {
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
    const isPathAffected = (relativePath) => {
        if (!currentFilePath) {
            return false;
        }
        if (currentFilePath === relativePath) {
            return true;
        }
        return currentFilePath.startsWith(`${relativePath}/`);
    };
    const getParentPath = (value) => {
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
    const setCreateModalOpen = (open) => {
        if (!createModal) {
            return;
        }
        createModal.classList.toggle("is-open", open);
        createModal.setAttribute("aria-hidden", open ? "false" : "true");
    };
    const setCreateModalHelp = (message, isError = false) => {
        if (!createModalHelp) {
            return;
        }
        createModalHelp.textContent = message;
        createModalHelp.classList.toggle("is-error", isError);
    };
    const openCreateModal = (kind) => {
        if (!createModal) {
            return;
        }
        createModalKind = kind;
        const basePath = resolveCreateBasePath();
        setText(createModalTitle, kind === "file" ? "新規ファイルを作成" : "新規フォルダを作成");
        setText(createModalSubtitle, kind === "file"
            ? "作成するファイル名を入力してください。"
            : "作成するフォルダ名を入力してください。");
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
    const requestCreate = (kind) => {
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
        const title = kind === "file"
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
    const setRenameModalOpen = (open) => {
        if (!renameModal) {
            return;
        }
        renameModal.classList.toggle("is-open", open);
        renameModal.setAttribute("aria-hidden", open ? "false" : "true");
    };
    const setRenameModalHelp = (message, isError = false) => {
        if (!renameModalHelp) {
            return;
        }
        renameModalHelp.textContent = message;
        renameModalHelp.classList.toggle("is-error", isError);
    };
    const openRenameModal = (path, kind) => {
        var _a;
        if (!renameModal) {
            return;
        }
        renameTargetPath = path;
        renameTargetType = kind;
        const currentName = (_a = path.split("/").filter(Boolean).pop()) !== null && _a !== void 0 ? _a : "";
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
    const updateIssues = (count, summary, status, issues) => {
        setText(issuesCount, String(count));
        setText(issuesHint, summary);
        setIssuesStatus(status);
        renderIssues(issues);
        if (count > 0) {
            setIssuesOpen(true);
        }
        else {
            setIssuesOpen(false);
            clearIssueHighlight();
        }
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
    const openContextMenu = (x, y, items) => {
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
    const requestRevealInFinder = (path) => {
        postToNative({ type: "revealInFinder", path });
    };
    const requestDeleteItem = (path, kind) => {
        // TODO: re-enable confirm dialogs after fixing host input issue
        postToNative({ type: "deleteItem", path });
    };
    const requestCopyItem = (path, destination) => {
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
    const buildFileContextMenu = (path) => [
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
    const buildFolderContextMenu = (path) => [
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
    const setBuildState = (state, message) => {
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
    const postToNative = (payload, silent = false) => {
        var _a, _b, _c;
        const handler = (_a = bridgeWindow.tex180Bridge) !== null && _a !== void 0 ? _a : (_c = (_b = bridgeWindow.webkit) === null || _b === void 0 ? void 0 : _b.messageHandlers) === null || _c === void 0 ? void 0 : _c.tex180;
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
        const mainFile = rootFilePath !== null && rootFilePath !== void 0 ? rootFilePath : (currentFilePath && currentFilePath.endsWith(".tex")
            ? currentFilePath
            : undefined);
        const payload = { type: "build" };
        if (mainFile) {
            payload.mainFile = mainFile;
        }
        if (postToNative(payload)) {
            setBuildState("building");
            updateIssues(0, "ビルドを開始します。", "info", []);
        }
    };
    const handleLauncherStatus = (payload) => {
        var _a;
        setLauncherStatus({
            isBusy: typeof payload.isBusy === "boolean" ? payload.isBusy : undefined,
            message: (_a = payload.message) !== null && _a !== void 0 ? _a : null,
        });
    };
    const handleWorkspaceUpdate = (payload) => {
        var _a;
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
        rootFilePath = ((_a = payload.rootFile) === null || _a === void 0 ? void 0 : _a.trim()) ? payload.rootFile : null;
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
        blocks = [];
        renderBlocksList();
        postToNative({ type: "loadBlocks" }, true);
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
    const handleIndexUpdate = (payload) => {
        indexLabels = Array.isArray(payload.labels) ? payload.labels : [];
        indexCitations = Array.isArray(payload.citations) ? payload.citations : [];
        indexSections = Array.isArray(payload.sections) ? payload.sections : [];
        indexFigures = Array.isArray(payload.figures) ? payload.figures : [];
        indexTables = Array.isArray(payload.tables) ? payload.tables : [];
        indexTodos = Array.isArray(payload.todos) ? payload.todos : [];
        renderOutline();
    };
    const handleBlocksUpdate = (payload) => {
        blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
        renderBlocksList();
    };
    const handleOpenFileResult = (payload) => {
        var _a;
        if (payload.error) {
            if (pendingReveal && pendingReveal.path === payload.path) {
                pendingReveal = null;
            }
            updateIssues(1, payload.error, "error", [
                { severity: "error", message: payload.error },
            ]);
            return;
        }
        const content = (_a = payload.content) !== null && _a !== void 0 ? _a : "";
        applyFileContent(payload.path, content, content);
        if (pendingBlockEdit && pendingBlockEdit.file === payload.path) {
            const block = pendingBlockEdit;
            pendingBlockEdit = null;
            prepareBlockEdit(block);
        }
    };
    const handleSaveResult = (payload) => {
        var _a, _b, _c;
        let savedContent = null;
        if (pendingSave && pendingSave.path === payload.path) {
            if (payload.ok) {
                savedContent = pendingSave.content;
                pendingSave.resolve(true);
            }
            else {
                pendingSave.reject((_a = payload.error) !== null && _a !== void 0 ? _a : "保存に失敗しました。");
            }
            pendingSave = null;
        }
        if (!payload.ok) {
            updateIssues(1, (_b = payload.error) !== null && _b !== void 0 ? _b : "保存に失敗しました。", "error", [
                { severity: "error", message: (_c = payload.error) !== null && _c !== void 0 ? _c : "保存に失敗しました。" },
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
                const editor = monacoEditor;
                const currentValue = editor.getValue();
                updateDirtyState(payload.path, currentValue, currentFileSavedContent);
            }
            else {
                isDirty = false;
            }
        }
        else {
            isDirty = currentFilePath ? dirtyFiles.has(currentFilePath) : false;
        }
        updateBreadcrumbs();
        renderFileTree();
        if (autoBuildEnabled && autoBuildPending && (currentFilePath === null || currentFilePath === void 0 ? void 0 : currentFilePath.endsWith(".tex"))) {
            autoBuildPending = false;
            startBuild();
        }
    };
    const handleRenameResult = (payload) => {
        const { oldPath, newPath } = payload;
        const remapPath = (path) => {
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
            const updated = new Set();
            openFolders.forEach((entry) => {
                if (entry === oldPath || entry.startsWith(`${oldPath}/`)) {
                    updated.add(newPath + entry.slice(oldPath.length));
                }
                else {
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
        }
        else if (currentFilePath === oldPath) {
            currentFilePath = newPath;
            currentPathChanged = true;
        }
        const tabIndex = openTabs.indexOf(oldPath);
        if (tabIndex !== -1) {
            openTabs = openTabs.map((entry) => (entry === oldPath ? newPath : entry));
        }
        if (monacoModels.size > 0) {
            const updatedModels = new Map();
            monacoModels.forEach((entry, path) => {
                updatedModels.set(remapPath(path), entry);
            });
            monacoModels.clear();
            updatedModels.forEach((entry, path) => monacoModels.set(path, entry));
        }
        if (monacoViewStates.size > 0) {
            const updatedViewStates = new Map();
            monacoViewStates.forEach((state, path) => {
                updatedViewStates.set(remapPath(path), state);
            });
            monacoViewStates.clear();
            updatedViewStates.forEach((state, path) => monacoViewStates.set(path, state));
        }
        if (dirtyFiles.size > 0) {
            const updatedDirty = new Set();
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
            }
            else if (monacoEditor) {
                const editor = monacoEditor;
                currentFileSavedContent = editor.getValue();
            }
        }
        updateBreadcrumbs();
        updateMiniOutline();
        renderFileTree();
    };
    const normalizeTabKey = (key) => {
        if (key && key in tabConfig) {
            return key;
        }
        return "files";
    };
    const setActiveTab = (tabKey) => {
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
    const initialTab = normalizeTabKey((_a = tabs.find((tab) => tab.classList.contains("is-active"))) === null || _a === void 0 ? void 0 : _a.dataset.tab);
    setActiveTab(initialTab);
    setWorkspaceLabel(workspaceName);
    updateBreadcrumbs();
    renderFileTree();
    renderOutline();
    setActiveBlockType(activeBlockType);
    setMathKeyboardTab(activeMathKeyboardTab);
    try {
        setupMathField();
    }
    catch (e) {
        console.error("setupMathField error:", e);
        updateIssues(1, "数式エディタの初期化に失敗しました: " + e.message, "error", []);
    }
    try {
        setupResizer();
    }
    catch (e) {
        console.error("setupResizer error:", e);
        // リサイズ機能のエラーは致命的ではないので通知しないか、infoレベルで
    }
    try {
        attachMathInputListener();
    }
    catch (e) {
        console.error("attachMathInputListener error:", e);
        // updateIssues(1, "数式入力リスナーのエラー: " + e.message, "error", []);
    }
    try {
        updateMathPreview();
    }
    catch (e) {
        console.error("updateMathPreview error:", e);
    }
    // renderBlocksList();
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
    const updateFallback = (message) => {
        if (!fallback) {
            return;
        }
        const body = fallback.querySelector("p");
        if (body) {
            body.textContent = message;
        }
    };
    const registerCompletionProvider = (monaco) => {
        var _a, _b, _c, _d, _e;
        if (completionRegistered || !((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider)) {
            return;
        }
        (_c = (_b = monaco.languages).register) === null || _c === void 0 ? void 0 : _c.call(_b, { id: "latex" });
        (_e = (_d = monaco.languages).register) === null || _e === void 0 ? void 0 : _e.call(_d, { id: "bibtex" });
        const provideItems = (model, position) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            if (!currentFilePath || !currentFilePath.endsWith(".tex")) {
                return { suggestions: [] };
            }
            const line = model.getLineContent(position.lineNumber);
            const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
            const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
            const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);
            let entries = [];
            let partial = "";
            if (refMatch) {
                entries = dedupeByKey(indexLabels);
                partial = (_a = refMatch[1]) !== null && _a !== void 0 ? _a : "";
            }
            else if (citeMatch) {
                entries = pickCitationEntries(indexCitations);
                const raw = (_b = citeMatch[1]) !== null && _b !== void 0 ? _b : "";
                const parts = raw.split(",");
                partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
            }
            else {
                return { suggestions: [] };
            }
            const range = monaco.Range
                ? new monaco.Range(position.lineNumber, position.column - partial.length, position.lineNumber, position.column)
                : undefined;
            const kind = (_h = (_e = (_d = (_c = monaco.languages) === null || _c === void 0 ? void 0 : _c.CompletionItemKind) === null || _d === void 0 ? void 0 : _d.Reference) !== null && _e !== void 0 ? _e : (_g = (_f = monaco.languages) === null || _f === void 0 ? void 0 : _f.CompletionItemKind) === null || _g === void 0 ? void 0 : _g.Value) !== null && _h !== void 0 ? _h : 17;
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
            var _a, _b;
            (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider) === null || _b === void 0 ? void 0 : _b.call(_a, languageId, {
                triggerCharacters: ["{", ",", "\\"],
                provideCompletionItems: provideItems,
            });
        });
        completionRegistered = true;
    };
    const setQuickInsertOpen = (isOpen) => {
        if (quickInsertPanel) {
            quickInsertPanel.classList.toggle("is-open", isOpen);
            quickInsertPanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
        }
        if (quickInsertButton instanceof HTMLElement) {
            quickInsertButton.classList.toggle("is-active", isOpen);
        }
    };
    const buildPreviewText = (value) => {
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
            const editor = monacoEditor;
            editor.removeContentWidget(quickInsertWidget);
            quickInsertWidget = null;
        }
    };
    const setInsertPreviewText = (text) => {
        const previewText = buildPreviewText(text);
        if (quickInsertWidgetBody) {
            quickInsertWidgetBody.textContent = previewText;
        }
        if (monacoEditor && quickInsertWidget) {
            const editor = monacoEditor;
            editor.layoutContentWidget(quickInsertWidget);
        }
    };
    const updateQuickInsertPreview = () => {
        const value = quickInsertInput instanceof HTMLTextAreaElement
            ? quickInsertInput.value
            : "";
        setInsertPreviewText(value);
        if (quickInsertAccept instanceof HTMLButtonElement) {
            quickInsertAccept.disabled = value.trim().length === 0;
        }
    };
    const ensureQuickInsertWidget = () => {
        if (!monacoEditor || !monacoApi) {
            return;
        }
        if (!quickInsertWidgetNode) {
            const container = document.createElement("div");
            container.className = "quick-insert-preview";
            const title = document.createElement("div");
            title.className = "quick-insert-preview-title";
            title.textContent = "プレビュー";
            const body = document.createElement("pre");
            body.className = "quick-insert-preview-body";
            container.append(title, body);
            quickInsertWidgetNode = container;
            quickInsertWidgetBody = body;
        }
        if (!quickInsertWidget) {
            const monacoApiAny = monacoApi;
            quickInsertWidget = {
                getId: () => "quick-insert-preview",
                getDomNode: () => quickInsertWidgetNode,
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
            const editor = monacoEditor;
            editor.addContentWidget(quickInsertWidget);
        }
    };
    const startBlockPreview = (snippet, target) => {
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
        closeQuickInsert();
        clearInsertPreview();
        const editor = monacoEditor;
        const position = target !== null && target !== void 0 ? target : editor.getPosition();
        quickInsertTarget = position
            ? { lineNumber: position.lineNumber, column: position.column }
            : { lineNumber: 1, column: 1 };
        setText(blockTarget, `${currentFilePath} · 行 ${quickInsertTarget.lineNumber}`);
        applyQuickInsertDecorations();
        ensureQuickInsertWidget();
        setInsertPreviewText(buildBlockPreviewSnippet(snippet));
        blockPreviewActive = true;
    };
    const applyBlockInsert = () => {
        if (!blockPreviewActive) {
            updateIssues(1, "プレビューを確認してから確定してください。", "error", [
                { severity: "error", message: "プレビューを確認してから確定してください。" },
            ]);
            return;
        }
        const draft = getBlockDraft();
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
        const editor = monacoEditor;
        const monacoApiAny = monacoApi;
        let range;
        let line = quickInsertTarget.lineNumber;
        let column = quickInsertTarget.column;
        if (activeBlockEditId) {
            if (!activeBlockRange) {
                updateIssues(1, "ブロックの位置が見つかりません。", "error", [
                    { severity: "error", message: "ブロックの位置が見つかりません。" },
                ]);
                return;
            }
            range = activeBlockRange;
            line = activeBlockRange.startLineNumber;
            column = activeBlockRange.startColumn;
        }
        else {
            range = new monacoApiAny.Range(line, column, line, column);
        }
        editor.executeEdits("block-insert", [
            {
                range,
                text: draft.snippet,
                forceMoveMarkers: true,
            },
        ]);
        editor.focus();
        const now = new Date().toISOString();
        if (activeBlockEditId) {
            const index = blocks.findIndex((item) => item.id === activeBlockEditId);
            if (index >= 0) {
                blocks[index] = {
                    ...blocks[index],
                    file: currentFilePath,
                    line,
                    column,
                    snippet: draft.snippet,
                    content: draft.content,
                    updatedAt: now,
                };
            }
            else {
                blocks.push({
                    id: activeBlockEditId,
                    type: activeBlockType,
                    file: currentFilePath,
                    line,
                    column,
                    snippet: draft.snippet,
                    content: draft.content,
                    deps: [],
                    updatedAt: now,
                });
            }
        }
        else {
            const id = typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            blocks.push({
                id,
                type: activeBlockType,
                file: currentFilePath,
                line,
                column,
                snippet: draft.snippet,
                content: draft.content,
                deps: [],
                updatedAt: now,
            });
        }
        renderBlocksList();
        saveBlocks();
        resetBlockSession();
    };
    const applyQuickInsertDecorations = () => {
        if (!monacoEditor || !monacoApi) {
            return;
        }
        const monacoApiAny = monacoApi;
        const editor = monacoEditor;
        quickInsertDecorations = editor.deltaDecorations(quickInsertDecorations, [
            {
                range: new monacoApiAny.Range(quickInsertTarget.lineNumber, 1, quickInsertTarget.lineNumber, 1),
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
        const editor = monacoEditor;
        quickInsertDecorations = editor.deltaDecorations(quickInsertDecorations, []);
    };
    const openQuickInsert = () => {
        if (!monacoEditor || !monacoApi) {
            updateFallback("エディタの準備が完了していません。");
            return;
        }
        resetBlockSession();
        const editor = monacoEditor;
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
        const value = quickInsertInput instanceof HTMLTextAreaElement
            ? quickInsertInput.value
            : "";
        if (value.trim().length === 0) {
            if (quickInsertHint) {
                setText(quickInsertHint, "挿入内容が空のため確定できません。");
            }
            return;
        }
        const monacoApiAny = monacoApi;
        const editor = monacoEditor;
        editor.executeEdits("quick-insert", [
            {
                range: new monacoApiAny.Range(quickInsertTarget.lineNumber, quickInsertTarget.column, quickInsertTarget.lineNumber, quickInsertTarget.column),
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
            const isOpen = quickInsertPanel === null || quickInsertPanel === void 0 ? void 0 : quickInsertPanel.classList.contains("is-open");
            if (isOpen) {
                closeQuickInsert();
            }
            else {
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
    if (blockPreviewButton instanceof HTMLButtonElement) {
        blockPreviewButton.addEventListener("click", () => {
            const draft = getBlockDraft();
            if (!draft) {
                updateIssues(1, "ブロック内容を入力してください。", "error", [
                    { severity: "error", message: "ブロック内容を入力してください。" },
                ]);
                return;
            }
            const target = activeBlockRange
                ? { lineNumber: activeBlockRange.startLineNumber, column: activeBlockRange.startColumn }
                : undefined;
            startBlockPreview(draft.snippet, target);
        });
    }
    if (blockAcceptButton instanceof HTMLButtonElement) {
        blockAcceptButton.addEventListener("click", () => {
            applyBlockInsert();
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
    mathKeyboardTabs.forEach((button) => {
        button.addEventListener("click", () => {
            const tab = button.dataset.mathTab;
            if (tab === "relations" ||
                tab === "operators" ||
                tab === "greek" ||
                tab === "structures") {
                setMathKeyboardTab(tab);
                return;
            }
            setMathKeyboardTab("basic");
        });
    });
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
    if (searchButton instanceof HTMLButtonElement) {
        searchButton.addEventListener("click", () => {
            const value = searchInput instanceof HTMLInputElement ? searchInput.value.trim() : "";
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
            }
            else if (event.key === "Escape") {
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
            }
            else if (event.key === "Escape") {
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
            const dragEvent = event;
            const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
            if (!payload) {
                return;
            }
            if (!canDropOnFolder(payload, "")) {
                return;
            }
            const target = dragEvent.target;
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
            const dragEvent = event;
            const payload = dragPayload !== null && dragPayload !== void 0 ? dragPayload : getDragData(dragEvent);
            dragEvent.preventDefault();
            fileTree.classList.remove("is-drop-target");
            if (!payload) {
                return;
            }
            const target = dragEvent.target;
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
    });
    window.addEventListener("scroll", () => {
        if (contextMenuOpen) {
            closeContextMenu();
        }
    }, true);
    window.addEventListener("resize", () => {
        if (contextMenuOpen) {
            closeContextMenu();
        }
    });
    if (saveFileButton instanceof HTMLButtonElement) {
        saveFileButton.addEventListener("click", () => {
            saveCurrentFile().catch((message) => {
                updateIssues(1, message, "error", [{ severity: "error", message }]);
            });
        });
    }
    window.addEventListener("keydown", (event) => {
        const targetElement = event.target;
        const isTreeShortcutTarget = treeHasFocus &&
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
            saveCurrentFile().catch((message) => {
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
                    .catch((message) => {
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
        var _a, _b;
        const status = (_a = payload.status) !== null && _a !== void 0 ? _a : (payload.count > 0 ? "error" : "success");
        updateIssues(payload.count, payload.summary, status, (_b = payload.issues) !== null && _b !== void 0 ? _b : []);
    };
    bridgeWindow.tex180UpdateWorkspace = (payload) => {
        handleWorkspaceUpdate(payload);
    };
    bridgeWindow.tex180UpdateIndex = (payload) => {
        handleIndexUpdate(payload);
    };
    bridgeWindow.tex180UpdateBlocks = (payload) => {
        handleBlocksUpdate(payload);
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
    const handleBridgeMessage = (message) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        if (!(message === null || message === void 0 ? void 0 : message.type)) {
            return;
        }
        switch (message.type) {
            case "setBuildState":
                (_a = bridgeWindow.tex180SetBuildState) === null || _a === void 0 ? void 0 : _a.call(bridgeWindow, message.payload);
                break;
            case "updateIssues":
                (_b = bridgeWindow.tex180UpdateIssues) === null || _b === void 0 ? void 0 : _b.call(bridgeWindow, message.payload);
                break;
            case "updateWorkspace":
                (_c = bridgeWindow.tex180UpdateWorkspace) === null || _c === void 0 ? void 0 : _c.call(bridgeWindow, message.payload);
                break;
            case "updateIndex":
                (_d = bridgeWindow.tex180UpdateIndex) === null || _d === void 0 ? void 0 : _d.call(bridgeWindow, message.payload);
                break;
            case "updateBlocks":
                (_e = bridgeWindow.tex180UpdateBlocks) === null || _e === void 0 ? void 0 : _e.call(bridgeWindow, message.payload);
                break;
            case "updateSearch":
                (_f = bridgeWindow.tex180UpdateSearch) === null || _f === void 0 ? void 0 : _f.call(bridgeWindow, message.payload);
                break;
            case "updateGit":
                (_g = bridgeWindow.tex180UpdateGit) === null || _g === void 0 ? void 0 : _g.call(bridgeWindow, message.payload);
                break;
            case "openFileResult":
                (_h = bridgeWindow.tex180OpenFileResult) === null || _h === void 0 ? void 0 : _h.call(bridgeWindow, message.payload);
                break;
            case "saveResult":
                (_j = bridgeWindow.tex180SaveResult) === null || _j === void 0 ? void 0 : _j.call(bridgeWindow, message.payload);
                break;
            case "renameResult":
                (_k = bridgeWindow.tex180RenameResult) === null || _k === void 0 ? void 0 : _k.call(bridgeWindow, message.payload);
                break;
            case "launcherStatus":
                handleLauncherStatus(message.payload);
                break;
            default:
                break;
        }
    };
    if ((_b = bridgeWindow.tex180Bridge) === null || _b === void 0 ? void 0 : _b.onMessage) {
        bridgeWindow.tex180Bridge.onMessage(handleBridgeMessage);
    }
    if (!(editorHost instanceof HTMLElement)) {
        updateFallback("エディタ領域が見つかりません。");
        return;
    }
    const baseUrl = new URL("monaco/vs/", window.location.href).toString();
    const requireBase = baseUrl.replace(/\/$/, "");
    const monacoWindow = window;
    monacoWindow.MonacoEnvironment = {
        getWorkerUrl: () => {
            const workerMain = `${baseUrl}base/worker/workerMain.js`;
            const workerBootstrap = [
                `self.MonacoEnvironment = { baseUrl: '${baseUrl}' };`,
                `importScripts('${workerMain}');`,
            ].join("\n");
            return URL.createObjectURL(new Blob([workerBootstrap], { type: "text/javascript" }));
        },
    };
    if (!monacoWindow.require || !monacoWindow.require.config) {
        updateFallback("Monacoのローダーが見つかりません。");
        return;
    }
    monacoWindow.require.config({ paths: { vs: requireBase } });
    monacoWindow.require(["vs/editor/editor.main"], () => {
        var _a;
        if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
            updateFallback("Monacoの初期化に失敗しました。");
            return;
        }
        monacoApi = monacoWindow.monaco;
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
        }); // Cast to any to access full Monaco API
        monacoEditor = editor;
        openPendingFileIfReady();
        editorHost.addEventListener("compositionstart", () => {
            isComposing = true;
            compositionText = "";
            composingFilePath = currentFilePath;
        });
        editorHost.addEventListener("compositionupdate", (e) => {
            compositionText = e.data || "";
        });
        editorHost.addEventListener("compositionend", (e) => {
            const data = e.data;
            // If compositionend has no data (cancelled by focus loss) but we have stored text
            if (!data && compositionText) {
                // Verify we are still in the same file to prevent leaking text to new tab
                if (composingFilePath === currentFilePath) {
                    const editor = monacoEditor;
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
        (_a = editor.onDidFocusEditorWidget) === null || _a === void 0 ? void 0 : _a.call(editor, () => {
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
            }
            else if (!isDirty) {
                autoBuildPending = false;
            }
            updateBreadcrumbs();
            renderFileTree();
        });
        document.body.classList.add("has-editor");
    }, () => {
        updateFallback("Monacoの読み込みに失敗しました。");
    });
});
