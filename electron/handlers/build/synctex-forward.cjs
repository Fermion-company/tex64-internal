const path = require("path");
const { resolveInputLineTarget } = require("../../services/tex-input-target.cjs");
const { resolveIncludesOf } = require("../../services/tex-build-target.cjs");
const { mapSourceLine, splitLines } = require("../../services/synctex/build-sources.cjs");

// How long a Jump the last Build cannot answer waits for Live's canonical
// pass to reach the source (the status mark turning green) before the
// Build's answer stands.
const LIVE_JUMP_WAIT_MS = 2500;
// How long a Jump the Build can answer waits for Live's own answer first
// (the first lookup of a canonical pass reads its PDF's text).
const LIVE_FIRST_BUDGET_MS = 1500;

const createSynctexForwardHandler = (deps, resolvers) => {
  const { fs, pdfWindowManager, synctexService, sendToRenderer, ensureWorkspace, state, delay, resolveJumpDocument,
    getLiveEngine, buildSources, workspace } = deps;
  const { resolveWorkspacePathFromRoot, resolveWorkspaceRelativePath, isWorkspaceSynctexPathSame } =
    resolvers;

  let synctexForwardGeneration = 0;
  // Re-checks (below) have their own: one never cancels a Jump, nor a Jump one.
  let recheckGeneration = 0;
  const synctexForwardResultCache = new Map();
  let lastBuildSource = null;

  // A file's lines: `given` when the caller numbers them otherwise than the
  // file on disk does (the text the Build read), else the file as it is.
  const sourceLines = (sourcePath, given = null) => {
    if (Array.isArray(given)) return given;
    return fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
  };

  const isSkippableSynctexLine = (sourcePath, lineNumber, given = null) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      return false;
    }
    try {
      const lines = sourceLines(sourcePath, given);
      const line = lines[lineNumber - 1];
      if (typeof line !== "string") {
        return false;
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("%")) {
        return true;
      }
      if (
        /^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(
          trimmed
        )
      ) {
        return true;
      }
      if (/\\\\\s*$/.test(trimmed)) {
        return true;
      }
      if (/(^|[^\\])&/.test(trimmed)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  // Lines above \begin{document} of the file the engine ran on never reach a
  // page themselves: what their macros typeset is filed under the line that
  // uses them. (Only that file: a chapter may show \begin{document} in a
  // verbatim example.)
  const isPreambleLine = (sourcePath, lineNumber, given = null) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1) return false;
    try {
      const lines = sourceLines(sourcePath, given);
      const begin = lines.findIndex((line) => /^[^%]*\\begin\s*\{document\}/.test(line));
      return begin >= 0 && lineNumber - 1 < begin;
    } catch {
      return false;
    }
  };

  // The line whose output a jump from `lineNumber` should show, and whether
  // to show where that output ends (`toEnd`) rather than where it begins. A
  // blank or closing line ends what precedes it; a comment or an opening
  // line (\begin, \label, a rule) introduces what follows. Their own SyncTeX
  // records are no guide: TeX breaks the page while reading the blank line
  // after a paragraph, so that line carries the finished page's head and folio.
  const jumpAnchorLine = (sourcePath, lineNumber, given = null) => {
    let lines;
    try {
      lines = sourceLines(sourcePath, given);
    } catch {
      return { line: lineNumber, toEnd: false };
    }
    const text = (n) => (lines[n - 1] ?? "").trim();
    const quiet = (t) => !t || t.startsWith("%");
    // Table rows and captions are output of their own, not markers. A page
    // break command ends what is before it; its own records are only the
    // head and folio of the page it ships.
    const closing = (t) =>
      /^\\end\b/.test(t) ||
      /^\\\\(\[[^\]]*\])?$/.test(t) ||
      /^\\(?:clearpage|cleardoublepage|newpage|pagebreak)\b/.test(t);
    const opening = (t) =>
      /^\\(?:begin|label|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(t);
    // A heading's text is filed under the line after it (TeX reads ahead to
    // finish the heading), so the blank line after one belongs to it.
    const heading = (t) =>
      /^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]/.test(t);
    const own = text(lineNumber);
    const comment = own.startsWith("%");
    const reach = 80;
    // A heading's text is filed under its own line or, as TeX reads ahead to
    // finish it, under the next one; its own line may also carry the head
    // and folio of the page \chapter's \clearpage ships.
    if (heading(own)) return { line: lineNumber, toEnd: false, heading: lineNumber };
    if (!comment && (!own || closing(own))) {
      for (let n = lineNumber - 1; n >= 1 && n >= lineNumber - reach; n -= 1) {
        const t = text(n);
        if (quiet(t) || closing(t)) continue;
        if (heading(t) && !own && n === lineNumber - 1) return { line: n, toEnd: false, heading: n };
        return { line: n, toEnd: !heading(t) };
      }
    } else if (comment || opening(own)) {
      for (let n = lineNumber + 1; n <= lines.length && n <= lineNumber + reach; n += 1) {
        const t = text(n);
        if (!quiet(t) && !opening(t)) return { line: n, toEnd: false };
      }
    }
    return { line: lineNumber, toEnd: false };
  };

  // The file an \input / \include / \subfile line reads, if it exists. TeX
  // resolves the name against the directory it runs in: the project root,
  // which is also the PDF's unless the build writes to an output directory.
  const includedFileOnLine = (sourcePath, lineNumber, baseDirs, given = null) => {
    let text;
    try {
      text = sourceLines(sourcePath, given)[lineNumber - 1];
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    const code = text.replace(/(^|[^\\])%.*$/, "$1");
    const match = /\\(?:input|include|subfile)\s*\{([^}]+)\}/.exec(code);
    if (!match) return null;
    const name = match[1].trim();
    for (const base of baseDirs) {
      for (const candidate of [name, `${name}.tex`]) {
        const full = path.resolve(base, candidate);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          // try the next spelling or directory
        }
      }
    }
    return null;
  };

  // Which paper a PDF path holds now: its SyncTeX and the PDF itself. A Build
  // writes into a staging folder and swaps both in at its very end
  // (build/pdf-output.cjs), so until then this is the previous Build's paper.
  const paperIdentity = (pdfPath) => {
    const parts = [];
    for (const file of [pdfPath.replace(/\.pdf$/i, ".synctex.gz"), pdfPath.replace(/\.pdf$/i, ".synctex"), pdfPath]) {
      try {
        const stats = fs.statSync(file);
        parts.push(`${stats.mtimeMs}:${stats.size}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  };

  const readMtimeMs = (targetPath) => {
    if (!targetPath || typeof targetPath !== "string") {
      return 0;
    }
    try {
      const stats = fs.statSync(targetPath);
      const value = Number(stats?.mtimeMs);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
      return 0;
    } catch {
      return 0;
    }
  };

  const buildSynctexForwardCacheKey = ({ sourcePath, pdfPath, line, column }) =>
    `${sourcePath}::${pdfPath}::${Math.floor(line)}:${Math.floor(column)}`;

  const pruneSynctexForwardCache = (now = Date.now()) => {
    const maxAgeMs = 8000;
    for (const [key, entry] of synctexForwardResultCache.entries()) {
      if (!entry || now - entry.timestamp > maxAgeMs) {
        synctexForwardResultCache.delete(key);
      }
    }
    const maxEntries = 160;
    if (synctexForwardResultCache.size <= maxEntries) {
      return;
    }
    const entries = Array.from(synctexForwardResultCache.entries()).sort(
      (left, right) => (left[1]?.timestamp ?? 0) - (right[1]?.timestamp ?? 0)
    );
    while (synctexForwardResultCache.size > maxEntries && entries.length > 0) {
      const oldest = entries.shift();
      if (!oldest) {
        break;
      }
      synctexForwardResultCache.delete(oldest[0]);
    }
  };

  const getCachedSynctexForwardResult = ({
    sourcePath,
    pdfPath,
    line,
    column,
  }) => {
    const now = Date.now();
    pruneSynctexForwardCache(now);
    const key = buildSynctexForwardCacheKey({ sourcePath, pdfPath, line, column });
    const entry = synctexForwardResultCache.get(key);
    if (!entry) {
      return null;
    }
    if (now - entry.timestamp > 1200) {
      synctexForwardResultCache.delete(key);
      return null;
    }
    const sourceMtimeMs = readMtimeMs(sourcePath);
    if (entry.paper !== paperIdentity(pdfPath) || entry.sourceMtimeMs !== sourceMtimeMs) {
      synctexForwardResultCache.delete(key);
      return null;
    }
    const cached = {
      ok: true,
      page: entry.page,
      x: entry.x,
      y: entry.y,
      fallback: entry.fallback === true,
      cached: true,
    };
    if (Number.isFinite(entry.blockX)) cached.blockX = entry.blockX;
    if (Number.isFinite(entry.blockY)) cached.blockY = entry.blockY;
    if (Array.isArray(entry.blocks)) cached.blocks = entry.blocks;
    if (Number.isFinite(entry.blockWidth) && entry.blockWidth > 0) cached.blockWidth = entry.blockWidth;
    if (Number.isFinite(entry.blockHeight) && entry.blockHeight > 0) cached.blockHeight = entry.blockHeight;
    if (entry.direction === "tate") cached.direction = "tate";
    return cached;
  };

  const setCachedSynctexForwardResult = ({
    sourcePath,
    pdfPath,
    line,
    column,
    result,
  }) => {
    if (!result || result.ok !== true) {
      return;
    }
    if (
      !Number.isFinite(result.page) ||
      !Number.isFinite(result.x) ||
      !Number.isFinite(result.y)
    ) {
      return;
    }
    const key = buildSynctexForwardCacheKey({ sourcePath, pdfPath, line, column });
	    const cacheEntry = {
	      timestamp: Date.now(),
	      page: result.page,
	      x: result.x,
	      y: result.y,
	      fallback: result.fallback === true,
	      paper: paperIdentity(pdfPath),
	      sourceMtimeMs: readMtimeMs(sourcePath),
	    };
	    if (Number.isFinite(result.blockX)) cacheEntry.blockX = result.blockX;
	    if (Number.isFinite(result.blockY)) cacheEntry.blockY = result.blockY;
	    if (Array.isArray(result.blocks)) cacheEntry.blocks = result.blocks;
	    if (Number.isFinite(result.blockWidth) && result.blockWidth > 0) cacheEntry.blockWidth = result.blockWidth;
	    if (Number.isFinite(result.blockHeight) && result.blockHeight > 0) cacheEntry.blockHeight = result.blockHeight;
	    if (result.direction === "tate") cacheEntry.direction = "tate";
	    synctexForwardResultCache.set(key, cacheEntry);
	    pruneSynctexForwardCache();
	  };

	  // source "recheck": the viewer asks again, once the PDF a Build made is on
	  // screen, for the line of a Jump made while that Build ran (pdf-viewer.js
	  // recheckBuildJump: "jump-recheck" -> "sync" with its `recheckToken`).
	  // Answered from that PDF only (`pdfPath`), from the text that Build read,
	  // never from Live, never with a Build or a notice; nothing when the line
	  // is not found or that PDF is no longer the last Build's.
	  const handleSynctexForward = async (message) => {
	    const isRecheck = message?.source === "recheck";
	    const generation = isRecheck ? ++recheckGeneration : ++synctexForwardGeneration;
	    const isStaleRequest = () => generation !== (isRecheck ? recheckGeneration : synctexForwardGeneration);
	    // Every answer but a re-check's place (deliverRecheck): a re-check
	    // that finds nothing says nothing.
	    const reply = (payload) => {
	      if (!isRecheck) sendToRenderer("synctex:forwardResult", payload);
	    };
	    const requestId =
	      typeof message?.requestId === "string" && message.requestId.trim()
        ? message.requestId
        : null;
    let redirected = null;
    const withRequestId = (payload) => ({
      ...payload,
      ...(redirected && payload?.ok ? { sourcePath: redirected.path, sourceLine: redirected.line } : {}),
      ...(requestId ? { requestId } : {}),
    });
    const forwardSource =
      typeof message?.source === "string" && message.source.trim()
        ? message.source.trim()
        : "other";
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      reply(withRequestId({
        ok: false,
        error: "No workspace is selected.",
      }));
      return;
    }
    // The caret's file as the editor has it: its line number is that text's,
    // not the file's on disk (autosave trails it) nor the last Build's.
    const editorText = typeof message.text === "string" ? message.text : null;
    // A line that only reads a file means the start of that file. The
    // document is still the one the line belongs to. Which file it reads is
    // the one the Build of that document reads (its folder, and the bases
    // \import, \subimport and \subfile set): known once the document is
    // (redirectInputLine, below).
    let inputTarget = null;
    let sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    let line = Number.parseInt(message.line, 10);
    let column = Number.parseInt(message.column, 10);
    let targetLine = Number.isFinite(line) ? line : 1;
    let targetColumn = Number.isFinite(column) ? column : 1;
    let inputLineResolved = forwardSource !== "manual";
    const redirectInputLine = async (documentFile = null) => {
      if (inputLineResolved) return;
      inputLineResolved = true;
      let includes = null;
      if (documentFile && workspace && typeof message.path === "string") {
        try { includes = await resolveIncludesOf(workspace, documentFile, message.path); } catch { includes = null; }
      }
      inputTarget = resolveInputLineTarget(rootPath, message.path, message.line, {
        lineText: editorText === null ? null : splitLines(editorText)[Number.parseInt(message.line, 10) - 1] ?? "",
        includes,
      });
      if (!inputTarget) return;
      sourcePath = resolveWorkspacePathFromRoot(rootPath, inputTarget.path);
      redirected = inputTarget;
      line = Number.parseInt(inputTarget.line, 10);
      column = 1;
      targetLine = Number.isFinite(line) ? line : 1;
      targetColumn = 1;
    };
    const viewerMode = message.pdfViewerMode === "tab" ? "tab" : "window";
    const allowFallback = message.fallbackToTop !== false;
    // What the viewer has on screen: the Live paper (true), or a static PDF
    // (false: Live off, or the paper a Build holds) on which Live's page
    // numbers mean nothing. The window is known here; a tab viewer is told
    // by the renderer (null: a renderer that does not say).
    const livePaper = isRecheck ? false : viewerMode === "window"
      ? Boolean(pdfWindowManager.matchingLivePreview?.()) && pdfWindowManager.livePreview?.hold !== true
      : typeof message.livePaper === "boolean" ? message.livePaper : null;
    // The source line the Live frame refines a Jump from (current revision).
    const liveSourceFields = () => {
      const file = sourcePath ? resolveWorkspaceRelativePath(rootPath, sourcePath) : null;
      return file
        ? { sourceFile: file.split(path.sep).join("/"), sourceLine: targetLine, sourceColumn: targetColumn }
        : {};
    };

    // A Jump the last Build cannot answer (no Build, or a file or line it
    // does not have) is answered from the paper Live shows, when Live shows
    // this document: its status mark is green only once the canonical pass
    // of the current source exists, and that is what is asked here.
    const askLive = async ({ waitMs = LIVE_JUMP_WAIT_MS, answerWithinMs = null, documentPath = null, statusOnly = false } = {}) => {
      if (forwardSource === "auto-build" || typeof getLiveEngine !== "function" || (livePaper === false && !statusOnly)) return null;
      if (!sourcePath || !sourcePath.toLowerCase().endsWith(".tex")) return null;
      let engine = null;
      try { engine = getLiveEngine(); } catch { engine = null; }
      if (typeof engine?.jumpToSource !== "function") return null;
      try {
        return await engine.jumpToSource({
          projectRoot: rootPath,
          filePath: sourcePath,
          line: targetLine,
          waitMs,
          answerWithinMs,
          documentPath,
          statusOnly,
          isCurrent: () => !isStaleRequest(),
        });
      } catch {
        return null;
      }
    };
    const showLiveSync = (livePdfPath, sync) => {
      if (viewerMode !== "window") return;
      pdfWindowManager.show(livePdfPath, { reload: false });
      pdfWindowManager.queueSync(sync);
    };
    const deliverLive = (live) => {
      const livePdfPath = live.rootPath.replace(/\.tex$/i, ".pdf");
      const left = Math.min(...live.boxes.map((box) => box.left));
      const top = Math.min(...live.boxes.map((box) => box.top));
      const right = Math.max(...live.boxes.map((box) => box.right));
      const bottom = Math.max(...live.boxes.map((box) => box.bottom));
      const answer = {
        page: live.page,
        x: left,
        y: (top + bottom) / 2,
        blockX: left,
        blockY: top,
        blockWidth: right - left,
        blockHeight: bottom - top,
        ...(live.boxes.length > 1 ? {
          blocks: live.boxes.slice(0, 32).map((box) => ({
            x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top,
          })),
        } : {}),
        ...(Number.isSafeInteger(live.livePage) ? { livePage: live.livePage } : {}),
        // the Live revision this place is of (goto-sync `liveRevision`)
        ...(live.revision ? { liveRevision: live.revision } : {}),
        // vertical writing: the boxes are columns
        ...(live.direction === "tate" ? { direction: "tate" } : {}),
      };
      showLiveSync(livePdfPath, { ...answer, ...liveSourceFields() });
      reply(withRequestId({
        ok: true,
        ...answer,
        fallback: false,
        live: true,
        pdfPath: resolveWorkspaceRelativePath(rootPath, livePdfPath),
      }));
    };
    // Live's current revision has no ink for a line of the root's preamble:
    // the first page stands in for it, as it does for the Build.
    const deliverLiveNotTypeset = (live) => {
      const livePdfPath = live.rootPath.replace(/\.tex$/i, ".pdf");
      if (!allowFallback) {
        reply(withRequestId({
          ok: false, error: "This line does not appear in the PDF.", notTypeset: true,
        }));
        return;
      }
      showLiveSync(livePdfPath, { page: 1, x: 0, y: 0, marker: false });
      reply(withRequestId({
        ok: true, page: 1, x: 0, y: 0, fallback: true, notTypeset: true, live: true,
        pdfPath: resolveWorkspaceRelativePath(rootPath, livePdfPath),
      }));
    };
    // true: answered here (or a newer Jump took over); false: the Build's
    // answer stands. `noBuild`: the refusal is that no Build paper exists.
    // `buildNotTypeset`: the Build's answer is already "not typeset".
    // The Build profile in use writes no SyncTeX (`-synctex=0` among its
    // arguments): a Build cannot give this document's PDF positions.
    const profileDisablesSynctex = async () => {
      try {
        // While the realtime preview runs, Build drops a profile's
        // `-synctex=0` (latexmk.cjs keepSynctexForLive), so a Build does help.
        let live = null;
        try { live = typeof getLiveEngine === "function" ? getLiveEngine() : null; } catch { live = null; }
        if (live?.isRunning?.() === true) return false;
        const settings = await workspace?.loadSettings?.();
        const id = typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
        const profile = id && Array.isArray(settings?.buildProfiles)
          ? settings.buildProfiles.find((entry) => entry && entry.id === id) : null;
        return /(?:^|\s)--?synctex=0(?:\s|$)/.test(String(profile?.extraArgs ?? ""));
      } catch {
        return false;
      }
    };
    // No paper to answer from, and Live has no answer either. A Jump of the
    // reader's builds the document once and jumps on its PDF (NEEDS_BUILD; a
    // null targetFile lets the Build resolve the document from the active
    // file, as the Build button does). Not when no Build can give positions:
    // the profile turns SyncTeX off (SYNCTEX_DISABLED, the notice without
    // its Build action), or the current source does not compile (Live's
    // pass failed: the notice, whose Build action shows the error).
    const refuseWithoutPaper = async ({ pdfExists, targetFile, fallback = null }) => {
      const notice = pdfExists ? "SyncTeX data was not found." : "PDF has not been generated yet.";
      // (other Jumps answer as they did: only the reader's own starts a Build)
      if (forwardSource !== "manual") {
        reply(withRequestId(fallback ?? (targetFile
          ? { ok: false, code: "NEEDS_BUILD", targetFile }
          : { ok: false, error: notice })));
        return;
      }
      if (pdfExists && await profileDisablesSynctex()) {
        if (isStaleRequest()) return;
        reply(withRequestId({ ok: false, code: "SYNCTEX_DISABLED", error: "SyncTeX data was not found." }));
        return;
      }
      // A held Build PDF can't use Live coordinates. The active engine can
      // still report a compile error for the document we're about to build.
      const status = lastLive ?? (livePaper === false && jumpDocumentPath
        ? await askLive({ documentPath: jumpDocumentPath, statusOnly: true })
        : null);
      if (isStaleRequest()) return;
      if (status?.status === "failed") {
        reply(withRequestId({ ok: false, error: notice }));
        return;
      }
      reply(withRequestId({ ok: false, code: "NEEDS_BUILD", targetFile: targetFile ?? null }));
    };
    // Live's last word on this Jump ("failed": the current source does not
    // compile, so a Build would fail the same way).
    let lastLive = null;
    const answerFromLive = async ({ noBuild = false, buildNotTypeset = false } = {}) => {
      const live = await askLive({ documentPath: jumpDocumentPath });
      lastLive = live;
      if (isStaleRequest()) return true;
      if (live?.status === "hit") {
        deliverLive(live);
        return true;
      }
      // Live's current pass typeset nothing for this line (the engine says
      // so), or, from an engine that does not say, a line of the root's
      // preamble: "not typeset", as the Build would say, without a Build.
      const notTypeset = live?.status === "miss" && !buildNotTypeset && (live.notTypeset === true ||
        (noBuild && path.resolve(sourcePath) === path.resolve(live.rootPath) &&
          isPreambleLine(sourcePath, targetLine, editorText === null || redirected ? null : splitLines(editorText))));
      if (notTypeset) {
        deliverLiveNotTypeset(live);
        return true;
      }
      return false;
    };

    // Which document's PDF: the one a Build of this file would write. An
    // explicit pdfPath (a tex64:// link, an older caller) is honoured as is.
    let pdfPath = message.pdfPath ? resolveWorkspacePathFromRoot(rootPath, message.pdfPath) : null;
    // the document a Build of this file makes (for Live: is it the one shown)
    let jumpDocumentPath = null;
    if (!pdfPath && sourcePath && typeof resolveJumpDocument === "function" &&
        sourcePath.toLowerCase().endsWith(".tex")) {
      const exactTarget = typeof message.documentMainFile === "string" && message.documentMainFile.trim()
        ? message.documentMainFile.trim() : null;
      let document = null;
      try {
        document = await resolveJumpDocument(message.path, { exactTarget });
      } catch (error) {
        if (error?.code === "BUILD_TARGET_CHOICE" && Array.isArray(error.candidates)) {
          reply(withRequestId({
            ok: false,
            code: "CHOOSE_TARGET",
            requested: error.requested || message.path,
            candidates: error.candidates.map((file) => String(file).split(path.sep).join("/")),
          }));
          return;
        }
        document = null;
      }
      if (isStaleRequest()) return;
      await redirectInputLine(document?.targetFile ?? null);
      if (isStaleRequest()) return;
      if (typeof document?.targetFile === "string" && document.targetFile) {
        jumpDocumentPath = resolveWorkspacePathFromRoot(rootPath, document.targetFile);
      }
      if (document && !document.built) {
        if (await answerFromLive({ noBuild: true })) return;
        // Nothing to jump into yet: the renderer builds this document and
        // asks again once its PDF exists (refuseWithoutPaper).
        await refuseWithoutPaper({
          pdfExists: Boolean(document.pdfPath && fs.existsSync(document.pdfPath)),
          targetFile: document.targetFile,
        });
        return;
      }
      pdfPath = document?.pdfPath ?? null;
    }
    await redirectInputLine();
    if (isStaleRequest()) return;
    if (!pdfPath) pdfPath = state.lastBuildPdfPath;
    if (!sourcePath) {
      reply(withRequestId({
        ok: false,
        error: "No TeX file selected.",
      }));
      return;
    }
    if (!sourcePath.toLowerCase().endsWith(".tex")) {
      reply(withRequestId({
        ok: false,
        error: "SyncTeX only supports TeX files.",
      }));
      return;
    }
    // A re-check is about the PDF on screen, and only while it is the last
    // Build's: a Build started since, or one that has replaced it, has
    // superseded it.
    if (isRecheck) {
      if (!message.pdfPath || !pdfPath || buildSources?.running?.(pdfPath) ||
          typeof buildSources?.isLastBuildPaper !== "function" || !(await buildSources.isLastBuildPaper(pdfPath))) return;
      if (isStaleRequest()) return;
    }
    // The place of a re-check, to the viewer that asked (with its token).
    const deliverRecheck = (place) => {
      const sync = { page: place.page, x: place.x, y: place.y, recheckToken: message.recheckToken };
      for (const key of ["blockX", "blockY"]) if (Number.isFinite(place[key])) sync[key] = place[key];
      for (const key of ["blockWidth", "blockHeight"]) if (Number.isFinite(place[key]) && place[key] > 0) sync[key] = place[key];
      if (Array.isArray(place.blocks) && place.blocks.length > 1) sync.blocks = place.blocks.slice(0, 32);
      if (place.fallback === true) sync.approximate = true;
      if (place.direction === "tate") sync.direction = "tate";
      if (viewerMode === "window") {
        if (pdfWindowManager.currentPath && path.resolve(pdfWindowManager.currentPath) === path.resolve(pdfPath)) {
          pdfWindowManager.queueSync(sync);
        }
        return;
      }
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: true, ...sync, pdfPath: resolveWorkspaceRelativePath(rootPath, pdfPath),
      }));
    };
    if (!pdfPath) {
      if (await answerFromLive({ noBuild: true })) return;
      // (the document could not be told before a Build: the Build resolves
      // it, after saving, as the Build button does)
      await refuseWithoutPaper({ pdfExists: false, targetFile: null });
      return;
    }
    if (isStaleRequest()) {
      return;
    }
    // Live shows this document and its canonical pass is of the current
    // source (the mark is green): its answer is the line on the paper now,
    // and the viewer lands there in one movement. While the mark is red or
    // orange (that pass failed, is behind, or the engine is down) it has no
    // answer, and the Build answers below.
    if (jumpDocumentPath && livePaper === true) {
      const live = await askLive({ waitMs: 0, answerWithinMs: LIVE_FIRST_BUDGET_MS, documentPath: jumpDocumentPath });
      if (isStaleRequest()) return;
      if (live?.status === "hit") {
        deliverLive(live);
        return;
      }
    }
    // The paper this answer is read from. A Build of it that finishes
    // meanwhile swaps in another (retriedAfterSwap).
    const paperAtStart = paperIdentity(pdfPath);
    const retriedAfterSwap = async () => {
      if (message.afterSwap === true || paperIdentity(pdfPath) === paperAtStart) return false;
      // (a re-check is of the paper it was asked about: that one is gone)
      if (isRecheck) return true;
      // The Build finished while this Jump was answered from the paper
      // before it. That paper is gone from the screen: answer again from the
      // one that replaces it, once the viewer has it (after the Build's
      // success has gone out), so the Jump lands once, on the new paper.
      if (typeof buildSources?.whenSettled === "function") {
        await buildSources.whenSettled({ timeoutMs: 15_000 });
      }
      if (isStaleRequest()) return true;
      void handleSynctexForward({ ...message, afterSwap: true });
      return true;
    };
    // The Build's SyncTeX numbers the lines as that Build read them: carry
    // the caret's line (the editor's) into that numbering. A line written
    // since, or a file whose Build text is not known, is answered "about
    // here" (fallback), never as the exact line.
    let buildLine = targetLine;
    let buildColumn = targetColumn;
    let buildLines = null;
    let shiftedSinceBuild = false;
    if (buildSources && typeof buildSources.sourceFor === "function") {
      let builtText = null;
      try { builtText = await buildSources.sourceFor({ pdfPath, sourcePath }); } catch { builtText = null; }
      if (isStaleRequest()) return;
      let currentText = redirected ? null : editorText;
      if (currentText === null) {
        try { currentText = fs.readFileSync(sourcePath, "utf8"); } catch { currentText = null; }
      }
      if (typeof builtText === "string" && typeof currentText === "string") {
        if (lastBuildSource?.text !== builtText) lastBuildSource = { text: builtText, lines: splitLines(builtText) };
        buildLines = lastBuildSource.lines;
        if (builtText !== currentText) {
          const mapped = mapSourceLine(splitLines(currentText), buildLines, targetLine);
          buildLine = mapped.line;
          if (!mapped.exact) {
            shiftedSinceBuild = true;
            buildColumn = 1;
          }
        }
      } else if (typeof currentText === "string") {
        shiftedSinceBuild = true;
      }
    }
    const cached = getCachedSynctexForwardResult({
      sourcePath,
      pdfPath,
      line: buildLine,
      column: buildColumn,
    });
    if (cached && await retriedAfterSwap()) return;
    if (cached && isRecheck) {
      deliverRecheck({ ...cached, fallback: cached.fallback === true || shiftedSinceBuild });
      return;
    }
    if (cached) {
      if (viewerMode === "window") {
        pdfWindowManager.show(pdfPath, { reload: false });
        const windowCachedSync = { page: cached.page, x: cached.x, y: cached.y };
        if (Number.isFinite(cached.blockX)) windowCachedSync.blockX = cached.blockX;
        if (Number.isFinite(cached.blockY)) windowCachedSync.blockY = cached.blockY;
        if (Array.isArray(cached.blocks)) windowCachedSync.blocks = cached.blocks;
        if (Number.isFinite(cached.blockWidth) && cached.blockWidth > 0) windowCachedSync.blockWidth = cached.blockWidth;
        if (Number.isFinite(cached.blockHeight) && cached.blockHeight > 0) windowCachedSync.blockHeight = cached.blockHeight;
        // as the tab viewer is told (build-ops-ui): a neighbour's place is
        // "about here", and a Live frame refines from the source line
        if (cached.fallback === true || shiftedSinceBuild) windowCachedSync.approximate = true;
        if (cached.direction === "tate") windowCachedSync.direction = "tate";
        Object.assign(windowCachedSync, liveSourceFields());
        pdfWindowManager.queueSync(windowCachedSync);
      }
      synctexService.registerForwardHint({
        pdfPath,
        page: cached.page,
        x: cached.x,
        y: cached.y,
        sourcePath,
        line: targetLine,
        column: targetColumn,
      });
      const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
      const cachedPayload = {
        ok: true,
        page: cached.page,
        x: cached.x,
        y: cached.y,
        fallback: cached.fallback === true || shiftedSinceBuild,
        ...(cached.direction === "tate" ? { direction: "tate" } : {}),
        cached: true,
        pdfPath: relativePdfPath,
      };
      if (Number.isFinite(cached.blockX)) cachedPayload.blockX = cached.blockX;
      if (Number.isFinite(cached.blockY)) cachedPayload.blockY = cached.blockY;
      if (Array.isArray(cached.blocks)) cachedPayload.blocks = cached.blocks;
      if (Number.isFinite(cached.blockWidth) && cached.blockWidth > 0) cachedPayload.blockWidth = cached.blockWidth;
      if (Number.isFinite(cached.blockHeight) && cached.blockHeight > 0) cachedPayload.blockHeight = cached.blockHeight;
      reply(withRequestId(cachedPayload));
      return;
    }
    const isRetryableSynctexError = (error) =>
      typeof error === "string" &&
      (error.includes("position") || error.includes("parsing failed"));
    const getForwardTargetDiff = (forwardResult, expectedLine) => {
      if (!forwardResult || forwardResult.ok !== true || !Number.isFinite(expectedLine)) {
        return Number.POSITIVE_INFINITY;
      }
      if (forwardResult.sameSourcePath === true && Number.isFinite(forwardResult.matchedLine)) {
        return Math.abs(forwardResult.matchedLine - expectedLine);
      }
      return Number.POSITIVE_INFINITY;
    };
    const isLowQualityForwardResult = (forwardResult, expectedLine = buildLine) => {
      if (!forwardResult || forwardResult.ok !== true) {
        return false;
      }
      const targetDiff = getForwardTargetDiff(forwardResult, expectedLine);
      if (Number.isFinite(targetDiff)) {
        return targetDiff > 1;
      }
      if (forwardResult.sameSourcePath === false) {
        return true;
      }
      if (Number.isFinite(forwardResult.matchDiff)) {
        return forwardResult.matchDiff > 1;
      }
      return false;
    };

    const runForward = async (forwardLine, forwardColumn, narrowing = {}) => {
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      let result = await synctexService.forward({
        sourcePath,
        line: Number.isFinite(forwardLine) ? forwardLine : 1,
        column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
        pdfPath,
        hintLine: targetLine,
        hintColumn: targetColumn,
        registerHint: false,
        ...narrowing,
      });
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      if (result.ok || !isRetryableSynctexError(result.error)) {
        return result;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        await delay(200);
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        result = await synctexService.forward({
          sourcePath,
          line: Number.isFinite(forwardLine) ? forwardLine : 1,
          column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
          pdfPath,
          hintLine: targetLine,
          hintColumn: targetColumn,
          registerHint: false,
          ...narrowing,
        });
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        if (result.ok || !isRetryableSynctexError(result.error)) {
          break;
        }
      }
      return result;
    };

    const preferBacktrack = isSkippableSynctexLine(sourcePath, buildLine, buildLines);
    // Which nearby line left ink is a memory read from the SyncTeX index.
    // Probing the neighbours one `synctex view` process at a time took
    // 6–27 s from a preamble line and held up the next Jump meanwhile, so
    // the CLI now runs once, on the line the index picked, for its block box.
    // null: the index could not answer; the process probes below still can.
    const resolveFromIndex = async () => {
      if (typeof synctexService.forwardLinesQuick !== "function") return null;
      let quick;
      let anchor = { line: buildLine, toEnd: false };
      try {
        // The line that prints the index: where the index starts.
        const ownLine = String(sourceLines(sourcePath, buildLines)[buildLine - 1] ?? "")
          .replace(/(^|[^\\])%.*$/, "$1");
        if (/\\printindex\b/.test(ownLine) && typeof synctexService.forwardIndexStart === "function") {
          const start = synctexService.forwardIndexStart({ pdfPath });
          if (start) return { ok: true, page: start.page, x: start.x, y: start.y, fallback: true };
        }
        anchor = jumpAnchorLine(sourcePath, buildLine, buildLines);
        // An \input / \include line stands for the file it reads: go to
        // where that file's output begins (or ends, from the blank line
        // after it). The line itself only marks where TeX came back from
        // the file, often the last page.
        const included = includedFileOnLine(sourcePath, anchor.line, [
          rootPath,
          path.dirname(pdfPath),
          path.dirname(sourcePath),
        ], buildLines);
        if (included) {
          let lastLine = 1;
          try {
            lastLine = fs.readFileSync(included, "utf8").split(/\r?\n/).length;
          } catch {
            // start of the file then
          }
          const inner = synctexService.forwardLinesQuick({
            sourcePath: included,
            pdfPath,
            lines: [anchor.toEnd ? lastLine : 1],
            preferAbove: anchor.toEnd,
            firstSubstantialPage: !anchor.toEnd,
            lastSubstantialPage: anchor.toEnd,
          });
          const innerHit = inner?.ok ? inner.results?.[0] : null;
          if (innerHit?.found) {
            return { ok: true, page: innerHit.page, x: innerHit.x, y: innerHit.y, fallback: true,
              ...(innerHit.direction === "tate" ? { direction: "tate" } : {}) };
          }
        }
        const ownedMarker = (line, toEnd) => synctexService.forwardOwnedMarker?.({
          pdfPath, sourcePath, line, lines: buildLines, toEnd,
        });
        const ownBox = ownedMarker(buildLine, false);
        const box = ownBox ?? (anchor.line !== buildLine ? ownedMarker(anchor.line, anchor.toEnd) : null);
        if (box) {
          const focus = !ownBox && anchor.toEnd ? box.rects.at(-1) : box.rects[0];
          return {
            ok: true, page: box.page, x: focus.x + focus.width / 2, y: focus.y + focus.height / 2,
            fallback: !ownBox, direction: box.direction,
            ownedMarker: true,
            blockX: box.x, blockY: box.y, blockWidth: box.width, blockHeight: box.height,
            ...(box.pageRects
              ? { blocks: box.pageRects.flatMap(({ page, rects }) => rects.map((rect) => ({ ...rect, page }))) }
              : box.rects.length > 1 ? { blocks: box.rects } : {}),
          };
        }
        if (anchor.heading) {
          // The heading is on the later of: the last page its own line
          // reaches (after any page it shipped) and the first page of the
          // next line's records, when that line has any.
          const own = synctexService.forwardLinesQuick({
            sourcePath,
            pdfPath,
            lines: [anchor.heading],
            lastSubstantialPage: true,
          });
          const next = synctexService.forwardLinesQuick({
            sourcePath,
            pdfPath,
            lines: [anchor.heading + 1],
            firstSubstantialPage: true,
          });
          const ownHit = own?.ok ? own.results?.[0] : null;
          const nextHit = next?.ok ? next.results?.[0] : null;
          const candidates = [
            ownHit?.found && ownHit.matchedLine === anchor.heading ? ownHit : null,
            nextHit?.found && nextHit.matchedLine === anchor.heading + 1 ? nextHit : null,
          ].filter(Boolean);
          if (candidates.length > 0) {
            const best = candidates.reduce((a, b) => (b.page > a.page ? b : a));
            quick = { ...own, ok: true, isRootFile: own?.isRootFile, results: [best] };
          }
        }
        quick ??= synctexService.forwardLinesQuick({
          sourcePath,
          pdfPath,
          lines: [anchor.line],
          preferAbove: anchor.toEnd,
          firstSubstantialPage: !anchor.toEnd,
          lastSubstantialPage: anchor.toEnd,
        });
      } catch {
        return null;
      }
      if (!quick?.ok) {
        // The PDF's SyncTeX was read and this file is not in it: no other
        // line of it can do better. Without the PDF or its SyncTeX file the
        // `synctex` process cannot either (its retries over 60 neighbouring
        // lines took most of a minute to say so).
        return ["The file is not part of this PDF.", "PDF not found.", "SyncTeX data was not found."].includes(quick?.error)
          ? { ok: false, error: quick.error } : null;
      }
      const hit = quick.results?.[0];
      if (!hit) return null;
      const inPreamble = quick.isRootFile === true && isPreambleLine(sourcePath, buildLine, buildLines);
      if (!hit.found || (inPreamble && hit.matchedLine !== buildLine)) {
        // Nothing near this line reaches the page (the preamble, say).
        return allowFallback
          ? { ok: true, page: 1, x: 0, y: 0, fallback: true, notTypeset: true }
          : { ok: false, error: "This line does not appear in the PDF.", notTypeset: true };
      }
      const line = hit.matchedLine;
      const fallback = line !== buildLine || anchor.line !== buildLine;
      // A column of vertical writing: the synctex process answers in the tate
      // box's unturned frame (a band across the top of the page), the index
      // on the page. Its place and its columns (marker box) are the index's.
      if (hit.direction === "tate") return { ok: true, page: hit.page, x: hit.x, y: hit.y, fallback, direction: "tate" };
      // The first box on the page the index picked is where that line's
      // output begins there; checking more boxes costs one process each.
      const forward = await runForward(line, fallback ? 1 : buildColumn, {
        preferPage: hit.page,
        preferBottom: anchor.toEnd,
        maxVerifiedBlocks: 1,
      });
      if (forward.cancelled) return forward;
      if (forward.ok && !isLowQualityForwardResult(forward, line)) {
        return fallback ? { ...forward, fallback: true } : forward;
      }
      return { ok: true, page: hit.page, x: hit.x, y: hit.y, fallback };
    };
    const indexed = await resolveFromIndex();
    if (isStaleRequest() || indexed?.cancelled === true) {
      return;
    }
    let result = indexed ?? (preferBacktrack
      ? { ok: false, error: "skip" }
      : await runForward(buildLine, buildColumn));
    let bestLowQualitySuccess =
      !indexed && result.ok && isLowQualityForwardResult(result, buildLine)
        ? {
            result,
            offset: 0,
            matchDiff: getForwardTargetDiff(result, buildLine),
          }
        : null;
    if (!indexed && (preferBacktrack || (!result.ok && isRetryableSynctexError(result.error)))) {
      const maxBacktrack = forwardSource === "manual" ? 60 : 80;
      for (let offset = 1; offset <= maxBacktrack; offset += 1) {
        if (isStaleRequest()) {
          return;
        }
        const candidateLine = buildLine - offset;
        if (candidateLine < 1) {
          break;
        }
        if (isSkippableSynctexLine(sourcePath, candidateLine, buildLines)) {
          continue;
        }
        const candidate = await runForward(candidateLine, buildColumn);
        if (candidate.ok) {
          const candidateLowQuality = isLowQualityForwardResult(candidate, buildLine);
          if (!candidateLowQuality) {
            candidate.fallback = true;
            result = candidate;
            break;
          }
          const candidateMatchDiff = getForwardTargetDiff(candidate, buildLine);
          const candidateScore = {
            result: { ...candidate, fallback: true },
            offset,
            matchDiff: candidateMatchDiff,
          };
          if (!bestLowQualitySuccess) {
            bestLowQualitySuccess = candidateScore;
            continue;
          }
          const currentSamePath = bestLowQualitySuccess.result.sameSourcePath === true;
          const nextSamePath = candidateScore.result.sameSourcePath === true;
          if (nextSamePath && !currentSamePath) {
            bestLowQualitySuccess = candidateScore;
            continue;
          }
          if (nextSamePath === currentSamePath) {
            if (candidateScore.matchDiff < bestLowQualitySuccess.matchDiff) {
              bestLowQualitySuccess = candidateScore;
              continue;
            }
            if (
              candidateScore.matchDiff === bestLowQualitySuccess.matchDiff &&
              candidateScore.offset < bestLowQualitySuccess.offset
            ) {
              bestLowQualitySuccess = candidateScore;
            }
          }
          continue;
        }
        if (!isRetryableSynctexError(candidate.error)) {
          result = candidate;
          break;
        }
      }
    }
    if (!indexed && ((result.ok && isLowQualityForwardResult(result, buildLine)) || !result.ok)) {
      const maxForwardScan = 12;
      for (let offset = 1; offset <= maxForwardScan; offset += 1) {
        if (isStaleRequest()) {
          return;
        }
        const candidateLine = buildLine + offset;
        const candidate = await runForward(candidateLine, buildColumn);
        if (candidate.ok && !isLowQualityForwardResult(candidate, buildLine)) {
          result = { ...candidate, fallback: true };
          break;
        }
      }
    }
    if (
      !indexed &&
      ((result.ok && isLowQualityForwardResult(result, buildLine)) || !result.ok) &&
      bestLowQualitySuccess?.result?.ok
    ) {
      result = bestLowQualitySuccess.result;
    }
    if (!indexed && result.ok) {
      const exactDiff = getForwardTargetDiff(result, buildLine);
      if (Number.isFinite(exactDiff) && exactDiff > 0) {
        const maxExactScan = 12;
        outerExactScan: for (let offset = 1; offset <= maxExactScan; offset += 1) {
          if (isStaleRequest()) {
            return;
          }
          const candidateLine = buildLine - offset;
          if (candidateLine >= 1) {
            const candidate = await runForward(candidateLine, buildColumn);
            if (candidate.ok && getForwardTargetDiff(candidate, buildLine) === 0) {
              result = { ...candidate, fallback: true };
              break outerExactScan;
            }
          }
          const forwardLine = buildLine + offset;
          const forwardCandidate = await runForward(forwardLine, buildColumn);
          if (forwardCandidate.ok && getForwardTargetDiff(forwardCandidate, buildLine) === 0) {
            result = { ...forwardCandidate, fallback: true };
            break outerExactScan;
          }
        }
      }
    }
    if (!indexed && !result.ok && allowFallback) {
      const fallbackResult = await runForward(1, 1);
      if (fallbackResult.ok) {
        fallbackResult.fallback = true;
      }
      result = fallbackResult;
    }
    if (isStaleRequest() || result?.cancelled === true) {
      return;
    }
    // The last Build has no answer for this line (or not this file, or no
    // SyncTeX at all), or only its first page as a stand-in: what Live
    // shows has the current revision's.
    if (!result.ok || result.notTypeset === true) {
      const noBuild = !result.ok && ["PDF not found.", "SyncTeX data was not found."].includes(result.error);
      if (await answerFromLive({ noBuild, buildNotTypeset: result.ok && result.notTypeset === true })) return;
    }
    if (await retriedAfterSwap()) return;
    // (a re-check of a line not found, or not typeset: no answer, nothing moves)
    if (isRecheck && (!result.ok || result.notTypeset === true)) return;
    if (!result.ok) {
      // The PDF on disk has no SyncTeX (or went away): as with no paper.
      if (["SyncTeX data was not found.", "PDF not found."].includes(result.error)) {
        await refuseWithoutPaper({
          pdfExists: result.error !== "PDF not found.",
          targetFile: jumpDocumentPath ? resolveWorkspaceRelativePath(rootPath, jumpDocumentPath) : null,
          fallback: result,
        });
        return;
      }
      reply(withRequestId(result));
      return;
    }
    // The marker covers every typeset line the source line produced (and the
    // right display row), not SyncTeX's single box (marker-box.cjs).
    if (result.notTypeset !== true && !result.ownedMarker && typeof synctexService.forwardMarkerBox === "function") {
      try {
        const box = synctexService.forwardMarkerBox({
          pdfPath, sourcePath, line: buildLine, page: result.page, x: result.x, y: result.y,
          pageTrusted: Boolean(indexed), ...(buildLines ? { lines: buildLines } : {}),
        });
        if (box && box.width > 0 && box.height > 0) {
          const inside = box.page === result.page && Number.isFinite(result.x) && Number.isFinite(result.y) &&
            result.x >= box.x && result.x <= box.x + box.width && result.y >= box.y && result.y <= box.y + box.height;
          result = {
            ...result,
            page: box.page,
            x: inside ? result.x : box.x,
            y: inside ? result.y : box.y + box.height / 2,
            blockX: box.x,
            blockY: box.y,
            blockWidth: box.width,
            blockHeight: box.height,
            ...(Array.isArray(box.rects) && box.rects.length > 1 ? { blocks: box.rects } : {}),
            ...(box.direction === "tate" ? { direction: "tate" } : {}),
          };
        }
      } catch {
        /* keep SyncTeX's own box */
      }
    }
    if (
      result.notTypeset !== true &&
      Number.isFinite(result.page) &&
      Number.isFinite(result.x) &&
      Number.isFinite(result.y)
    ) {
      synctexService.registerForwardHint({
        pdfPath,
        page: result.page,
        x: result.x,
        y: result.y,
        sourcePath,
        line: targetLine,
        column: targetColumn,
      });
    }
    if (result.notTypeset !== true) {
      setCachedSynctexForwardResult({
        sourcePath,
        pdfPath,
        line: buildLine,
        column: buildColumn,
        result,
      });
    }
    if (isRecheck) {
      deliverRecheck({ ...result, fallback: result.fallback === true || shiftedSinceBuild });
      return;
    }
    if (viewerMode === "window") {
      pdfWindowManager.show(pdfPath, { reload: false });
      const windowSyncPayload = { page: result.page, x: result.x, y: result.y };
      if (result.notTypeset === true) windowSyncPayload.marker = false;
      if (Number.isFinite(result.blockWidth) && result.blockWidth > 0) {
        windowSyncPayload.blockWidth = result.blockWidth;
      }
      if (Number.isFinite(result.blockHeight) && result.blockHeight > 0) {
        windowSyncPayload.blockHeight = result.blockHeight;
      }
      if (Number.isFinite(result.blockX)) {
        windowSyncPayload.blockX = result.blockX;
      }
      if (Number.isFinite(result.blockY)) {
        windowSyncPayload.blockY = result.blockY;
      }
      if (Array.isArray(result.blocks)) windowSyncPayload.blocks = result.blocks;
      // as the tab viewer is told (build-ops-ui): a neighbour's place is
      // "about here", and a Live frame refines from the source line
      if (result.notTypeset !== true) {
        if (result.fallback === true || shiftedSinceBuild) windowSyncPayload.approximate = true;
        if (result.direction === "tate") windowSyncPayload.direction = "tate";
        Object.assign(windowSyncPayload, liveSourceFields());
      }
      pdfWindowManager.queueSync(windowSyncPayload);
    }
    const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
    const forwardPayload = {
      ok: true,
      page: result.page,
      x: result.x,
      y: result.y,
      fallback: result.fallback === true || shiftedSinceBuild,
      pdfPath: relativePdfPath,
    };
    if (result.notTypeset === true) forwardPayload.notTypeset = true;
    if (result.direction === "tate") forwardPayload.direction = "tate";
    if (Number.isFinite(result.blockWidth) && result.blockWidth > 0) {
      forwardPayload.blockWidth = result.blockWidth;
    }
    if (Number.isFinite(result.blockHeight) && result.blockHeight > 0) {
      forwardPayload.blockHeight = result.blockHeight;
    }
    if (Number.isFinite(result.blockX)) {
      forwardPayload.blockX = result.blockX;
    }
    if (Number.isFinite(result.blockY)) {
      forwardPayload.blockY = result.blockY;
    }
    if (Array.isArray(result.blocks)) forwardPayload.blocks = result.blocks;
    reply(withRequestId(forwardPayload));
  };


  /**
   * Many lines of one file against one PDF in a single reply, answered from
   * the in-process SyncTeX index: no process per line, so the AI mode can pin
   * every proposed step to the page the moment the PDF is shown.
   */
  const handleSynctexForwardBatch = (message) => {
    const requestId =
      typeof message?.requestId === "string" && message.requestId.trim() ? message.requestId : null;
    if (!requestId) return;
    const reply = (payload) => sendToRenderer("synctex:forwardBatchResult", { requestId, ...payload });
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      reply({ ok: false, error: "No workspace is selected." });
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath = resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath || !sourcePath.toLowerCase().endsWith(".tex")) {
      reply({ ok: false, error: "No TeX file selected." });
      return;
    }
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      reply({ ok: false, error: "PDF has not been generated yet." });
      return;
    }
    const lines = Array.isArray(message.lines)
      ? message.lines
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value) && value > 0)
          .slice(0, 64)
      : [];
    if (lines.length === 0) {
      reply({ ok: true, results: [] });
      return;
    }
    try {
      const result = synctexService.forwardLinesQuick({ sourcePath, pdfPath, lines });
      reply({ ...result, path: message.path, pdfPath: message.pdfPath });
    } catch (_error) {
      reply({ ok: false, error: "SyncTeX parsing failed." });
    }
  };

  return { handleSynctexForward, handleSynctexForwardBatch };
};

module.exports = { createSynctexForwardHandler };
