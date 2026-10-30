import { getUiLocale, uiText } from "./i18n.js";
const STEPS = ["extract", "analyze", "env", "build", "compare"];
const ENGINES = ["pdflatex", "lualatex", "xelatex", "uplatex"];
const BIB_TOOLS = ["biber", "bibtex", "none"];
const el = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text)
        node.textContent = text;
    return node;
};
const bridge = () => { var _a; return (_a = window.tex64Prism) !== null && _a !== void 0 ? _a : null; };
export const initPrismImportUi = (deps) => {
    var _a;
    const stepLabel = (step) => ({
        extract: uiText("Unpack", "展開"),
        analyze: uiText("Detect", "判定"),
        env: uiText("Environment", "環境"),
        build: uiText("Build", "組版"),
        compare: uiText("Compare", "比較"),
    })[step];
    const diffLabel = (key) => {
        var _a;
        return (_a = ({
            title: uiText("Title", "タイトル"),
            sections: uiText("Section order", "節見出しの順序"),
            equations: uiText("Equation numbers", "式番号"),
            citations: uiText("Citations", "引用"),
            pageCount: uiText("Pages", "ページ数"),
        })[key]) !== null && _a !== void 0 ? _a : key;
    };
    const bibLabel = (tool) => (tool === "none" ? uiText("None", "なし") : tool);
    let modal = null;
    let sessionId = null;
    let env = null;
    let states = [];
    let current = null;
    let busy = false;
    let awaitingRuntime = false;
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
    let errorBox;
    let openButton;
    let closeButton;
    const call = async (action, payload = {}) => {
        const api = bridge();
        if (!api)
            throw new Error(uiText("Prism import is not available.", "Prism の読み込みは使えません。"));
        const result = await api.call(action, payload);
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            throw new Error((result === null || result === void 0 ? void 0 : result.error) || uiText("Prism import failed.", "Prism の読み込みに失敗しました。"));
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
        const texFiles = analysis.texFiles.length > 0 ? analysis.texFiles : current.mainFile ? [current.mainFile] : [];
        const ordered = [...analysis.candidates, ...texFiles.filter((file) => !analysis.candidates.includes(file))];
        fillSelect(mainSelect, ordered, (value) => value, current.mainFile);
        fillSelect(engineSelect, ENGINES, (value) => value, current.engine);
        fillSelect(bibSelect, BIB_TOOLS, bibLabel, current.bibTool);
        const disabled = busy;
        mainSelect.disabled = disabled || ordered.length === 0;
        engineSelect.disabled = disabled;
        bibSelect.disabled = disabled;
        projectSelect.disabled = disabled;
    };
    const renderDiff = () => {
        var _a, _b;
        diffBox.replaceChildren();
        if (!current || !current.result)
            return;
        const { build, diff, compareError, prismPdf } = current.result;
        if (!build.ok) {
            diffBox.append(el("p", "history-error", `${build.summary}\n${build.logTail}`.trim()));
            return;
        }
        if (!diff) {
            if (compareError === "no-prism-pdf") {
                diffBox.append(el("p", "", uiText("The project holds no PDF from Prism to compare with.", "比較できる Prism の PDF がプロジェクトにありません。")));
            }
            else {
                diffBox.append(el("p", "", uiText("The PDFs could not be compared.", "PDF を比較できませんでした。")));
            }
            return;
        }
        const changed = diff.filter((row) => !row.same);
        const list = el("ul", "prism-diff-list");
        if (changed.length === 0) {
            list.append(el("li", "prism-diff-same", uiText("Matches Prism's PDF", "一致")));
        }
        else {
            const same = diff.filter((row) => row.same);
            for (const row of changed) {
                const item = el("li", "prism-diff-row");
                item.append(el("span", "prism-diff-key", diffLabel(row.key)));
                let text = `Prism: ${row.prism || "—"} / TeX64: ${row.local || "—"}`;
                if (row.note) {
                    try {
                        const note = JSON.parse(row.note);
                        text += `  ${uiText("first difference", "最初の相違")} #${note.index + 1}: ${(_a = note.prism) !== null && _a !== void 0 ? _a : "—"} → ${(_b = note.local) !== null && _b !== void 0 ? _b : "—"}`;
                    }
                    catch { /* note stays out */ }
                }
                item.append(el("span", "prism-diff-value", text));
                list.append(item);
            }
            if (same.length > 0) {
                list.append(el("li", "prism-diff-same", `${uiText("Matches", "一致")}: ${same.map((row) => diffLabel(row.key)).join("、")}`));
            }
        }
        diffBox.append(list);
        if (prismPdf)
            diffBox.append(el("p", "history-date", `${uiText("Prism PDF", "Prism の PDF")}: ${prismPdf}`));
    };
    const renderAll = () => {
        var _a;
        renderSteps();
        renderFields();
        renderDiff();
        errorBox.textContent = (_a = current === null || current === void 0 ? void 0 : current.error) !== null && _a !== void 0 ? _a : "";
        openButton.disabled = busy || !current;
        projectRow.hidden = states.length <= 1;
    };
    const ensureDialog = () => {
        if (modal)
            return modal;
        modal = el("dialog", "history-confirm prism-import");
        const heading = el("h2", "", uiText("Import from Prism", "Prism から読み込む"));
        heading.id = "prism-import-title";
        modal.setAttribute("aria-labelledby", heading.id);
        stepsList = el("ol", "prism-steps");
        projectRow = el("label", "prism-field");
        projectRow.append(el("span", "", uiText("Project", "プロジェクト")));
        projectSelect = el("select", "history-name");
        projectRow.append(projectSelect);
        projectRow.hidden = true;
        projectSelect.addEventListener("change", () => {
            const next = states.find((state) => state.project.id === projectSelect.value);
            if (!next || next === current)
                return;
            current = next;
            renderAll();
            if (!current.result && !busy)
                void runBuild();
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
        mainSelect = field(uiText("Main file", "メインファイル"));
        engineSelect = field(uiText("Engine", "エンジン"));
        bibSelect = field(uiText("Bibliography", "文献ツール"));
        for (const select of [mainSelect, engineSelect, bibSelect]) {
            select.addEventListener("change", () => {
                if (!current || busy)
                    return;
                current.mainFile = mainSelect.value;
                current.engine = engineSelect.value;
                current.bibTool = bibSelect.value;
                current.result = null;
                void runBuild();
            });
        }
        diffBox = el("div", "prism-diff");
        errorBox = el("p", "history-error");
        const actions = el("div", "history-confirm-actions");
        openButton = el("button", "history-button is-primary", uiText("Open this project", "このプロジェクトを開く"));
        openButton.type = "button";
        openButton.addEventListener("click", () => {
            if (!current)
                return;
            const root = current.project.root;
            deps.setCompileEngine(current.engine);
            finish();
            deps.openProjectPath(root);
        });
        closeButton = el("button", "history-button", uiText("Close", "閉じる"));
        closeButton.type = "button";
        closeButton.addEventListener("click", () => finish());
        actions.append(openButton, closeButton);
        modal.append(heading, stepsList, projectRow, fields, diffBox, errorBox, actions);
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
    const finish = () => {
        if (sessionId && !awaitingRuntime)
            void call("end", { sessionId }).catch(() => { });
        modal === null || modal === void 0 ? void 0 : modal.close();
    };
    const fail = (step, message) => {
        setStep(step, "failed", "");
        if (current)
            current.error = message;
        errorBox.textContent = message;
        busy = false;
        renderAll();
    };
    (_a = bridge()) === null || _a === void 0 ? void 0 : _a.onChange((payload) => {
        if (!payload || payload.sessionId !== sessionId)
            return;
        const step = payload.step;
        if (!STEPS.includes(step))
            return;
        if (payload.projectId && current && payload.projectId !== current.project.id)
            return;
        let detail = "";
        if (typeof payload.current === "number" && typeof payload.total === "number")
            detail = `${payload.current}/${payload.total}`;
        if (Array.isArray(payload.installing) && payload.installing.length > 0) {
            detail = `${uiText("Installing", "導入中")}: ${payload.installing.join(", ")}`;
        }
        if (payload.status === "failed" && step !== "env")
            return; // the result carries the message
        setStep(step, payload.status, detail || stepDetail.get(step) || "");
    });
    const envDetail = () => {
        var _a;
        if (!env)
            return "";
        if (!env.ready)
            return uiText("TeX not found", "TeX が見つかりません");
        const missing = (_a = current === null || current === void 0 ? void 0 : current.project.missingPackages) !== null && _a !== void 0 ? _a : [];
        if (missing.length === 0)
            return env.distribution;
        const prefix = env.autoInstall
            ? uiText("Installed during build", "組版時に導入")
            : uiText("Missing", "未導入");
        return `${prefix}: ${missing.join(", ")}`;
    };
    const runBuild = async () => {
        var _a;
        if (!current || !sessionId || !(env === null || env === void 0 ? void 0 : env.ready))
            return;
        if (!current.mainFile) {
            fail("build", uiText("No file with \\documentclass and \\begin{document} was found.", "\\documentclass と \\begin{document} を含むファイルがありません。"));
            return;
        }
        busy = true;
        current.error = "";
        setStep("env", "done", envDetail());
        setStep("build", "running", "");
        setStep("compare", "pending", "");
        renderAll();
        const target = current;
        try {
            const result = (await call("build", {
                sessionId,
                projectId: target.project.id,
                mainFile: target.mainFile,
                engine: target.engine,
                bibTool: target.bibTool,
            }));
            target.result = result;
            if (result.prismPdf)
                target.project.analysis.prismPdf = result.prismPdf;
            if (current !== target)
                return;
            if (!result.build.ok) {
                setStep("build", "failed", "");
                setStep("compare", "pending", "");
            }
            else {
                setStep("build", "done", result.build.installed.length > 0 ? `${uiText("Installed", "導入")}: ${result.build.installed.join(", ")}` : (_a = result.build.pdfPath) !== null && _a !== void 0 ? _a : "");
                setStep("compare", result.diff ? "done" : "failed", "");
            }
        }
        catch (error) {
            if (current === target)
                fail("build", error instanceof Error ? error.message : String(error));
            return;
        }
        busy = false;
        renderAll();
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
        sessionId = null;
        env = null;
        states = [];
        current = null;
        awaitingRuntime = false;
        busy = true;
        show();
        resetSteps();
        errorBox.textContent = "";
        try {
            const started = await call("start", { zipPath, locale: getUiLocale() });
            if (started.canceled) {
                busy = false;
                modal === null || modal === void 0 ? void 0 : modal.close();
                return;
            }
            sessionId = started.sessionId;
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
            setStep("analyze", "done", `${states.length}`);
            renderAll();
            await applyEnv();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failedStep = stepStatus.get("extract") !== "done" ? "extract" : stepStatus.get("analyze") !== "done" ? "analyze" : "env";
            fail(failedStep, message);
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
                fail("extract", error instanceof Error ? error.message : String(error));
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
                fail("env", error instanceof Error ? error.message : String(error));
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
