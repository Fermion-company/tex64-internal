import { getUiLocale, uiText } from "./i18n.js";

// Import a Prism "Export all projects" zip. One dialog walks the five steps
// (unpack → detect → environment → build → compare); the detected main file,
// engine and bibliography tool are selects the user may change, and each
// change rebuilds. "Open this project" hands the folder to the workspace.

type Step = "extract" | "analyze" | "env" | "build" | "compare";
type StepStatus = "pending" | "running" | "done" | "failed";

type Analysis = {
  mainFile: string | null;
  candidates: string[];
  texFiles: string[];
  engine: string;
  bibTool: string;
  packages: string[];
  prismPdf: string | null;
  conversations: string[];
};

type Project = {
  id: string;
  name: string;
  root: string;
  analysis: Analysis;
  notes: string[];
  missingPackages: string[];
};

type Env = { ready: boolean; hasEngine: boolean; distribution: string; autoInstall: boolean };

type DiffRow = { key: string; same: boolean; prism: string; local: string; note: string };

type BuildResult = {
  build: { ok: boolean; summary: string; logTail: string; pdfPath: string | null; installed: string[] };
  diff: DiffRow[] | null;
  compareError?: string | null;
  prismPdf?: string | null;
};

type ProjectState = {
  project: Project;
  mainFile: string;
  engine: string;
  bibTool: string;
  result: BuildResult | null;
  error: string;
};

type Bridge = {
  call: (action: string, payload?: Record<string, unknown>) => Promise<any>;
  pathForFile: (file: File) => string;
  onChange: (handler: (payload: any) => void) => () => void;
};

export type PrismImportUiApi = {
  start: (zipPath?: string) => void;
  resume: () => void;
  attachZipDrop: (element: HTMLElement | null) => void;
};

type Deps = {
  openProjectPath: (path: string) => void;
  setCompileEngine: (engine: string) => void;
  requestRuntimeSetup: () => void;
};

const STEPS: Step[] = ["extract", "analyze", "env", "build", "compare"];
const ENGINES = ["pdflatex", "lualatex", "xelatex", "uplatex"];
const BIB_TOOLS = ["biber", "bibtex", "none"];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const bridge = (): Bridge | null => (window as unknown as { tex64Prism?: Bridge }).tex64Prism ?? null;

export const initPrismImportUi = (deps: Deps): PrismImportUiApi => {
  const stepLabel = (step: Step) => ({
    extract: uiText("Unpack", "展開"),
    analyze: uiText("Detect", "判定"),
    env: uiText("Environment", "環境"),
    build: uiText("Build", "組版"),
    compare: uiText("Compare", "比較"),
  })[step];
  const diffLabel = (key: string) => ({
    title: uiText("Title", "タイトル"),
    sections: uiText("Section order", "節見出しの順序"),
    equations: uiText("Equation numbers", "式番号"),
    citations: uiText("Citations", "引用"),
    pageCount: uiText("Pages", "ページ数"),
  })[key] ?? key;
  const bibLabel = (tool: string) => (tool === "none" ? uiText("None", "なし") : tool);

  let modal: HTMLDialogElement | null = null;
  let sessionId: string | null = null;
  let env: Env | null = null;
  let states: ProjectState[] = [];
  let current: ProjectState | null = null;
  let busy = false;
  let awaitingRuntime = false;
  const stepStatus = new Map<Step, StepStatus>();
  const stepDetail = new Map<Step, string>();

  // DOM
  let stepsList: HTMLOListElement;
  let projectRow: HTMLLabelElement;
  let projectSelect: HTMLSelectElement;
  let mainSelect: HTMLSelectElement;
  let engineSelect: HTMLSelectElement;
  let bibSelect: HTMLSelectElement;
  let fields: HTMLDivElement;
  let diffBox: HTMLDivElement;
  let errorBox: HTMLParagraphElement;
  let openButton: HTMLButtonElement;
  let closeButton: HTMLButtonElement;

  const call = async (action: string, payload: Record<string, unknown> = {}) => {
    const api = bridge();
    if (!api) throw new Error(uiText("Prism import is not available.", "Prism の読み込みは使えません。"));
    const result = await api.call(action, payload);
    if (!result?.ok) throw new Error(result?.error || uiText("Prism import failed.", "Prism の読み込みに失敗しました。"));
    return result;
  };

  const setStep = (step: Step, status: StepStatus, detail = "") => {
    stepStatus.set(step, status);
    stepDetail.set(step, detail);
    renderSteps();
  };

  const resetSteps = () => {
    STEPS.forEach((step) => { stepStatus.set(step, "pending"); stepDetail.set(step, ""); });
    renderSteps();
  };

  const renderSteps = () => {
    if (!stepsList) return;
    stepsList.replaceChildren();
    for (const step of STEPS) {
      const status = stepStatus.get(step) ?? "pending";
      const item = el("li", `prism-step is-${status}`);
      const mark = el("span", "prism-step-mark", status === "done" ? "✓" : status === "failed" ? "×" : status === "running" ? "…" : "·");
      const name = el("span", "prism-step-name", stepLabel(step));
      item.append(mark, name);
      const detail = stepDetail.get(step);
      if (detail) item.append(el("span", "history-date", detail));
      stepsList.append(item);
    }
  };

  const fillSelect = (select: HTMLSelectElement, values: string[], labels: (value: string) => string, selected: string) => {
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
    if (!current) { fields.hidden = true; return; }
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
    diffBox.replaceChildren();
    if (!current || !current.result) return;
    const { build, diff, compareError, prismPdf } = current.result;
    if (!build.ok) {
      diffBox.append(el("p", "history-error", `${build.summary}\n${build.logTail}`.trim()));
      return;
    }
    if (!diff) {
      if (compareError === "no-prism-pdf") {
        diffBox.append(el("p", "", uiText("The project holds no PDF from Prism to compare with.", "比較できる Prism の PDF がプロジェクトにありません。")));
      } else {
        diffBox.append(el("p", "", uiText("The PDFs could not be compared.", "PDF を比較できませんでした。")));
      }
      return;
    }
    const changed = diff.filter((row) => !row.same);
    const list = el("ul", "prism-diff-list");
    if (changed.length === 0) {
      list.append(el("li", "prism-diff-same", uiText("Matches Prism's PDF", "一致")));
    } else {
      const same = diff.filter((row) => row.same);
      for (const row of changed) {
        const item = el("li", "prism-diff-row");
        item.append(el("span", "prism-diff-key", diffLabel(row.key)));
        let text = `Prism: ${row.prism || "—"} / TeX64: ${row.local || "—"}`;
        if (row.note) {
          try {
            const note = JSON.parse(row.note) as { index: number; prism: string | null; local: string | null };
            text += `  ${uiText("first difference", "最初の相違")} #${note.index + 1}: ${note.prism ?? "—"} → ${note.local ?? "—"}`;
          } catch { /* note stays out */ }
        }
        item.append(el("span", "prism-diff-value", text));
        list.append(item);
      }
      if (same.length > 0) {
        list.append(el("li", "prism-diff-same", `${uiText("Matches", "一致")}: ${same.map((row) => diffLabel(row.key)).join("、")}`));
      }
    }
    diffBox.append(list);
    if (prismPdf) diffBox.append(el("p", "history-date", `${uiText("Prism PDF", "Prism の PDF")}: ${prismPdf}`));
  };

  const renderAll = () => {
    renderSteps();
    renderFields();
    renderDiff();
    errorBox.textContent = current?.error ?? "";
    openButton.disabled = busy || !current;
    projectRow.hidden = states.length <= 1;
  };

  const ensureDialog = () => {
    if (modal) return modal;
    modal = el("dialog", "history-confirm prism-import") as HTMLDialogElement;
    const heading = el("h2", "", uiText("Import from Prism", "Prism から読み込む"));
    heading.id = "prism-import-title";
    modal.setAttribute("aria-labelledby", heading.id);
    stepsList = el("ol", "prism-steps") as HTMLOListElement;

    projectRow = el("label", "prism-field") as HTMLLabelElement;
    projectRow.append(el("span", "", uiText("Project", "プロジェクト")));
    projectSelect = el("select", "history-name") as HTMLSelectElement;
    projectRow.append(projectSelect);
    projectRow.hidden = true;
    projectSelect.addEventListener("change", () => {
      const next = states.find((state) => state.project.id === projectSelect.value);
      if (!next || next === current) return;
      current = next;
      renderAll();
      if (!current.result && !busy) void runBuild();
    });

    fields = el("div", "prism-fields") as HTMLDivElement;
    const field = (label: string) => {
      const row = el("label", "prism-field");
      row.append(el("span", "", label));
      const select = el("select", "history-name") as HTMLSelectElement;
      row.append(select);
      fields.append(row);
      return select;
    };
    mainSelect = field(uiText("Main file", "メインファイル"));
    engineSelect = field(uiText("Engine", "エンジン"));
    bibSelect = field(uiText("Bibliography", "文献ツール"));
    for (const select of [mainSelect, engineSelect, bibSelect]) {
      select.addEventListener("change", () => {
        if (!current || busy) return;
        current.mainFile = mainSelect.value;
        current.engine = engineSelect.value;
        current.bibTool = bibSelect.value;
        current.result = null;
        void runBuild();
      });
    }

    diffBox = el("div", "prism-diff") as HTMLDivElement;
    errorBox = el("p", "history-error") as HTMLParagraphElement;

    const actions = el("div", "history-confirm-actions");
    openButton = el("button", "history-button is-primary", uiText("Open this project", "このプロジェクトを開く")) as HTMLButtonElement;
    openButton.type = "button";
    openButton.addEventListener("click", () => {
      if (!current) return;
      const root = current.project.root;
      deps.setCompileEngine(current.engine);
      finish();
      deps.openProjectPath(root);
    });
    closeButton = el("button", "history-button", uiText("Close", "閉じる")) as HTMLButtonElement;
    closeButton.type = "button";
    closeButton.addEventListener("click", () => finish());
    actions.append(openButton, closeButton);

    modal.append(heading, stepsList, projectRow, fields, diffBox, errorBox, actions);
    modal.addEventListener("cancel", (event) => { event.preventDefault(); finish(); });
    modal.addEventListener("close", () => { modal?.remove(); modal = null; });
    document.body.append(modal);
    return modal;
  };

  const show = () => {
    const dialog = ensureDialog();
    if (!dialog.open) dialog.showModal();
    renderAll();
  };

  const finish = () => {
    if (sessionId && !awaitingRuntime) void call("end", { sessionId }).catch(() => {});
    modal?.close();
  };

  const fail = (step: Step, message: string) => {
    setStep(step, "failed", "");
    if (current) current.error = message;
    errorBox.textContent = message;
    busy = false;
    renderAll();
  };

  bridge()?.onChange((payload) => {
    if (!payload || payload.sessionId !== sessionId) return;
    const step = payload.step as Step;
    if (!STEPS.includes(step)) return;
    if (payload.projectId && current && payload.projectId !== current.project.id) return;
    let detail = "";
    if (typeof payload.current === "number" && typeof payload.total === "number") detail = `${payload.current}/${payload.total}`;
    if (Array.isArray(payload.installing) && payload.installing.length > 0) {
      detail = `${uiText("Installing", "導入中")}: ${payload.installing.join(", ")}`;
    }
    if (payload.status === "failed" && step !== "env") return; // the result carries the message
    setStep(step, payload.status as StepStatus, detail || stepDetail.get(step) || "");
  });

  const envDetail = (): string => {
    if (!env) return "";
    if (!env.ready) return uiText("TeX not found", "TeX が見つかりません");
    const missing = current?.project.missingPackages ?? [];
    if (missing.length === 0) return env.distribution;
    const prefix = env.autoInstall
      ? uiText("Installed during build", "組版時に導入")
      : uiText("Missing", "未導入");
    return `${prefix}: ${missing.join(", ")}`;
  };

  const runBuild = async () => {
    if (!current || !sessionId || !env?.ready) return;
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
      })) as BuildResult;
      target.result = result;
      if (result.prismPdf) target.project.analysis.prismPdf = result.prismPdf;
      if (current !== target) return;
      if (!result.build.ok) {
        setStep("build", "failed", "");
        setStep("compare", "pending", "");
      } else {
        setStep("build", "done", result.build.installed.length > 0 ? `${uiText("Installed", "導入")}: ${result.build.installed.join(", ")}` : result.build.pdfPath ?? "");
        setStep("compare", result.diff ? "done" : "failed", "");
      }
    } catch (error) {
      if (current === target) fail("build", error instanceof Error ? error.message : String(error));
      return;
    }
    busy = false;
    renderAll();
  };

  const applyEnv = async () => {
    if (!env) return;
    if (!env.ready) {
      setStep("env", "failed", envDetail());
      // Hand over to the existing TeX setup gate; `resume` continues here.
      awaitingRuntime = true;
      busy = false;
      renderAll();
      modal?.close();
      deps.requestRuntimeSetup();
      return;
    }
    setStep("env", "done", envDetail());
    await runBuild();
  };

  const begin = async (zipPath: string) => {
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
      if (started.canceled) { busy = false; modal?.close(); return; }
      sessionId = started.sessionId as string;
      env = started.env as Env;
      states = (started.projects as Project[]).map((project) => ({
        project,
        mainFile: project.analysis.mainFile ?? project.analysis.texFiles[0] ?? "",
        engine: project.analysis.engine,
        bibTool: project.analysis.bibTool,
        result: null,
        error: "",
      }));
      current = states[0] ?? null;
      fillSelect(projectSelect, states.map((state) => state.project.id), (id) => states.find((state) => state.project.id === id)?.project.name ?? id, current?.project.id ?? "");
      setStep("extract", "done", stepDetail.get("extract") || "");
      setStep("analyze", "done", `${states.length}`);
      renderAll();
      await applyEnv();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedStep = stepStatus.get("extract") !== "done" ? "extract" : stepStatus.get("analyze") !== "done" ? "analyze" : "env";
      fail(failedStep, message);
    }
  };

  const start = (zipPath?: string) => {
    if (busy && modal?.open) return;
    if (zipPath) { void begin(zipPath); return; }
    void (async () => {
      try {
        const chosen = await call("choose-zip", { locale: getUiLocale() });
        if (chosen.canceled || !chosen.zipPath) return;
        await begin(chosen.zipPath as string);
      } catch (error) {
        show();
        fail("extract", error instanceof Error ? error.message : String(error));
      }
    })();
  };

  const resume = () => {
    if (!awaitingRuntime || !sessionId) return;
    awaitingRuntime = false;
    busy = true;
    show();
    setStep("env", "running", "");
    void (async () => {
      try {
        const checked = await call("recheck-env", { sessionId });
        env = checked.env as Env;
        const projects = checked.projects as Project[];
        for (const state of states) {
          const fresh = projects.find((project) => project.id === state.project.id);
          if (fresh) state.project.missingPackages = fresh.missingPackages;
        }
        await applyEnv();
      } catch (error) {
        fail("env", error instanceof Error ? error.message : String(error));
      }
    })();
  };

  const zipPathOf = (event: DragEvent): string | null => {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return null;
    const api = bridge();
    if (!api) return null;
    for (const file of Array.from(files)) {
      if (!/\.zip$/i.test(file.name)) continue;
      const filePath = api.pathForFile(file);
      if (filePath) return filePath;
    }
    return null;
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const attachZipDrop = (element: HTMLElement | null) => {
    if (!element) return;
    element.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      element.classList.add("is-zip-drop");
    });
    element.addEventListener("dragleave", () => element.classList.remove("is-zip-drop"));
    element.addEventListener("drop", (event) => {
      element.classList.remove("is-zip-drop");
      if (!hasFiles(event)) return;
      const zipPath = zipPathOf(event);
      if (!zipPath) return;
      event.preventDefault();
      event.stopPropagation();
      start(zipPath);
    });
  };

  // A file dropped anywhere else must not navigate the window away.
  window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener("drop", (event) => { if (hasFiles(event)) event.preventDefault(); });

  return { start, resume, attachZipDrop };
};
