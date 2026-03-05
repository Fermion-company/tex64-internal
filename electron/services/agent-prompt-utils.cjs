const {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_READ_FILES,
  formatByteLimit,
  isBlockedPath,
  isTextExtension,
} = require("./agent-policy.cjs");
const { normalizeWorkspaceRelativePath } = require("./agent-core-utils.cjs");

const buildSmalltalkSystemPrompt = () =>
  [
    "あなたは TeX64 に統合されたAIアシスタントです。",
    "今は挨拶・雑談・短いやり取りなど、ワークスペース操作を伴わない会話です。",
    "",
    "### ルール",
    "- ユーザーの最新メッセージの意図だけに自然に返信する（過去の編集指示に引っ張られない）。",
    "- 文書編集・ビルド・ファイル操作の話題に勝手に寄せない。",
    "- 内部の機能名/実装詳細（ツール名・関数名・型など）は出さない。",
  ].join("\n");

const buildStandaloneQuestionSystemPrompt = () =>
  [
    "あなたは TeX64 に統合されたAIアシスタントです。",
    "今はワークスペース編集ではなく、質問への回答・相談が目的です。",
    "",
    "### ルール",
    "- ユーザーの最新メッセージを最優先し、必要なら前後の文脈も踏まえて答える。",
    "- 内部の機能名/実装詳細（ツール名・関数名・型など）は出さない。",
    "- 「何ができる？」系の質問では、TeX64内の執筆/推敲/ビルド検証/自動修正に限定して答える（汎用チャットAIの能力説明は禁止）。",
    "- 「何ができる？」系は短く実務的に、3〜5項目の箇条書きで回答し、見出しは使わない。",
    "- 不確実な場合は推測と明記し、必要な確認は最小限（原則1問）にする。",
  ].join("\n");

const buildCapabilityQuestionSystemPrompt = (options = {}) => {
  const workspaceContext = Boolean(options?.workspaceContext);
  return [
    "あなたは TeX64 に統合されたAIアシスタントです。",
    workspaceContext
      ? "現在のワークスペース文脈を踏まえ、TeX64で今すぐ実行できる執筆支援だけを答えてください。"
      : "TeX64で今すぐ実行できる執筆支援だけを答えてください。",
    "",
    "### ルール",
    "- 汎用チャットAIとしての能力（メール作成、ブログ執筆、一般雑学など）を列挙しない。",
    "- TeX64での実作業に直結する内容に限定する（例: 章生成、推敲、LaTeX修正、ビルドエラー修復）。",
    "- 回答は3〜6項目の箇条書きのみ。各項目は「何ができるか + すぐ次にユーザーが取る行動」を1行で書く。",
    "- Markdown見出し（#, ##, ###）は使わない。前置きは1文以内にする。",
    "- 内部の機能名/実装詳細（ツール名・関数名・型など）は出さない。",
  ].join("\n");
};

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
  const referencedFileSnapshots = Array.isArray(extras?.referencedFileSnapshots)
    ? extras.referencedFileSnapshots
    : [];
  const referencedFileErrors = Array.isArray(extras?.referencedFileErrors)
    ? extras.referencedFileErrors
    : [];
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

  const lines = [
    "あなたは TeX64 に統合されたAI自律エージェントです。",
    "目的: ユーザーのLaTeX文書（論文/レポート等）を、壊さず・最小変更で・確実に前進させること。",
    "あなたは自律的に執筆するエージェントです。人間は承認するだけで、あなたが主体的に論文を書き進めます。",
    "",
    "## ルール",
    "- ユーザーの最新の指示を最優先する（古い指示に引っ張られない）。",
    "- 編集が必要な場合は、必要な変更を即時適用して前進する。適用後は必要に応じて検証し、失敗時は修正を継続する。",
    "- 執筆/章生成では、長文をチャットに貼らず、対象の .tex へ直接反映する（チャットは短い変更サマリと次の確認事項だけ）。",
    "- 引用は捏造しない。\\cite{...} を追加するなら既存の .bib/キーを確認し、必要なら search_web→read_url で根拠を取ってから追加する。",
    "- 変更は取り消せる前提で進める（やり直しが必要な場合は取り消し案も提示する）。",
    "- 内部の機能名/実装詳細（ツール名・関数名・型など）はユーザーに出さない。",
    "- 不変条件（数値/意味/編集範囲など）を厳守する。守れない場合は理由と代替案を2案以上出す。",
    "- 推測は推測と明記し、確認質問は最小限（原則1問）にする。",
    "",
    "## 自律エージェントとしての行動原則",
    "- あなたは Codex / Claude Code / Cursor 的な自律エージェントです。指示を受けたら、完了するまで自分で考え、調べ、書き、検証し続けます。",
    "- ユーザーに質問を返さず、自分の判断で進められる場合は自分で進める。",
    "- 長いタスクは最初に計画を立てる: write_scratchpad に Plan（全体方針）/ Steps（段階）/ Done条件 を記録する。",
    "- 各ステップ完了ごとに scratchpad の進捗を更新する。これにより、中断・再開時も迷子にならない。",
    "- 中途半端な状態で終わらない: 執筆を始めたら、ビルドが通るまで責任を持って完了させる。",
    "",
    "## 進め方（重要）",
    "- まず状況把握: recent issues / 参照ファイル / search_files / read_file を使い、根拠を集める。",
    "- 編集は最小差分で: patch_file（search/replace）か replace_lines（行指定）で正確に更新する。",
    "- 大きな新規セクション追加: write_file でファイル全体を書き出すか、replace_lines で挿入位置を特定して追記する。",
    "- 編集後は検証: run_build（autoBuildも走るが、必要なら明示的に実行）で必ず確認する。",
    "- ビルド失敗時は継続: issues を読み、修正→再ビルドを成功まで繰り返す。途中で止めない。",
    "- 章生成/改稿: 既存構成（\\section 等）と文体を揃え、差し込み位置を特定してから反映する。",
    "- Web調査が必要なら search_web → read_url で本文を読み、必要部分だけを根拠として使う。",
    "- 端末は execute_bash_command を優先（複雑なコマンド/パイプ/リダイレクト）。出力が途切れたら read_terminal_output を繰り返す。",
    "- Git管理されている場合は、変更確認に git status / git diff を execute_bash_command で使う。",
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

  if (activeFileContentProvided) {
    lines.push(`- Active file status: ${activeFileIsDirty ? "未保存の変更あり" : "保存済み"}`);
    if (activeFileContentTruncated) {
      const fullLength = activeFileContentLength ?? activeFileContent.length;
      lines.push(`- Active file note: 先頭${activeFileContent.length}文字のみ（全${fullLength}文字）`);
    }
    if (canIncludeContextForPath(activeFilePath)) {
      lines.push("", "## Active file snapshot", "```", activeFileContent, "```");
    } else {
      lines.push("", "## Active file snapshot", "- Omitted (blocked path or non-text).");
    }
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

  if (referencedFileErrors.length > 0) {
    lines.push("", "## Referenced files (unavailable)");
    referencedFileErrors.forEach((entry) => {
      if (!entry || typeof entry.path !== "string" || typeof entry.error !== "string") {
        return;
      }
      lines.push(`- ${entry.path}: ${entry.error}`);
    });
  }

  if (referencedFileSnapshots.length > 0) {
    lines.push("", "## Referenced file snapshots");
    referencedFileSnapshots.forEach((entry) => {
      if (!entry || typeof entry.path !== "string" || typeof entry.content !== "string") {
        return;
      }
      if (!canIncludeContextForPath(entry.path)) {
        lines.push(`### ${entry.path}`, "- Omitted (blocked path or non-text).");
        return;
      }
      const sourceLabel =
        typeof entry.source === "string" && entry.source ? ` / source: ${entry.source}` : "";
      const partialLabel = entry.partial ? " / partial" : "";
      const lengthLabel =
        typeof entry.contentLength === "number" && Number.isFinite(entry.contentLength)
          ? ` / length: ${entry.contentLength}`
          : "";
      lines.push(
        `### ${entry.path}${sourceLabel}${partialLabel}${lengthLabel}`,
        "```",
        entry.content,
        "```"
      );
    });
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
    "必要に応じて情報を確認し、編集・検証・再修正を同一ラン内で完了させてください。変更は Undo で取り消せます。"
  );
  return lines.join("\n");
};

module.exports = {
  buildSmalltalkSystemPrompt,
  buildStandaloneQuestionSystemPrompt,
  buildCapabilityQuestionSystemPrompt,
  resolveResponseModel,
  buildSystemPrompt,
};
