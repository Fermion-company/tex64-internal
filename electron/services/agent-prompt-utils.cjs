const {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_READ_FILES,
  formatByteLimit,
  isBlockedPath,
  isTextExtension,
} = require("./agent-policy.cjs");
const { normalizeWorkspaceRelativePath } = require("./agent-core-utils.cjs");

const resolveResponseModel = (response) => {
  if (!response || typeof response !== "object") {
    return "";
  }
  const candidates = [
    response.resolvedModel,
    response.modelVersion,
    response.model,
    response.output?.model,
    response.usage?.model,
    response.usageMetadata?.model,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const buildSystemPrompt = (context, rootPath, policy, options, extras = {}) => {
  const activeFilePath = context?.activeFilePath ?? "";
  const activeFileContentProvided = typeof context?.activeFileContent === "string";
  const activeFileContent =
    typeof context?.activeFileContent === "string" ? context.activeFileContent : "";
  const activeFileIsDirty = Boolean(context?.activeFileIsDirty);
  const activeFileContentTruncated = Boolean(context?.activeFileContentTruncated);
  const activeFileContentLength =
    typeof context?.activeFileContentLength === "number" ? context.activeFileContentLength : null;
  const openFiles = Array.isArray(context?.openFiles) ? context.openFiles : [];
  const openFileLabel = openFiles.length
    ? openFiles
        .map((entry) => {
          const dirty = entry.isDirty ? " *" : "";
          const active = entry.isActive ? " (active)" : "";
          return `${entry.path}${dirty}${active}`;
        })
        .join(", ")
    : "";
  const dirtyOpenCount = openFiles.filter((entry) => entry.isDirty).length;
  const blockedList = policy?.blockedTopLevel ? Array.from(policy.blockedTopLevel) : [];
  const allowedList = policy?.allowedTopLevel ? Array.from(policy.allowedTopLevel) : [];
  const blockedLabel = blockedList.length > 0 ? blockedList.join(" / ") : "(なし)";
  const allowedLabel = allowedList.length > 0 ? allowedList.join(" / ") : "";
  const fileSizeLabel = formatByteLimit(policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const readFilesLimit = policy?.maxReadFiles ?? DEFAULT_MAX_READ_FILES;
  const contextControls =
    context?.contextControls && typeof context.contextControls === "object"
      ? context.contextControls
      : null;
  const includeSelection =
    contextControls && typeof contextControls.includeSelection === "boolean"
      ? contextControls.includeSelection
      : false;
  const includeOpenFiles =
    contextControls && typeof contextControls.includeOpenFiles === "boolean"
      ? contextControls.includeOpenFiles
      : true;
  const includeIssues =
    contextControls && typeof contextControls.includeIssues === "boolean"
      ? contextControls.includeIssues
      : true;
  const explicitContextPaths = Array.isArray(context?.explicitContextPaths)
    ? context.explicitContextPaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const rootFileInfo =
    extras?.rootFileInfo && typeof extras.rootFileInfo === "object" ? extras.rootFileInfo : null;
  const projectInstructions =
    typeof extras?.projectInstructions === "string" ? extras.projectInstructions.trim() : "";
  const agentMemory =
    typeof extras?.agentMemory === "string" ? extras.agentMemory.trim() : "";
  const scratchpadRaw = typeof extras?.scratchpad === "string" ? extras.scratchpad : "";
  const scratchpadLimit = 8000;
  const scratchpad =
    scratchpadRaw.length > scratchpadLimit
      ? scratchpadRaw.slice(scratchpadRaw.length - scratchpadLimit)
      : scratchpadRaw;
  const scratchpadTruncated = scratchpadRaw.length > scratchpad.length;

  const canIncludeContextForPath = (value) => {
    const normalized = normalizeWorkspaceRelativePath(rootPath, value);
    if (!normalized) {
      // When the file isn't on disk yet (unsaved buffer), allow snapshot.
      return !value;
    }
    if (normalized.startsWith("../")) {
      return false;
    }
    if (isBlockedPath(normalized, policy)) {
      return false;
    }
    if (!isTextExtension(normalized, policy)) {
      return false;
    }
    return true;
  };

  // --- Build document context block early so it appears near the top ---
  const documentContextLines = [];
  if (activeFileContentProvided && canIncludeContextForPath(activeFilePath)) {
    documentContextLines.push(
      "",
      `## 現在のドキュメント（${activeFilePath || "unknown"}）`,
      "以下はエディタで開いているファイルの内容です。執筆・編集指示ではこの内容からテーマ・構成・文体を判断してください。",
    );
    if (activeFileIsDirty) {
      documentContextLines.push("- 状態: 未保存の変更あり");
    }
    if (activeFileContentTruncated) {
      const fullLength = activeFileContentLength ?? activeFileContent.length;
      documentContextLines.push(`- 先頭${activeFileContent.length}文字のみ（全${fullLength}文字）`);
    }
    documentContextLines.push("```", activeFileContent, "```");
  }

  const lines = [
    "あなたは TeX64 に統合されたAI自律エージェントです。",
    "目的: ユーザーのLaTeX文書（論文/レポート等）を、壊さず・最小変更で・確実に前進させること。",
    "あなたは自律的に執筆するエージェントです。人間は承認するだけで、あなたが主体的に論文を書き進めます。",
    ...documentContextLines,
    "",
    "## 応答ルール（最重要）",
    "あなたは常にツールを呼び出す。テキストのみの応答は禁止。",
    "- ユーザーへのメッセージは finish_task(message=...) のみで送る。それ以外でチャットにテキストを出力してはならない。",
    "- LaTeXコード・文書本文はファイルへ書き込む（write_file / patch_file / replace_lines）。チャットには絶対に出力しない。",
    "- 質問・確認・選択肢提示は禁止。情報が足りないときはドキュメントを読んで自分で判断し、即座に書き始める。",
    "- エディタで開いているファイルの内容はすでに提供済み。それをそのまま信頼して使う（再確認不要）。",
    "",
    "## ルール",
    "- ユーザーの最新の指示を最優先する（古い指示に引っ張られない）。",
    "- 編集が必要な場合は、必要な変更を即時適用して前進する。適用後は必要に応じて検証し、失敗時は修正を継続する。",
    "- 引用は捏造しない。\\cite{...} を追加するなら既存の .bib/キーを確認し、必要なら search_web→read_url で根拠を取ってから追加する。",
    "- 変更は取り消せる前提で進める。",
    "- 不変条件（数値/意味/編集範囲など）を厳守する。",
    "",
    "## 自律エージェントとしての行動原則",
    "- 指示を受けたら、完了するまで自分で考え、調べ、書き、検証し続ける。finish_task で完了を報告する。",
    "- 執筆・章生成・加筆の指示: ファイル内容はすでに受け取っている。それを読んで文書の構造・テーマ・文体を把握し、即座に書き始める。不足があれば read_file で関連ファイルも読む。",
    "- 長いタスクは最初に計画を立てる: write_scratchpad に Plan / Steps / Done条件 を記録する。",
    "- 中途半端な状態で終わらない: 執筆を始めたら、ビルドが通るまで責任を持って完了させる。",
    "",
    "## 進め方",
    "- まず状況把握: read_file / read_files で必要なファイルを読む（一度に最大16ファイル）。search_files で検索も可。",
    "- 編集は最小差分で: patch_file（search/replace）か replace_lines（行指定）で正確に更新する。",
    "- 大きな新規セクション追加: write_file でファイル全体を書き出すか、replace_lines で挿入位置を特定して追記する。",
    "- 編集後は検証: run_build で必ず確認する。",
    "- ビルド失敗時は継続: issues を読み、修正→再ビルドを成功まで繰り返す。途中で止めない。",
    "- 章生成/改稿: Active file snapshot から既存の構成・文体・トーンを把握する。\\input で分割されている場合は関連ファイルも read_file で読む。",
    "- Web調査が必要なら search_web → read_url で本文を読み、必要部分だけを根拠として使う。",
    "- 長いタスクは scratchpad を使う: Plan / 進捗 / Done条件 を write_scratchpad で更新し、迷子にならない。",
    "",
    `- ブロック対象: ${blockedLabel}${allowedLabel ? `（許可: ${allowedLabel}）` : ""}`,
    fileSizeLabel === "無制限"
      ? "- ファイルサイズ制限なし"
      : `- 1ファイル最大${fileSizeLabel}まで読み書き可能`,
    "",
    "## ワークスペース",
    `- Root: ${rootPath}`,
    rootFileInfo?.path
      ? `- Root main tex: ${rootFileInfo.path}${
          typeof rootFileInfo.source === "string" && rootFileInfo.source
            ? ` (${rootFileInfo.source})`
            : ""
        }`
      : "- Root main tex: (unknown)",
    `- Active file: ${activeFilePath || "(none)"}`,
    `- Context controls: selection=${includeSelection ? "on" : "off"}, openFiles=${
      includeOpenFiles ? "on" : "off"
    }, issues=${includeIssues ? "on" : "off"}`,
  ];

  if (explicitContextPaths.length > 0) {
    lines.push(`- User referenced files: ${explicitContextPaths.join(", ")}`);
  }

  if (projectInstructions) {
    const MAX_INSTRUCTIONS_CHARS = 8000;
    const trimmed =
      projectInstructions.length > MAX_INSTRUCTIONS_CHARS
        ? projectInstructions.slice(0, MAX_INSTRUCTIONS_CHARS) + "\n\n(以降省略)"
        : projectInstructions;
    lines.push("", "## Project Instructions (user-defined)", "```", trimmed, "```");
  }

  if (agentMemory) {
    const MAX_MEMORY_CHARS = 6000;
    const trimmedMemory =
      agentMemory.length > MAX_MEMORY_CHARS
        ? agentMemory.slice(0, MAX_MEMORY_CHARS) + "\n\n(以降省略)"
        : agentMemory;
    lines.push(
      "",
      "## Agent Memory (persistent across sessions)",
      "このメモリは `.tex64/agent-memory.md` に保存されており、セッション間で共有されます。",
      "ユーザーの好みや文体規約など、次回以降も覚えておくべき情報は write_file で `.tex64/agent-memory.md` に追記してください。",
      "```",
      trimmedMemory,
      "```"
    );
  } else {
    lines.push(
      "",
      "## Agent Memory",
      "- (empty) セッション間で記憶を残すには、`.tex64/agent-memory.md` に write_file で書き込んでください。",
      "- 例: ユーザーの文体の好み、略語規約、引用スタイルなど。"
    );
  }

  lines.push("", "## Scratchpad");
  if (scratchpad.trim()) {
    if (scratchpadTruncated) {
      lines.push("- Note: 末尾のみ抜粋（長すぎるため省略）");
    }
    lines.push("```", scratchpad, "```");
  } else {
    lines.push("- (empty) 長いタスクでは Plan / 進捗 / Done条件 を write_scratchpad で記録する。");
  }

  if (openFileLabel) {
    lines.push(`- Open files: ${openFileLabel}`);
    if (dirtyOpenCount > 0) {
      lines.push(`- Unsaved buffers: ${dirtyOpenCount}件`);
    }
  }

  // Active file snapshot is already included near the top of the prompt.
  // Only add a note here if it was omitted (blocked path or non-text).
  if (activeFileContentProvided && !canIncludeContextForPath(activeFilePath)) {
    lines.push("", "## Active file snapshot", "- Omitted (blocked path or non-text).");
  }

  const activeSelection =
    context?.activeSelection && typeof context.activeSelection === "object"
      ? context.activeSelection
      : null;
  if (
    includeSelection &&
    activeSelection &&
    typeof activeSelection.text === "string" &&
    activeSelection.text
  ) {
    const pathLabel =
      typeof activeSelection.path === "string" && activeSelection.path.trim()
        ? activeSelection.path.trim()
        : "(unknown)";
    const startLine =
      typeof activeSelection.startLine === "number" ? activeSelection.startLine : null;
    const startColumn =
      typeof activeSelection.startColumn === "number" ? activeSelection.startColumn : null;
    const endLine = typeof activeSelection.endLine === "number" ? activeSelection.endLine : null;
    const endColumn =
      typeof activeSelection.endColumn === "number" ? activeSelection.endColumn : null;
    const rangeLabel =
      startLine && startColumn && endLine && endColumn
        ? `${startLine}:${startColumn}-${endLine}:${endColumn}`
        : "(range unknown)";
    lines.push("", "## Active selection", `- File: ${pathLabel}`, `- Range: ${rangeLabel}`);
    if (canIncludeContextForPath(pathLabel)) {
      if (activeSelection.truncated) {
        const fullLength =
          typeof activeSelection.textLength === "number"
            ? activeSelection.textLength
            : activeSelection.text.length;
        lines.push(
          `- Selection note: 先頭${activeSelection.text.length}文字のみ（全${fullLength}文字）`
        );
      }
      lines.push("```", activeSelection.text, "```");
    } else {
      lines.push("- Omitted (blocked path or non-text).");
    }
  } else if (context?.activeSelectionRequested === true) {
    lines.push("", "## Active selection", "- Selection requested but no active selection was found.");
  }

  const openSnapshots = Array.isArray(context?.openFileSnapshots)
    ? context.openFileSnapshots
    : [];
  if (includeOpenFiles && openSnapshots.length > 0) {
    const seenPaths = new Set();
    const usableSnapshots = openSnapshots.filter((snapshot) => {
      if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.content !== "string") {
        return false;
      }
      if (snapshot.path === activeFilePath) {
        return false;
      }
      if (!canIncludeContextForPath(snapshot.path)) {
        return false;
      }
      if (seenPaths.has(snapshot.path)) {
        return false;
      }
      seenPaths.add(snapshot.path);
      return true;
    });
    if (usableSnapshots.length > 0) {
      lines.push("", "## Open file snapshots");
      usableSnapshots.forEach((snapshot) => {
        const dirtyLabel = snapshot.isDirty ? " (未保存)" : "";
        lines.push(`### ${snapshot.path}${dirtyLabel}`);
        if (snapshot.truncated) {
          const fullLength =
            typeof snapshot.contentLength === "number"
              ? snapshot.contentLength
              : snapshot.content.length;
          lines.push(`- Snapshot note: 先頭${snapshot.content.length}文字のみ（全${fullLength}文字）`);
        }
        lines.push("```", snapshot.content, "```");
      });
    }
  }

  const recentIssues = Array.isArray(context?.recentIssues) ? context.recentIssues : [];
  const recentIssueSummary =
    typeof context?.recentIssueSummary === "string" ? context.recentIssueSummary : "";
  const recentIssueStatus =
    typeof context?.recentIssueStatus === "string" ? context.recentIssueStatus : "";
  const recentIssuesUpdatedAt =
    typeof context?.recentIssuesUpdatedAt === "string" ? context.recentIssuesUpdatedAt : "";
  if (includeIssues && recentIssues.length > 0) {
    lines.push("", "## Recent issues");
    if (recentIssueSummary) {
      lines.push(`- Summary: ${recentIssueSummary}${recentIssueStatus ? ` (${recentIssueStatus})` : ""}`);
    }
    if (recentIssuesUpdatedAt) {
      lines.push(`- Updated: ${recentIssuesUpdatedAt}`);
    }
    recentIssues.forEach((issue) => {
      if (!issue || typeof issue.message !== "string") {
        return;
      }
      const location = issue.path
        ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
        : issue.line
        ? `line ${issue.line}`
        : "location unknown";
      const severity = issue.severity || "error";
      const resolution =
        typeof issue.resolution === "string" && issue.resolution.trim()
          ? ` / fix: ${issue.resolution.trim()}`
          : "";
      lines.push(`- [${severity}] ${issue.message} (${location})${resolution}`);
    });
  }

  lines.push(
    "",
    "編集・検証・再修正を同一ラン内で完了させてください。変更は Undo で取り消せます。",
    "",
    "## 行動チェックリスト（毎ターン確認）",
    "1. ユーザーへのメッセージ → finish_task(message=...) で送る",
    "2. LaTeXコード・文書本文 → .tex ファイルへ書き込む（チャットに出力しない）",
    "3. 情報不足 → ドキュメントを読んで自分で判断する（質問しない）",
    "4. タスク完了 → finish_task で結果を一言で報告する"
  );
  return lines.join("\n");
};

module.exports = {
  resolveResponseModel,
  buildSystemPrompt,
};
