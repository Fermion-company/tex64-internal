import { uiText } from "./i18n.js";

// The Packages screen. One list holds everything — installed and not — because
// the question "do I have this?" and "can I get this?" are the same question;
// what matters is that the answer is visible at a glance, which is what the
// state dot, the row tint and the filter counts are for.

export type PackageEntry = {
  name: string;
  installed: boolean;
  sizeBytes: number;
  shortdesc: string;
  kind: "package" | "collection" | "scheme";
};

export type PackagesCatalog = {
  scope: "managed" | "system" | "none";
  needsAdmin: boolean;
  root: string;
  packages: PackageEntry[];
};

export type PackageFilter = "all" | "installed" | "available";

export const formatBytes = (bytes: number): string => {
  const value = Number.isFinite(bytes) ? bytes : 0;
  if (value <= 0) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    const mb = value / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// Relevance, not alphabetical: someone typing "tikz" wants tikz first, not
// tikz-3dplot. Returns null when the entry does not match at all.
export const scorePackage = (entry: PackageEntry, query: string): number | null => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 0;
  }
  const name = entry.name.toLowerCase();
  if (name === q) {
    return 1000;
  }
  if (name.startsWith(q)) {
    // Shorter names are the better prefix match: "tikz" should beat "tikz-cd".
    return 800 - Math.min(199, name.length - q.length);
  }
  if (name.includes(q)) {
    return 600 - Math.min(199, name.length - q.length);
  }
  if (entry.shortdesc.toLowerCase().includes(q)) {
    return 300;
  }
  return null;
};

export const rankPackages = (
  packages: PackageEntry[],
  query: string,
  filter: PackageFilter,
  limit = 120
): { rows: PackageEntry[]; total: number } => {
  const scored: Array<{ entry: PackageEntry; score: number }> = [];
  for (const entry of packages) {
    if (filter === "installed" && !entry.installed) {
      continue;
    }
    if (filter === "available" && entry.installed) {
      continue;
    }
    const score = scorePackage(entry, query);
    if (score === null) {
      continue;
    }
    scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // With no query this is the plain list, and what you own comes first.
    if (!query.trim() && a.entry.installed !== b.entry.installed) {
      return a.entry.installed ? -1 : 1;
    }
    return a.entry.name.localeCompare(b.entry.name);
  });
  return { rows: scored.slice(0, limit).map((item) => item.entry), total: scored.length };
};

export const countPackages = (packages: PackageEntry[]) => {
  let installed = 0;
  for (const entry of packages) {
    if (entry.installed) {
      installed += 1;
    }
  }
  return { all: packages.length, installed, available: packages.length - installed };
};

export const describeScope = (catalog: PackagesCatalog | null): string => {
  if (!catalog || catalog.scope === "none") {
    return uiText("No TeX Live found.", "TeX Live が見つかりません。");
  }
  if (catalog.scope === "managed") {
    return uiText(
      "Managing TeX64's own TeX Live. No password needed.",
      "TeX64 専用の TeX Live を管理しています。パスワードは不要です。"
    );
  }
  return uiText(
    "Managing the TeX Live already on this computer. Changes ask for your administrator password.",
    "この環境に既にある TeX Live を管理しています。変更には管理者パスワードが必要です。"
  );
};

export type PackagesUiApi = {
  handleCatalog: (payload: { ok?: boolean; error?: string } & Partial<PackagesCatalog>) => void;
  handleFiles: (payload: {
    ok?: boolean;
    term?: string;
    matches?: Array<{ name: string; files: string[] }>;
  }) => void;
  handleCtan: (payload: {
    ok?: boolean;
    error?: string;
    term?: string;
    matches?: Array<{ name: string; shortdesc: string }>;
  }) => void;
  handleDetail: (payload: { ok?: boolean; name?: string; detail?: { files?: string[] } }) => void;
  handleOpStart: (payload: { op?: string; names?: string[] }) => void;
  handleOpProgress: (payload: { current?: number | null; total?: number | null; line?: string }) => void;
  handleOpResult: (payload: {
    ok?: boolean;
    op?: string;
    names?: string[];
    cancelled?: boolean;
    error?: string;
    blockers?: Array<{ name: string; neededBy: string }>;
  }) => void;
  onPageActive: () => void;
};

export const initSettingsPackagesUi = (deps: {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
}): PackagesUiApi => {
  const scopeEl = document.getElementById("pkg-scope");
  const updateBtn = document.getElementById("pkg-update");
  const searchEl = document.getElementById("pkg-search");
  const filtersEl = document.getElementById("pkg-filters");
  const listEl = document.getElementById("pkg-list");
  const truncatedEl = document.getElementById("pkg-truncated");
  const extraEl = document.getElementById("pkg-extra");
  const noteEl = document.getElementById("pkg-note");
  const opEl = document.getElementById("pkg-op");
  const opFill = document.getElementById("pkg-op-fill");
  const opLabel = document.getElementById("pkg-op-label");
  const ctanBtn = document.getElementById("pkg-ctan");

  let catalog: PackagesCatalog | null = null;
  let filter: PackageFilter = "all";
  let query = "";
  let loaded = false;
  let busy = false;
  let fileMatches: Array<{ name: string; files: string[] }> = [];
  let fileMatchTerm = "";
  let ctanMatches: Array<{ name: string; shortdesc: string }> = [];
  let ctanTerm = "";
  let fileSearchTimer: number | null = null;
  const expanded = new Set<string>();
  const detailFiles = new Map<string, string[]>();

  const setNote = (message: string, tone: "neutral" | "error" = "neutral") => {
    if (!(noteEl instanceof HTMLElement)) {
      return;
    }
    const text = message.trim();
    noteEl.textContent = text;
    noteEl.classList.toggle("is-hidden", !text);
    noteEl.classList.toggle("is-error", tone === "error");
    noteEl.setAttribute("aria-hidden", text ? "false" : "true");
  };

  const setBusy = (value: boolean, label = "") => {
    busy = value;
    if (opEl instanceof HTMLElement) {
      opEl.classList.toggle("is-hidden", !value);
      opEl.setAttribute("aria-hidden", value ? "false" : "true");
    }
    if (opLabel instanceof HTMLElement && label) {
      opLabel.textContent = label;
    }
    if (opFill instanceof HTMLElement && !value) {
      opFill.style.width = "0%";
    }
    if (updateBtn instanceof HTMLButtonElement) {
      updateBtn.disabled = value;
    }
    render();
  };

  const requestCatalog = (force = false) => {
    deps.postToNative({ type: "packages:catalog", force }, true);
  };

  const stateLabel = (entry: PackageEntry) =>
    entry.installed
      ? uiText("Installed", "導入済み")
      : uiText("Not installed", "未導入");

  const buildRow = (entry: PackageEntry) => {
    const row = document.createElement("div");
    row.className = `pkg-row${entry.installed ? " is-installed" : ""}`;
    row.dataset.name = entry.name;

    const dot = document.createElement("span");
    dot.className = "pkg-dot";
    dot.setAttribute("aria-hidden", "true");
    row.appendChild(dot);

    const main = document.createElement("div");
    main.className = "pkg-main";
    const nameRow = document.createElement("div");
    nameRow.className = "pkg-name-row";
    const name = document.createElement("span");
    name.className = "pkg-name";
    name.textContent = entry.name;
    nameRow.appendChild(name);
    if (entry.kind !== "package") {
      const kind = document.createElement("span");
      kind.className = "pkg-kind";
      kind.textContent =
        entry.kind === "collection"
          ? uiText("collection", "コレクション")
          : uiText("scheme", "スキーム");
      nameRow.appendChild(kind);
    }
    const state = document.createElement("span");
    state.className = "pkg-state";
    state.textContent = stateLabel(entry);
    nameRow.appendChild(state);
    main.appendChild(nameRow);

    if (entry.shortdesc) {
      const desc = document.createElement("div");
      desc.className = "pkg-desc";
      desc.textContent = entry.shortdesc;
      main.appendChild(desc);
    }

    if (expanded.has(entry.name)) {
      const files = document.createElement("div");
      files.className = "pkg-files";
      const known = detailFiles.get(entry.name);
      files.textContent = known
        ? known.join("\n")
        : uiText("Loading files…", "ファイルを読み込み中…");
      main.appendChild(files);
    }
    row.appendChild(main);

    const size = document.createElement("span");
    size.className = "pkg-size";
    size.textContent = formatBytes(entry.sizeBytes);
    row.appendChild(size);

    const action = document.createElement("button");
    action.type = "button";
    action.className = `pkg-action${entry.installed ? " is-remove" : " is-install"}`;
    action.textContent = entry.installed
      ? uiText("Remove", "削除")
      : uiText("Install", "導入");
    action.disabled = busy;
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      if (busy) {
        return;
      }
      setNote("");
      if (entry.installed) {
        deps.postToNative({ type: "packages:remove", names: [entry.name] }, true);
      } else {
        deps.postToNative({ type: "packages:install", names: [entry.name] }, true);
      }
    });
    row.appendChild(action);

    // Opening a row answers "what is actually in this package?" — the file list
    // is the honest answer, and it is what the file search matches against.
    row.addEventListener("click", () => {
      if (expanded.has(entry.name)) {
        expanded.delete(entry.name);
      } else {
        expanded.add(entry.name);
        if (!detailFiles.has(entry.name)) {
          deps.postToNative({ type: "packages:detail", name: entry.name }, true);
        }
      }
      render();
    });
    return row;
  };

  const render = () => {
    if (!(listEl instanceof HTMLElement)) {
      return;
    }
    if (scopeEl instanceof HTMLElement) {
      scopeEl.textContent = describeScope(catalog);
      scopeEl.classList.toggle("needs-admin", Boolean(catalog?.needsAdmin));
    }
    const packages = catalog?.packages ?? [];
    const counts = countPackages(packages);
    if (filtersEl instanceof HTMLElement) {
      for (const key of ["all", "installed", "available"] as PackageFilter[]) {
        const button = filtersEl.querySelector(`[data-pkg-filter="${key}"]`);
        const count = filtersEl.querySelector(`[data-pkg-count="${key}"]`);
        if (button instanceof HTMLElement) {
          button.setAttribute("aria-pressed", key === filter ? "true" : "false");
        }
        if (count instanceof HTMLElement) {
          count.textContent = String(counts[key]);
        }
      }
    }

    listEl.textContent = "";
    if (!loaded) {
      const loading = document.createElement("div");
      loading.className = "pkg-empty";
      loading.textContent = uiText("Reading the package list…", "パッケージ一覧を読み込み中…");
      listEl.appendChild(loading);
      return;
    }

    const { rows, total } = rankPackages(packages, query, filter);
    for (const entry of rows) {
      listEl.appendChild(buildRow(entry));
    }

    // Packages whose *files* match, and anything the CTAN escape hatch turned up,
    // go after the name/description hits so the instant results are never held up
    // by the slower searches — but in their own block, not appended inside the
    // list's scroll, where 120 rows of name hits would bury them.
    const byName = new Set(rows.map((entry) => entry.name));
    const extraFileHits = fileMatches.filter((match) => !byName.has(match.name));
    const extraTarget = extraEl instanceof HTMLElement ? extraEl : listEl;
    if (extraEl instanceof HTMLElement) {
      extraEl.textContent = "";
    }
    if (query.trim() && fileMatchTerm === query.trim() && extraFileHits.length > 0) {
      const heading = document.createElement("div");
      heading.className = "pkg-section";
      heading.textContent = uiText("Matched by file name", "ファイル名で一致");
      extraTarget.appendChild(heading);
      for (const match of extraFileHits.slice(0, 40)) {
        const entry =
          packages.find((item) => item.name === match.name) ??
          ({
            name: match.name,
            installed: false,
            sizeBytes: 0,
            shortdesc: match.files[0] ?? "",
            kind: "package",
          } as PackageEntry);
        const row = buildRow(entry);
        const hint = document.createElement("div");
        hint.className = "pkg-file-hit";
        hint.textContent = match.files.slice(0, 3).join("\n");
        row.querySelector(".pkg-main")?.appendChild(hint);
        extraTarget.appendChild(row);
      }
    }

    if (ctanTerm && ctanTerm === query.trim() && ctanMatches.length > 0) {
      const heading = document.createElement("div");
      heading.className = "pkg-section";
      heading.textContent = uiText("Found on CTAN", "CTAN で見つかったもの");
      extraTarget.appendChild(heading);
      for (const match of ctanMatches.slice(0, 40)) {
        if (byName.has(match.name)) {
          continue;
        }
        const known = packages.find((item) => item.name === match.name);
        extraTarget.appendChild(
          buildRow(
            known ?? {
              name: match.name,
              installed: false,
              sizeBytes: 0,
              shortdesc: match.shortdesc,
              kind: "package",
            }
          )
        );
      }
    }

    const extraShown =
      extraEl instanceof HTMLElement ? extraEl.childElementCount > 0 : extraFileHits.length > 0;
    if (rows.length === 0 && !extraShown) {
      const empty = document.createElement("div");
      empty.className = "pkg-empty";
      empty.textContent = query.trim()
        ? uiText("Nothing matched.", "一致するものがありません。")
        : uiText("No packages.", "パッケージがありません。");
      listEl.appendChild(empty);
    }

    if (extraEl instanceof HTMLElement) {
      const hasExtra = extraEl.childElementCount > 0;
      extraEl.classList.toggle("is-hidden", !hasExtra);
      extraEl.setAttribute("aria-hidden", hasExtra ? "false" : "true");
    }

    if (truncatedEl instanceof HTMLElement) {
      const hidden = total - rows.length;
      const show = hidden > 0;
      truncatedEl.textContent = show
        ? uiText(
            `Showing ${rows.length} of ${total} — narrow the search to see the rest.`,
            `${total} 件中 ${rows.length} 件を表示中 — 絞り込むと残りが見えます。`
          )
        : "";
      truncatedEl.classList.toggle("is-hidden", !show);
      truncatedEl.setAttribute("aria-hidden", show ? "false" : "true");
    }
  };

  const scheduleFileSearch = () => {
    if (fileSearchTimer !== null) {
      window.clearTimeout(fileSearchTimer);
      fileSearchTimer = null;
    }
    const term = query.trim();
    if (term.length < 2) {
      fileMatches = [];
      fileMatchTerm = "";
      return;
    }
    // The name/description filter is instant; the file search costs a tlmgr call,
    // so it only runs once typing settles and its results arrive underneath.
    fileSearchTimer = window.setTimeout(() => {
      fileSearchTimer = null;
      deps.postToNative({ type: "packages:searchFiles", term }, true);
    }, 300);
  };

  if (searchEl instanceof HTMLInputElement) {
    searchEl.addEventListener("input", () => {
      query = searchEl.value;
      ctanMatches = [];
      ctanTerm = "";
      render();
      scheduleFileSearch();
    });
  }

  if (filtersEl instanceof HTMLElement) {
    filtersEl.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement | null)?.closest("[data-pkg-filter]");
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const value = button.dataset.pkgFilter as PackageFilter | undefined;
      if (!value) {
        return;
      }
      filter = value;
      render();
    });
  }

  if (updateBtn instanceof HTMLButtonElement) {
    updateBtn.addEventListener("click", () => {
      if (busy) {
        return;
      }
      setNote("");
      deps.postToNative({ type: "packages:update" }, true);
    });
  }

  if (ctanBtn instanceof HTMLButtonElement) {
    ctanBtn.addEventListener("click", () => {
      const term = query.trim();
      if (term.length < 2) {
        setNote(
          uiText("Type something to search for first.", "先に検索したい語を入力してください。")
        );
        return;
      }
      setNote(uiText("Searching CTAN…", "CTAN を検索中…"));
      deps.postToNative({ type: "packages:ctanSearch", term }, true);
    });
  }

  return {
    onPageActive: () => {
      if (!loaded) {
        requestCatalog(false);
      }
      render();
    },
    handleCatalog: (payload) => {
      if (payload?.ok === false) {
        loaded = true;
        setNote(payload.error ?? uiText("Could not read the package list.", "パッケージ一覧を読み込めませんでした。"), "error");
        render();
        return;
      }
      catalog = {
        scope: (payload.scope as PackagesCatalog["scope"]) ?? "none",
        needsAdmin: Boolean(payload.needsAdmin),
        root: payload.root ?? "",
        packages: Array.isArray(payload.packages) ? (payload.packages as PackageEntry[]) : [],
      };
      loaded = true;
      render();
    },
    handleFiles: (payload) => {
      if (payload?.ok === false) {
        return;
      }
      fileMatches = Array.isArray(payload.matches) ? payload.matches : [];
      fileMatchTerm = (payload.term ?? "").trim();
      render();
    },
    handleCtan: (payload) => {
      setNote("");
      if (payload?.ok === false) {
        setNote(payload.error ?? uiText("CTAN search failed.", "CTAN 検索に失敗しました。"), "error");
        return;
      }
      ctanMatches = Array.isArray(payload.matches) ? payload.matches : [];
      ctanTerm = (payload.term ?? "").trim();
      if (ctanMatches.length === 0) {
        setNote(uiText("CTAN had nothing either.", "CTAN にも見つかりませんでした。"));
      }
      render();
    },
    handleDetail: (payload) => {
      if (payload?.ok === false || !payload.name) {
        return;
      }
      detailFiles.set(payload.name, payload.detail?.files ?? []);
      render();
    },
    handleOpStart: (payload) => {
      const op = payload?.op ?? "";
      const names = Array.isArray(payload?.names) ? payload.names : [];
      const label =
        op === "update"
          ? uiText("Updating every package…", "すべてのパッケージを更新中…")
          : op === "remove"
          ? uiText(`Removing ${names.join(", ")}…`, `${names.join(", ")} を削除中…`)
          : uiText(`Installing ${names.join(", ")}…`, `${names.join(", ")} を導入中…`);
      setBusy(true, label);
    },
    handleOpProgress: (payload) => {
      const current = typeof payload?.current === "number" ? payload.current : null;
      const total = typeof payload?.total === "number" ? payload.total : null;
      if (opFill instanceof HTMLElement && current !== null && total !== null && total > 0) {
        opFill.style.width = `${Math.round((current / total) * 100)}%`;
      }
      if (opLabel instanceof HTMLElement && payload?.line) {
        opLabel.textContent =
          current !== null && total !== null ? `${payload.line} (${current}/${total})` : payload.line;
      }
    },
    handleOpResult: (payload) => {
      setBusy(false);
      if (payload?.cancelled) {
        setNote(uiText("Cancelled.", "キャンセルされました。"));
        return;
      }
      const blockers = Array.isArray(payload?.blockers) ? payload.blockers : [];
      if (blockers.length > 0) {
        // tlmgr refuses to strand a collection; saying which one is the useful part.
        setNote(
          blockers
            .map((blocker) =>
              uiText(
                `${blocker.name} was kept: ${blocker.neededBy} needs it.`,
                `${blocker.name} は残しました: ${blocker.neededBy} が必要としています。`
              )
            )
            .join("\n"),
          "error"
        );
        return;
      }
      if (payload?.ok === false) {
        setNote(payload.error ?? uiText("The operation failed.", "操作に失敗しました。"), "error");
        return;
      }
      setNote(
        payload?.op === "update"
          ? uiText("Everything is up to date.", "すべて最新になりました。")
          : uiText("Done.", "完了しました。")
      );
      loaded = false;
      requestCatalog(true);
      render();
    },
  };
};
