import { getUiLocale, uiText } from "./i18n.js";

// Import a Prism "Export all projects" zip. One dialog walks the five steps
// (unpack → detect → environment → typeset → compare); the detected main file,
// engine and bibliography tool are selects the user may change, and each
// change rebuilds. "Open this project" hands the folder to the workspace.
// The engine lives in the project's own build profile, not in the app-wide
// engine setting.

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

type DiffRow = {
  key: string;
  same: boolean;
  prism: string | number;
  local: string | number;
  first?: { index: number; prism: string | null; local: string | null };
};

type Issue = { severity: string; message: string; path: string | null; line: number | null };

type BuildResult = {
  canceled?: boolean;
  build: { ok: boolean; kind: string; issues: Issue[]; issueCount: number; pdfPath: string | null; installed: string[] };
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

type Progress = {
  sessionId?: string;
  step?: Step;
  status?: StepStatus;
  projectId?: string;
  current?: number;
  total?: number;
  installing?: string[];
};

type Bridge = {
  call: (action: string, payload?: Record<string, unknown>) => Promise<any>;
  pathForFile: (file: File) => string;
  onChange: (handler: (payload: Progress) => void) => () => void;
};

export type PrismImportUiApi = {
  start: (zipPath?: string) => void;
  resume: () => void;
  attachZipDrop: (element: HTMLElement | null) => void;
};

type Deps = {
  openProjectPath: (path: string) => void;
  getWorkspaceRoot: () => string | null;
  showIssues: (summary: string, issues: Issue[]) => void;
  requestRuntimeSetup: () => void;
};

const STEPS: Step[] = ["extract", "analyze", "env", "build", "compare"];
const ENGINES = ["pdflatex", "lualatex", "xelatex", "uplatex"];
const BIB_TOOLS = ["biber", "bibtex", "none"];

class ImportError extends Error {
  code: string;
  step: Step | null;
  constructor(code: string, step: Step | null = null) {
    super(code);
    this.code = code;
    this.step = step;
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

// The shared dictionary rewrites fragments of English sentences ("was not
// found" → "が見つかりません") and would leave half-translated lines; in
// Japanese the Japanese wording given here wins.
const words = (english: string, japanese: string) => (getUiLocale() === "ja" ? japanese : uiText(english, japanese));

const bridge = (): Bridge | null => (window as unknown as { tex64Prism?: Bridge }).tex64Prism ?? null;

export const initPrismImportUi = (deps: Deps): PrismImportUiApi => {
  const stepLabel = (step: Step) => ({
    extract: words("Unpack", "展開"),
    analyze: words("Detect", "判定"),
    env: words("Environment", "環境"),
    build: words("Build", "ビルド"),
    compare: words("Compare", "比較"),
  })[step];
  const diffLabel = (key: string) => ({
    title: words("Title", "タイトル"),
    sections: words("Section headings", "節見出し"),
    equations: words("Equation numbers", "式番号"),
    citations: words("Citations", "引用"),
    pageCount: words("Pages", "ページ数"),
  })[key] ?? key;
  const bibLabel = (tool: string) => (tool === "none" ? words("None", "なし") : tool);
  const messageFor = (code: string): string => ({
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
  })[code] ?? words("Prism import failed.", "Prism の読み込みに失敗しました。") + ` (${code})`;

  let modal: HTMLDialogElement | null = null;
  let sessionId: string | null = null;
  let destination = "";
  let env: Env | null = null;
  let states: ProjectState[] = [];
  let current: ProjectState | null = null;
  let busy = false;
  let awaitingRuntime = false;
  let sessionError = "";
  // Progress arrives before `start` has returned the session id. Only one
  // import runs at a time, so the first id seen while starting is adopted
  // provisionally and the steps move while the zip is still unpacking.
  let provisionalSessionId: string | null = null;
  let collecting = false;
  let buildStartedAt = 0;
  let buildTimer: number | null = null;
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
  let pathsBox: HTMLDivElement;
  let errorBox: HTMLParagraphElement;
  let openButton: HTMLButtonElement;
  let closeButton: HTMLButtonElement;

  const call = async (action: string, payload: Record<string, unknown> = {}) => {
    const api = bridge();
    if (!api) throw new ImportError("UNAVAILABLE");
    const result = await api.call(action, payload);
    if (!result?.ok) throw new ImportError(result?.code || "FAILED", (result?.step as Step | null) ?? null);
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
    const ordered = [...analysis.candidates, ...analysis.texFiles.filter((file) => !analysis.candidates.includes(file))];
    fillSelect(mainSelect, ordered, (value) => value, current.mainFile);
    fillSelect(engineSelect, ENGINES, (value) => value, current.engine);
    fillSelect(bibSelect, BIB_TOOLS, bibLabel, current.bibTool);
    mainSelect.disabled = busy || ordered.length === 0;
    engineSelect.disabled = busy;
    bibSelect.disabled = busy;
    projectSelect.disabled = busy;
  };

  const countText = (value: string | number) => `${value} ${words("", "件")}`.trim();
  const ordinal = (index: number) => (getUiLocale() === "ja" ? `${index + 1} 番目` : `#${index + 1}`);
  const joiner = () => words(", ", "、");

  const renderIssues = (result: BuildResult) => {
    const box = el("div", "prism-issues");
    const issues = result.build.issues;
    if (issues.length === 0) {
      box.append(el("p", "history-error", words("Typesetting failed.", "組版に失敗しました。")));
    }
    for (const issue of issues) {
      const where = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ""}  ` : "";
      box.append(el("p", "history-error", `${where}${issue.message}`));
    }
    const more = el("button", "history-button", words("Show details", "詳細を見る")) as HTMLButtonElement;
    more.type = "button";
    // The Issues panel belongs to the open workspace: open this project first
    // when it is not the one open, then hand the issues over.
    more.addEventListener("click", () => {
      if (!current || !sessionId) return;
      const project = current.project;
      void (async () => {
        let payload: { summary: string; issues: Issue[] };
        try {
          payload = (await call("show-issues", { sessionId, projectId: project.id })) as { summary: string; issues: Issue[] };
        } catch {
          return;
        }
        finish();
        if (deps.getWorkspaceRoot() !== project.root) {
          deps.openProjectPath(project.root);
          const until = Date.now() + 15000;
          while (Date.now() < until && deps.getWorkspaceRoot() !== project.root) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (deps.getWorkspaceRoot() !== project.root) return;
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
    diffBox.replaceChildren();
    diffBox.classList.toggle("is-stale", busy);
    if (!current || !current.result) return;
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
    } else {
      for (const row of changed) {
        const item = el("li", "prism-diff-row");
        item.append(el("span", "prism-diff-key", diffLabel(row.key)));
        let text: string;
        if (row.key === "title") {
          text = `Prism “${row.prism || "—"}” → TeX64 “${row.local || "—"}”`;
        } else if (row.key === "pageCount") {
          text = `Prism ${countText(row.prism)} → TeX64 ${countText(row.local)}`;
        } else {
          text = `Prism ${countText(row.prism)} → TeX64 ${countText(row.local)}`;
          if (row.first) {
            const detail = row.first.prism == null
              ? words(`${ordinal(row.first.index)} added: ${row.first.local ?? ""}`, `${ordinal(row.first.index)}が増加: ${row.first.local ?? ""}`)
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
    if (!destination) return;
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
    errorBox.textContent = sessionError || current?.error || "";
    openButton.hidden = !current;
    openButton.disabled = busy || !current;
    projectRow.hidden = states.length <= 1;
  };

  // Keep the result area from collapsing while the next build runs.
  const holdDiffHeight = () => {
    if (diffBox && diffBox.offsetHeight > 0) diffBox.style.minHeight = `${diffBox.offsetHeight}px`;
  };
  const releaseDiffHeight = () => { if (diffBox) diffBox.style.minHeight = ""; };

  const buildProgressText = () => {
    const seconds = buildStartedAt > 0 ? Math.max(0, Math.floor((Date.now() - buildStartedAt) / 1000)) : 0;
    const phase = words("Building…", "ビルド中…");
    return seconds > 0 ? `${phase} ${seconds}s` : phase;
  };
  const startBuildTimer = () => {
    buildStartedAt = Date.now();
    if (buildTimer === null) buildTimer = window.setInterval(() => {
      if (stepStatus.get("build") === "running") setStep("build", "running", buildProgressText());
    }, 1000);
  };
  const stopBuildTimer = () => {
    if (buildTimer !== null) window.clearInterval(buildTimer);
    buildTimer = null;
    buildStartedAt = 0;
  };

  const ensureDialog = () => {
    if (modal) return modal;
    modal = el("dialog", "history-confirm prism-import") as HTMLDialogElement;
    const heading = el("h2", "", words("Import from Prism", "Prism から読み込む"));
    heading.id = "prism-import-title";
    modal.setAttribute("aria-labelledby", heading.id);
    stepsList = el("ol", "prism-steps") as HTMLOListElement;

    projectRow = el("label", "prism-field") as HTMLLabelElement;
    projectRow.append(el("span", "", words("Project", "プロジェクト")));
    projectSelect = el("select", "history-name") as HTMLSelectElement;
    projectRow.append(projectSelect);
    projectRow.hidden = true;
    projectSelect.addEventListener("change", () => {
      const next = states.find((state) => state.project.id === projectSelect.value);
      if (!next || next === current) return;
      holdDiffHeight();
      current = next;
      renderAll();
      if (!current.result && !busy) void runBuild();
      else releaseDiffHeight();
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
    mainSelect = field(words("Main file", "メインファイル"));
    engineSelect = field(words("Engine", "エンジン"));
    bibSelect = field(words("Bibliography", "文献ツール"));
    for (const select of [mainSelect, engineSelect, bibSelect]) {
      select.addEventListener("change", () => {
        if (!current || busy) return;
        holdDiffHeight();
        current.mainFile = mainSelect.value;
        current.engine = engineSelect.value;
        current.bibTool = bibSelect.value;
        void runBuild();
      });
    }

    diffBox = el("div", "prism-diff") as HTMLDivElement;
    pathsBox = el("div", "prism-paths") as HTMLDivElement;
    errorBox = el("p", "history-error") as HTMLParagraphElement;

    const actions = el("div", "history-confirm-actions");
    openButton = el("button", "history-button is-primary", words("Open this project", "このプロジェクトを開く")) as HTMLButtonElement;
    openButton.type = "button";
    openButton.addEventListener("click", () => {
      if (!current) return;
      const root = current.project.root;
      finish();
      deps.openProjectPath(root);
    });
    closeButton = el("button", "history-button", words("Close", "閉じる")) as HTMLButtonElement;
    closeButton.type = "button";
    closeButton.addEventListener("click", () => finish());
    actions.append(openButton, closeButton);

    modal.append(heading, stepsList, projectRow, fields, diffBox, pathsBox, errorBox, actions);
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

  // Closing ends the session; a typeset still running is cancelled with it.
  const finish = () => {
    stopBuildTimer();
    if (sessionId && !awaitingRuntime) {
      const id = sessionId;
      void call("end", { sessionId: id }).catch(() => {});
      sessionId = null;
      busy = false;
    }
    modal?.close();
  };

  const fail = (step: Step, message: string) => {
    setStep(step, "failed", "");
    sessionError = message;
    busy = false;
    renderAll();
  };

  const errorText = (error: unknown) => (error instanceof ImportError ? messageFor(error.code) : error instanceof Error ? error.message : String(error));

  const applyProgress = (payload: Progress) => {
    const step = payload.step as Step;
    if (!STEPS.includes(step)) return;
    if (payload.projectId && current && payload.projectId !== current.project.id) return;
    let detail = "";
    if (typeof payload.current === "number" && typeof payload.total === "number") detail = `${payload.current}/${payload.total}`;
    if (Array.isArray(payload.installing) && payload.installing.length > 0) {
      detail = `${words("Installing", "導入中")}: ${payload.installing.join(", ")}`;
    }
    if (step === "build" && payload.status === "running" && !detail) detail = buildProgressText();
    if (payload.status === "failed" && step !== "env") return; // the result carries the message
    setStep(step, payload.status as StepStatus, detail || stepDetail.get(step) || "");
  };

  bridge()?.onChange((payload) => {
    if (!payload || !payload.sessionId) return;
    if (!sessionId) {
      if (!collecting) return;
      if (!provisionalSessionId) provisionalSessionId = payload.sessionId;
      if (payload.sessionId !== provisionalSessionId) return;
      applyProgress(payload);
      return;
    }
    if (payload.sessionId !== sessionId) return;
    applyProgress(payload);
  });

  const envDetail = (): string => {
    if (!env) return "";
    if (!env.ready) return words("TeX not found", "TeX が見つかりません");
    const missing = current?.project.missingPackages ?? [];
    if (missing.length === 0) return env.distribution;
    const prefix = env.autoInstall
      ? words("Installed during typesetting", "組版時に導入")
      : words("Missing", "未導入");
    return `${prefix}: ${missing.join(", ")}`;
  };

  const runBuild = async () => {
    if (!current || !sessionId || !env?.ready) return;
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
      })) as BuildResult;
      if (sessionId !== id) return;
      stopBuildTimer();
      if (result.canceled) return;
      target.result = result;
      if (result.prismPdf) target.project.analysis.prismPdf = result.prismPdf;
      if (current !== target) return;
      if (!result.build.ok) {
        setStep("build", result.build.kind === "cancelled" ? "pending" : "failed", "");
        setStep("compare", "pending", "");
      } else {
        setStep("build", "done", result.build.installed.length > 0 ? `${words("Installed", "導入")}: ${result.build.installed.join(", ")}` : result.build.pdfPath ?? "");
        setStep("compare", result.diff ? "done" : "failed", "");
      }
    } catch (error) {
      stopBuildTimer();
      if (sessionId !== id) return;
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
    if (sessionId) void call("end", { sessionId }).catch(() => {});
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
      if (started.canceled) { busy = false; modal?.close(); return; }
      sessionId = started.sessionId as string;
      destination = started.destination as string;
      provisionalSessionId = null;
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
      setStep("analyze", "done", `${states.length} ${words(states.length === 1 ? "project" : "projects", "プロジェクト")}`);
      renderAll();
      await applyEnv();
    } catch (error) {
      collecting = false;
      provisionalSessionId = null;
      const step = error instanceof ImportError && error.step
        ? error.step
        : stepStatus.get("extract") !== "done" ? "extract" : "analyze";
      if (step === "analyze") setStep("extract", "done", stepDetail.get("extract") || "");
      fail(step, errorText(error));
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
        fail("extract", errorText(error));
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
        fail("env", errorText(error));
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
