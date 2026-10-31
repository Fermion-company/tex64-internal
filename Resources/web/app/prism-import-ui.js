import { getUiLocale, uiText } from "./i18n.js";
const STEPS = ["extract", "analyze", "env", "build", "compare"];
const ENGINES = ["pdflatex", "lualatex", "xelatex", "uplatex"];
const BIB_TOOLS = ["biber", "bibtex", "none"];
class ImportError extends Error {
    constructor(code, step = null) {
        super(code);
        this.code = code;
        this.step = step;
    }
}
const el = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text)
        node.textContent = text;
    return node;
};
// The shared dictionary rewrites fragments of English sentences ("was not
// found" → "が見つかりません") and would leave half-translated lines; in
// Japanese the Japanese wording given here wins.
const words = (english, japanese) => (getUiLocale() === "ja" ? japanese : uiText(english, japanese));
const bridge = () => { var _a; return (_a = window.tex64Prism) !== null && _a !== void 0 ? _a : null; };
export const initPrismImportUi = (deps) => {
    var _a;
    const stepLabel = (step) => ({
        extract: words("Unpack", "展開"),
        analyze: words("Detect", "判定"),
        env: words("Environment", "環境"),
        build: words("Build", "ビルド"),
        compare: words("Compare", "比較"),
    })[step];
    const diffLabel = (key) => {
        var _a;
        return (_a = ({
            title: words("Title", "タイトル"),
            sections: words("Section headings", "節見出し"),
            equations: words("Equation numbers", "式番号"),
            citations: words("Citations", "引用"),
            pageCount: words("Pages", "ページ数"),
        })[key]) !== null && _a !== void 0 ? _a : key;
    };
    const bibLabel = (tool) => (tool === "none" ? words("None", "なし") : tool);
    const messageFor = (code) => {
        var _a;
        return (_a = ({
            ZIP_NOT_ZIP: words("Choose a .zip file exported from Prism.", "Prism から書き出した .zip を選んでください。"),
            ZIP_NOT_FOUND: words("The zip file was not found.", "zip ファイルが見つかりません。"),
            ZIP_INVALID: words("The file could not be read as a zip.", "zip として読めません。"),
            ZIP_TOO_LARGE: words("The zip is larger than 2 GB.", "zip が 2 GB を超えています。"),
            ZIP_TOO_MANY: words("The zip holds too many files.", "zip のファイル数が多すぎます。"),
            ZIP_EMPTY: words("The zip holds no files.", "zip にファイルがありません。"),
            ZIP_UNSAFE_PATH: words("The zip holds a path outside its folder.", "zip にフォルダの外を指すパスがあります。"),
            DEST_NAME: words("No free folder name at the destination.", "展開先に空いているフォルダ名がありません。"),
            NO_TEX: words("No .tex file was found in the zip.", "zip に .tex ファイルがありません。"),
            NO_MAIN: words("No file with \\documentclass and \\begin{document} was found.", "\\documentclass と \\begin{document} を含むファイルがありません。"),
            TEX_MISSING: words("TeX is not installed yet.", "TeX がまだ入っていません。"),
            BUILD_BUSY: words("Another typeset is running.", "別の組版が実行中です。"),
            SESSION_ENDED: words("This import has ended. Start it again.", "この読み込みは終了しています。やり直してください。"),
            UNKNOWN_PROJECT: words("Unknown project.", "不明なプロジェクトです。"),
            UNAVAILABLE: words("Prism import is not available.", "Prism の読み込みは使えません。"),
            COMPARE_FAILED: words("The PDFs could not be compared.", "PDF を比較できませんでした。"),
            NO_PRISM_PDF: words("The project holds no PDF from Prism to compare with.", "比較できる Prism の PDF がプロジェクトにありません。"),
        })[code]) !== null && _a !== void 0 ? _a : words("Prism import failed.", "Prism の読み込みに失敗しました。") + ` (${code})`;
    };
    let modal = null;
    let sessionId = null;
    let destination = "";
    let env = null;
    let states = [];
    let current = null;
    let busy = false;
    let awaitingRuntime = false;
    let sessionError = "";
    // Progress arrives before `start` has returned the session id. Only one
    // import runs at a time, so the first id seen while starting is adopted
    // provisionally and the steps move while the zip is still unpacking.
    let provisionalSessionId = null;
    let collecting = false;
    let buildStartedAt = 0;
    let buildTimer = null;
    const stepStatus = new Map();
    const stepDetail = new Map();
    // DOM
    let stepsList;
    let projectRow;
    let projectSelect;
    let mainSelect;
    let engineSelect;
    let bibSelect;
    let fields;
    let diffBox;
    let pathsBox;
    let errorBox;
    let openButton;
    let closeButton;
    const call = async (action, payload = {}) => {
        var _a;
        const api = bridge();
        if (!api)
            throw new ImportError("UNAVAILABLE");
        const result = await api.call(action, payload);
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            throw new ImportError((result === null || result === void 0 ? void 0 : result.code) || "FAILED", (_a = result === null || result === void 0 ? void 0 : result.step) !== null && _a !== void 0 ? _a : null);
        return result;
    };
    const setStep = (step, status, detail = "") => {
        stepStatus.set(step, status);
        stepDetail.set(step, detail);
        renderSteps();
    };
    const resetSteps = () => {
        STEPS.forEach((step) => { stepStatus.set(step, "pending"); stepDetail.set(step, ""); });
        renderSteps();
    };
    const renderSteps = () => {
        var _a;
        if (!stepsList)
            return;
        stepsList.replaceChildren();
        for (const step of STEPS) {
            const status = (_a = stepStatus.get(step)) !== null && _a !== void 0 ? _a : "pending";
            const item = el("li", `prism-step is-${status}`);
            const mark = el("span", "prism-step-mark", status === "done" ? "✓" : status === "failed" ? "×" : status === "running" ? "…" : "·");
            const name = el("span", "prism-step-name", stepLabel(step));
            item.append(mark, name);
            const detail = stepDetail.get(step);
            if (detail)
                item.append(el("span", "history-date", detail));
            stepsList.append(item);
        }
    };
    const fillSelect = (select, values, labels, selected) => {
        select.replaceChildren();
        for (const value of values) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = labels(value);
            select.append(option);
        }
        select.value = selected;
    };
    const renderFields = () => {
        if (!current) {
            fields.hidden = true;
            return;
        }
        fields.hidden = false;
        const { analysis } = current.project;
        const ordered = [...analysis.candidates, ...analysis.texFiles.filter((file) => !analysis.candidates.includes(file))];
        fillSelect(mainSelect, ordered, (value) => value, current.mainFile);
        fillSelect(engineSelect, ENGINES, (value) => value, current.engine);
        fillSelect(bibSelect, BIB_TOOLS, bibLabel, current.bibTool);
        mainSelect.disabled = busy || ordered.length === 0;
        engineSelect.disabled = busy;
        bibSelect.disabled = busy;
        projectSelect.disabled = busy;
    };
    const countText = (value) => `${value} ${words("", "件")}`.trim();
    const ordinal = (index) => (getUiLocale() === "ja" ? `${index + 1} 番目` : `#${index + 1}`);
    const joiner = () => words(", ", "、");
    const renderIssues = (result) => {
        const box = el("div", "prism-issues");
        const issues = result.build.issues;
        if (issues.length === 0) {
            box.append(el("p", "history-error", words("Typesetting failed.", "組版に失敗しました。")));
        }
        for (const issue of issues) {
            const where = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ""}  ` : "";
            box.append(el("p", "history-error", `${where}${issue.message}`));
        }
        const more = el("button", "history-button", words("Show details", "詳細を見る"));
        more.type = "button";
        // The Issues panel belongs to the open workspace: open this project first
        // when it is not the one open, then hand the issues over.
        more.addEventListener("click", () => {
            if (!current || !sessionId)
                return;
            const project = current.project;
            void (async () => {
                let payload;
                try {
                    payload = (await call("show-issues", { sessionId, projectId: project.id }));
                }
                catch {
                    return;
                }
                finish();
                if (deps.getWorkspaceRoot() !== project.root) {
                    deps.openProjectPath(project.root);
                    const until = Date.now() + 15000;
                    while (Date.now() < until && deps.getWorkspaceRoot() !== project.root) {
                        await new Promise((resolve) => setTimeout(resolve, 200));
                    }
                    if (deps.getWorkspaceRoot() !== project.root)
                        return;
                    // The switch still reports its own cancel/idle issues for a moment.
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                }
                deps.showIssues(payload.summary, payload.issues);
            })();
        });
        box.append(more);
        return box;
    };
    const renderDiff = () => {
        var _a, _b;
        diffBox.replaceChildren();
        diffBox.classList.toggle("is-stale", busy);
        if (!current || !current.result)
            return;
        const { build, diff, compareError } = current.result;
        if (!build.ok) {
            diffBox.append(renderIssues(current.result));
            return;
        }
        if (!diff) {
            diffBox.append(el("p", "", messageFor(compareError || "COMPARE_FAILED")));
            return;
        }
        const changed = diff.filter((row) => !row.same);
        const list = el("ul", "prism-diff-list");
        if (changed.length === 0) {
            list.append(el("li", "prism-diff-same", words("Matches Prism's PDF", "Prism の PDF と一致")));
        }
        else {
            for (const row of changed) {
                const item = el("li", "prism-diff-row");
                item.append(el("span", "prism-diff-key", diffLabel(row.key)));
                let text;
                if (row.key === "title") {
                    text = `Prism “${row.prism || "—"}” → TeX64 “${row.local || "—"}”`;
                }
                else if (row.key === "pageCount") {
                    text = `Prism ${countText(row.prism)} → TeX64 ${countText(row.local)}`;
                }
                else {
                    text = `Prism ${countText(row.prism)} → TeX64 ${countText(row.local)}`;
                    if (row.first) {
                        const detail = row.first.prism == null
                            ? words(`${ordinal(row.first.index)} added: ${(_a = row.first.local) !== null && _a !== void 0 ? _a : ""}`, `${ordinal(row.first.index)}が増加: ${(_b = row.first.local) !== null && _b !== void 0 ? _b : ""}`)
                            : row.first.local == null
                                ? words(`${ordinal(row.first.index)} missing: ${row.first.prism}`, `${ordinal(row.first.index)}が消失: ${row.first.prism}`)
                                : words(`first difference ${ordinal(row.first.index)}: ${row.first.prism} → ${row.first.local}`, `最初の相違 ${ordinal(row.first.index)}: ${row.first.prism} → ${row.first.local}`);
                        text += ` (${detail})`;
                    }
                }
                item.append(el("span", "prism-diff-value", text));
                list.append(item);
            }
            const same = diff.filter((row) => row.same);
            if (same.length > 0) {
                list.append(el("li", "prism-diff-same", `${words("Matches", "一致")}: ${same.map((row) => diffLabel(row.key)).join(joiner())}`));
            }
        }
        diffBox.append(list);
    };
    const renderPaths = () => {
        pathsBox.replaceChildren();
        if (!destination)
            return;
        pathsBox.append(el("p", "history-date", `${words("Unpacked to", "展開先")}: ${destination}`));
        if (current && current.project.notes.length > 0) {
            const dir = current.project.notes[0].split("/").slice(0, -1).join("/");
            pathsBox.append(el("p", "history-date", `${words("Conversation notes", "会話メモ")}: ${current.project.root}/${dir}`));
        }
    };
    const renderAll = () => {
        renderSteps();
        renderFields();
        renderDiff();
        renderPaths();
        errorBox.textContent = sessionError || (current === null || current === void 0 ? void 0 : current.error) || "";
        openButton.hidden = !current;
        openButton.disabled = busy || !current;
        projectRow.hidden = states.length <= 1;
    };
    // Keep the result area from collapsing while the next build runs.
    const holdDiffHeight = () => {
        if (diffBox && diffBox.offsetHeight > 0)
            diffBox.style.minHeight = `${diffBox.offsetHeight}px`;
    };
    const releaseDiffHeight = () => { if (diffBox)
        diffBox.style.minHeight = ""; };
    const buildProgressText = () => {
        const seconds = buildStartedAt > 0 ? Math.max(0, Math.floor((Date.now() - buildStartedAt) / 1000)) : 0;
        const phase = words("Building…", "ビルド中…");
        return seconds > 0 ? `${phase} ${seconds}s` : phase;
    };
    const startBuildTimer = () => {
        buildStartedAt = Date.now();
        if (buildTimer === null)
            buildTimer = window.setInterval(() => {
                if (stepStatus.get("build") === "running")
                    setStep("build", "running", buildProgressText());
            }, 1000);
    };
    const stopBuildTimer = () => {
        if (buildTimer !== null)
            window.clearInterval(buildTimer);
        buildTimer = null;
        buildStartedAt = 0;
    };
    const ensureDialog = () => {
        if (modal)
            return modal;
        modal = el("dialog", "history-confirm prism-import");
        const heading = el("h2", "", words("Import from Prism", "Prism から読み込む"));
        heading.id = "prism-import-title";
        modal.setAttribute("aria-labelledby", heading.id);
        stepsList = el("ol", "prism-steps");
        projectRow = el("label", "prism-field");
        projectRow.append(el("span", "", words("Project", "プロジェクト")));
        projectSelect = el("select", "history-name");
        projectRow.append(projectSelect);
        projectRow.hidden = true;
        projectSelect.addEventListener("change", () => {
            const next = states.find((state) => state.project.id === projectSelect.value);
            if (!next || next === current)
                return;
            holdDiffHeight();
            current = next;
            renderAll();
            if (!current.result && !busy)
                void runBuild();
            else
                releaseDiffHeight();
        });
        fields = el("div", "prism-fields");
        const field = (label) => {
            const row = el("label", "prism-field");
            row.append(el("span", "", label));
            const select = el("select", "history-name");
            row.append(select);
            fields.append(row);
            return select;
        };
        mainSelect = field(words("Main file", "メインファイル"));
        engineSelect = field(words("Engine", "エンジン"));
        bibSelect = field(words("Bibliography", "文献ツール"));
        for (const select of [mainSelect, engineSelect, bibSelect]) {
            select.addEventListener("change", () => {
                if (!current || busy)
                    return;
                holdDiffHeight();
                current.mainFile = mainSelect.value;
                current.engine = engineSelect.value;
                current.bibTool = bibSelect.value;
                void runBuild();
            });
        }
        diffBox = el("div", "prism-diff");
        pathsBox = el("div", "prism-paths");
        errorBox = el("p", "history-error");
        const actions = el("div", "history-confirm-actions");
        openButton = el("button", "history-button is-primary", words("Open this project", "このプロジェクトを開く"));
        openButton.type = "button";
        openButton.addEventListener("click", () => {
            if (!current)
                return;
            const root = current.project.root;
            finish();
            deps.openProjectPath(root);
        });
        closeButton = el("button", "history-button", words("Close", "閉じる"));
        closeButton.type = "button";
        closeButton.addEventListener("click", () => finish());
        actions.append(openButton, closeButton);
        modal.append(heading, stepsList, projectRow, fields, diffBox, pathsBox, errorBox, actions);
        modal.addEventListener("cancel", (event) => { event.preventDefault(); finish(); });
        modal.addEventListener("close", () => { modal === null || modal === void 0 ? void 0 : modal.remove(); modal = null; });
        document.body.append(modal);
        return modal;
    };
    const show = () => {
        const dialog = ensureDialog();
        if (!dialog.open)
            dialog.showModal();
        renderAll();
    };
    // Closing ends the session; a typeset still running is cancelled with it.
    const finish = () => {
        stopBuildTimer();
        if (sessionId && !awaitingRuntime) {
            const id = sessionId;
            void call("end", { sessionId: id }).catch(() => { });
            sessionId = null;
            busy = false;
        }
        modal === null || modal === void 0 ? void 0 : modal.close();
    };
    const fail = (step, message) => {
        setStep(step, "failed", "");
        sessionError = message;
        busy = false;
        renderAll();
    };
    const errorText = (error) => (error instanceof ImportError ? messageFor(error.code) : error instanceof Error ? error.message : String(error));
    const applyProgress = (payload) => {
        const step = payload.step;
        if (!STEPS.includes(step))
            return;
        if (payload.projectId && current && payload.projectId !== current.project.id)
            return;
        let detail = "";
        if (typeof payload.current === "number" && typeof payload.total === "number")
            detail = `${payload.current}/${payload.total}`;
        if (Array.isArray(payload.installing) && payload.installing.length > 0) {
            detail = `${words("Installing", "導入中")}: ${payload.installing.join(", ")}`;
        }
        if (step === "build" && payload.status === "running" && !detail)
            detail = buildProgressText();
        if (payload.status === "failed" && step !== "env")
            return; // the result carries the message
        setStep(step, payload.status, detail || stepDetail.get(step) || "");
    };
    (_a = bridge()) === null || _a === void 0 ? void 0 : _a.onChange((payload) => {
        if (!payload || !payload.sessionId)
            return;
        if (!sessionId) {
            if (!collecting)
                return;
            if (!provisionalSessionId)
                provisionalSessionId = payload.sessionId;
            if (payload.sessionId !== provisionalSessionId)
                return;
            applyProgress(payload);
            return;
        }
        if (payload.sessionId !== sessionId)
            return;
        applyProgress(payload);
    });
    const envDetail = () => {
        var _a;
        if (!env)
            return "";
        if (!env.ready)
            return words("TeX not found", "TeX が見つかりません");
        const missing = (_a = current === null || current === void 0 ? void 0 : current.project.missingPackages) !== null && _a !== void 0 ? _a : [];
        if (missing.length === 0)
            return env.distribution;
        const prefix = env.autoInstall
            ? words("Installed during typesetting", "組版時に導入")
            : words("Missing", "未導入");
        return `${prefix}: ${missing.join(", ")}`;
    };
    const runBuild = async () => {
        var _a;
        if (!current || !sessionId || !(env === null || env === void 0 ? void 0 : env.ready))
            return;
        if (!current.mainFile) {
            current.error = messageFor("NO_MAIN");
            setStep("build", "failed", "");
            renderAll();
            return;
        }
        busy = true;
        sessionError = "";
        current.error = "";
        setStep("env", "done", envDetail());
        startBuildTimer();
        setStep("build", "running", buildProgressText());
        setStep("compare", "pending", "");
        renderAll();
        const target = current;
        const id = sessionId;
        try {
            const result = (await call("build", {
                sessionId: id,
                projectId: target.project.id,
                mainFile: target.mainFile,
                engine: target.engine,
                bibTool: target.bibTool,
            }));
            if (sessionId !== id)
                return;
            stopBuildTimer();
            if (result.canceled)
                return;
            target.result = result;
            if (result.prismPdf)
                target.project.analysis.prismPdf = result.prismPdf;
            if (current !== target)
                return;
            if (!result.build.ok) {
                setStep("build", result.build.kind === "cancelled" ? "pending" : "failed", "");
                setStep("compare", "pending", "");
            }
            else {
                setStep("build", "done", result.build.installed.length > 0 ? `${words("Installed", "導入")}: ${result.build.installed.join(", ")}` : (_a = result.build.pdfPath) !== null && _a !== void 0 ? _a : "");
                setStep("compare", result.diff ? "done" : "failed", "");
            }
        }
        catch (error) {
            stopBuildTimer();
            if (sessionId !== id)
                return;
            if (current === target) {
                const step = error instanceof ImportError && error.step ? error.step : "build";
                target.error = errorText(error);
                setStep(step, "failed", "");
            }
        }
        busy = false;
        renderAll();
        releaseDiffHeight();
    };
    const applyEnv = async () => {
        if (!env)
            return;
        if (!env.ready) {
            setStep("env", "failed", envDetail());
            // Hand over to the existing TeX setup gate; `resume` continues here.
            awaitingRuntime = true;
            busy = false;
            renderAll();
            modal === null || modal === void 0 ? void 0 : modal.close();
            deps.requestRuntimeSetup();
            return;
        }
        setStep("env", "done", envDetail());
        await runBuild();
    };
    const begin = async (zipPath) => {
        var _a, _b;
        if (sessionId)
            void call("end", { sessionId }).catch(() => { });
        sessionId = null;
        destination = "";
        env = null;
        states = [];
        current = null;
        awaitingRuntime = false;
        sessionError = "";
        provisionalSessionId = null;
        collecting = true;
        busy = true;
        show();
        resetSteps();
        setStep("extract", "running", "");
        try {
            const started = await call("start", { zipPath, locale: getUiLocale() });
            collecting = false;
            if (started.canceled) {
                busy = false;
                modal === null || modal === void 0 ? void 0 : modal.close();
                return;
            }
            sessionId = started.sessionId;
            destination = started.destination;
            provisionalSessionId = null;
            env = started.env;
            states = started.projects.map((project) => {
                var _a, _b;
                return ({
                    project,
                    mainFile: (_b = (_a = project.analysis.mainFile) !== null && _a !== void 0 ? _a : project.analysis.texFiles[0]) !== null && _b !== void 0 ? _b : "",
                    engine: project.analysis.engine,
                    bibTool: project.analysis.bibTool,
                    result: null,
                    error: "",
                });
            });
            current = (_a = states[0]) !== null && _a !== void 0 ? _a : null;
            fillSelect(projectSelect, states.map((state) => state.project.id), (id) => { var _a, _b; return (_b = (_a = states.find((state) => state.project.id === id)) === null || _a === void 0 ? void 0 : _a.project.name) !== null && _b !== void 0 ? _b : id; }, (_b = current === null || current === void 0 ? void 0 : current.project.id) !== null && _b !== void 0 ? _b : "");
            setStep("extract", "done", stepDetail.get("extract") || "");
            setStep("analyze", "done", `${states.length} ${words(states.length === 1 ? "project" : "projects", "プロジェクト")}`);
            renderAll();
            await applyEnv();
        }
        catch (error) {
            collecting = false;
            provisionalSessionId = null;
            const step = error instanceof ImportError && error.step
                ? error.step
                : stepStatus.get("extract") !== "done" ? "extract" : "analyze";
            if (step === "analyze")
                setStep("extract", "done", stepDetail.get("extract") || "");
            fail(step, errorText(error));
        }
    };
    const start = (zipPath) => {
        if (busy && (modal === null || modal === void 0 ? void 0 : modal.open))
            return;
        if (zipPath) {
            void begin(zipPath);
            return;
        }
        void (async () => {
            try {
                const chosen = await call("choose-zip", { locale: getUiLocale() });
                if (chosen.canceled || !chosen.zipPath)
                    return;
                await begin(chosen.zipPath);
            }
            catch (error) {
                show();
                fail("extract", errorText(error));
            }
        })();
    };
    const resume = () => {
        if (!awaitingRuntime || !sessionId)
            return;
        awaitingRuntime = false;
        busy = true;
        show();
        setStep("env", "running", "");
        void (async () => {
            try {
                const checked = await call("recheck-env", { sessionId });
                env = checked.env;
                const projects = checked.projects;
                for (const state of states) {
                    const fresh = projects.find((project) => project.id === state.project.id);
                    if (fresh)
                        state.project.missingPackages = fresh.missingPackages;
                }
                await applyEnv();
            }
            catch (error) {
                fail("env", errorText(error));
            }
        })();
    };
    const zipPathOf = (event) => {
        var _a;
        const files = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.files;
        if (!files || files.length === 0)
            return null;
        const api = bridge();
        if (!api)
            return null;
        for (const file of Array.from(files)) {
            if (!/\.zip$/i.test(file.name))
                continue;
            const filePath = api.pathForFile(file);
            if (filePath)
                return filePath;
        }
        return null;
    };
    const hasFiles = (event) => { var _a, _b; return Array.from((_b = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types) !== null && _b !== void 0 ? _b : []).includes("Files"); };
    const attachZipDrop = (element) => {
        if (!element)
            return;
        element.addEventListener("dragover", (event) => {
            if (!hasFiles(event))
                return;
            event.preventDefault();
            if (event.dataTransfer)
                event.dataTransfer.dropEffect = "copy";
            element.classList.add("is-zip-drop");
        });
        element.addEventListener("dragleave", () => element.classList.remove("is-zip-drop"));
        element.addEventListener("drop", (event) => {
            element.classList.remove("is-zip-drop");
            if (!hasFiles(event))
                return;
            const zipPath = zipPathOf(event);
            if (!zipPath)
                return;
            event.preventDefault();
            event.stopPropagation();
            start(zipPath);
        });
    };
    // A file dropped anywhere else must not navigate the window away.
    window.addEventListener("dragover", (event) => { if (hasFiles(event))
        event.preventDefault(); });
    window.addEventListener("drop", (event) => { if (hasFiles(event))
        event.preventDefault(); });
    return { start, resume, attachZipDrop };
};
