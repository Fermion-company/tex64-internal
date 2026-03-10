import { getMathFieldSelectionRange } from "../../../app/blocks/math-input-utils.js";
import { getKeyByLatex, normalizeLatexKey } from "../math-wysiwyg-keymap.js";
import {
  getInternalSelectionRanges,
  indexToOffsetInRange,
  offsetToIndexInRange,
  setSelectionRange,
} from "../math-wysiwyg-selection.js";
import {
  findContainingEnvironmentAtCursor,
  hasEnvironmentInContext,
  isCursorInsideEnvironmentBody,
  readNativeMathfieldEnvironmentContext,
} from "../math-wysiwyg-environment-context.js";
import { setMathfieldMode } from "../../mathfield-private-adapter.js";
import {
  AUX_COMMAND_BARE_RE,
  AUX_COMMAND_BLOCKED_ENV_NAMES,
  AUX_COMMAND_TEMPLATE_RE,
  INTERTEXT_TEMPLATE_RE,
  PLACEHOLDER_TOKEN_REGEX,
} from "./constants.js";
import { clearEditAnchor, nowMs, readMathfieldLatex, resolveCursorOffset, syncMathfieldMode } from "./mathfield.js";
import type { Candidate } from "../math-wysiwyg-triggers.js";
import type { MathWysiwygMruOps } from "./mru.js";
import type { MathWysiwygPanelOps } from "./panel.js";
import type { MathWysiwygRuntime } from "./runtime.js";
import type { TokenMatch } from "./types.js";
import type { MathKey } from "../../../app/types.js";

export type MathWysiwygApplyOps = {
  applyCandidate: (index: number) => void;
};

const toLiteralInsertKey = (key: MathKey): MathKey => ({
  label: key.label ?? key.latex,
  latex: key.latex,
  fallback: key.fallback,
  displayLatex: key.displayLatex,
  hint: key.hint,
});

const findLiteralPlaceholderRange = (
  mathfieldApi: any,
  anchorOffset: number
): { start: number; end: number } | null => {
  const lastOffset =
    typeof mathfieldApi?.lastOffset === "number" && mathfieldApi.lastOffset > 0 ? mathfieldApi.lastOffset : null;
  if (lastOffset === null) {
    return null;
  }
  const latex = readMathfieldLatex(mathfieldApi, 0, lastOffset, "latex");
  if (!latex || !latex.includes("\\placeholder")) {
    return null;
  }
  const anchorIndex = offsetToIndexInRange(mathfieldApi, 0, anchorOffset);
  const regex = new RegExp(PLACEHOLDER_TOKEN_REGEX.source, "g");
  const matches: Array<{ startIndex: number; endIndex: number }> = [];
  let match: RegExpExecArray | null = regex.exec(latex);
  while (match) {
    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;
    matches.push({ startIndex, endIndex });
    match = regex.exec(latex);
  }
  if (matches.length === 0) {
    return null;
  }
  const preferred = matches.find((item) => item.startIndex >= anchorIndex) ?? matches[0];
  const start = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.startIndex, "floor");
  const end = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.endIndex, "ceil");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { start, end };
};

const isCursorInBlockedAuxEnvironment = (mathfieldApi: any, cursorOffset: number) => {
  const nativeContext = readNativeMathfieldEnvironmentContext(mathfieldApi, cursorOffset);
  if (hasEnvironmentInContext(nativeContext, AUX_COMMAND_BLOCKED_ENV_NAMES)) {
    return true;
  }
  const latex = readMathfieldLatex(mathfieldApi, "latex");
  if (!latex) {
    return false;
  }
  const cursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
  return isCursorInsideEnvironmentBody(latex, cursorIndex, AUX_COMMAND_BLOCKED_ENV_NAMES);
};

const insertAuxCommandOutsideBlockedContext = (
  runtime: MathWysiwygRuntime,
  mathfieldApi: any,
  insertedLatex: string,
  cursorOffset: number
) => {
  const sourceLatex = readMathfieldLatex(mathfieldApi, "latex");
  if (typeof sourceLatex !== "string") {
    return false;
  }
  const normalized = normalizeLatexKey(insertedLatex).replace(/#\?/g, "");
  if (!normalized.startsWith("\\")) {
    return false;
  }

  let insertionIndex = sourceLatex.length;
  const cursorIndex =
    typeof cursorOffset === "number" && Number.isFinite(cursorOffset)
      ? offsetToIndexInRange(mathfieldApi, 0, cursorOffset)
      : -1;
  if (cursorIndex >= 0) {
    const blockedEnv = findContainingEnvironmentAtCursor(sourceLatex, cursorIndex, AUX_COMMAND_BLOCKED_ENV_NAMES);
    if (blockedEnv) {
      insertionIndex = blockedEnv.endEnd;
    }
  }

  const before = sourceLatex.slice(0, insertionIndex);
  const after = sourceLatex.slice(insertionIndex);
  const leadingSpacer = before.length === 0 || /\s$/.test(before) ? "" : " ";
  const trailingSpacer = after.length === 0 || /^\s/.test(after) ? "" : " ";
  const insertedChunk = `${leadingSpacer}${normalized}${trailingSpacer}`;
  const insertionStartIndex = before.length + leadingSpacer.length;
  const sourceLastOffset =
    typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0 ? mathfieldApi.lastOffset : sourceLatex.length;
  const insertionOffset = indexToOffsetInRange(mathfieldApi, 0, sourceLastOffset, insertionIndex, "floor");
  if (!Number.isFinite(insertionOffset) || insertionOffset < 0) {
    return false;
  }
  setSelectionRange(mathfieldApi, insertionOffset, insertionOffset);

  const insertOptions = {
    selectionMode: "after",
    focus: true,
    feedback: false,
    format: "latex",
  };
  let inserted = false;
  if (typeof mathfieldApi.executeCommand === "function") {
    const beforeValue = readMathfieldLatex(mathfieldApi, "latex");
    try {
      const ok = mathfieldApi.executeCommand("insert", insertedChunk, insertOptions);
      const afterValue = readMathfieldLatex(mathfieldApi, "latex");
      const changed =
        typeof beforeValue === "string" && typeof afterValue === "string" && afterValue !== beforeValue;
      inserted = ok !== false || changed;
    } catch {
      inserted = false;
    }
  }
  if (!inserted && typeof mathfieldApi.insert === "function") {
    const beforeValue = readMathfieldLatex(mathfieldApi, "latex");
    try {
      mathfieldApi.insert(insertedChunk, insertOptions);
      const afterValue = readMathfieldLatex(mathfieldApi, "latex");
      inserted = typeof beforeValue === "string" && typeof afterValue === "string" ? afterValue !== beforeValue : true;
    } catch {
      inserted = false;
    }
  }
  if (!inserted) {
    return false;
  }

  const nextLatex = readMathfieldLatex(mathfieldApi, "latex");
  if (typeof nextLatex === "string") {
    const searchStart = Math.max(0, insertionStartIndex - 1);
    let commandIndex = nextLatex.indexOf(normalized, searchStart);
    if (commandIndex < 0) {
      commandIndex = nextLatex.lastIndexOf(normalized);
    }
    if (commandIndex >= 0) {
      let selectionStartIndex = commandIndex + normalized.length;
      let selectionEndIndex = selectionStartIndex;
      const braceStart = normalized.indexOf("{");
      if (braceStart >= 0) {
        const braceEnd = normalized.indexOf("}", braceStart + 1);
        if (braceEnd >= braceStart + 1) {
          selectionStartIndex = commandIndex + braceStart + 1;
          selectionEndIndex = commandIndex + braceEnd;
        }
      }
      const lastOffset =
        typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0 ? mathfieldApi.lastOffset : nextLatex.length;
      const startOffset = indexToOffsetInRange(mathfieldApi, 0, lastOffset, selectionStartIndex, "floor");
      const endOffset = indexToOffsetInRange(mathfieldApi, 0, lastOffset, selectionEndIndex, "ceil");
      if (Number.isFinite(startOffset) && Number.isFinite(endOffset) && startOffset >= 0 && endOffset >= startOffset) {
        setSelectionRange(mathfieldApi, startOffset, endOffset);
      }
    }
  }

  if (/^\\(?:shortintertext|intertext)\\{/.test(normalized)) {
    try {
      setMathfieldMode(mathfieldApi, "text");
      runtime.forcedTextMode = true;
      runtime.holdTextModeUntil = nowMs() + 200;
    } catch {
      // ignore mode switch failures
    }
  }

  try {
    mathfieldApi.dispatchEvent?.(new Event("input", { bubbles: true }));
  } catch {
    // ignore dispatch failures
  }
  return true;
};

export const createMathWysiwygApplyOps = (
  runtime: MathWysiwygRuntime,
  deps: {
    mruOps: MathWysiwygMruOps;
    panelOps: MathWysiwygPanelOps;
    finalizeMutationSession: (sessionId: number, options?: { focusTarget?: any; reopenExplicitSession?: boolean; clearCandidates?: boolean }) => void;
  }
): MathWysiwygApplyOps => {
  const { mruOps, panelOps, finalizeMutationSession } = deps;

  const applyCandidate = (index: number) => {
    if (!runtime.mathfield || index < 0 || index >= runtime.panelState.currentCandidates.length) {
      return;
    }
    // Preserve the edit session anchor before clearing so that
    // clearTriggerRange can use it as an upper bound on deletion.
    const savedEditAnchor = runtime.editAnchorOffset;
    clearEditAnchor(runtime);
    const candidate: Candidate = runtime.panelState.currentCandidates[index];
    const wasExplicitSession = runtime.panelState.explicitSession;
    const explicitSessionPrefix = runtime.panelState.explicitSessionPrefixLatex;
    const shouldKeepExplicitSession = false;
    runtime.panelState.explicitSession = false;
    mruOps.recordMru(candidate);

    const mathfieldApi = runtime.mathfield as any;
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    const selection = getMathFieldSelectionRange(mathfieldApi);
    const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
    const insertionAnchorStart = runtime.currentRange ? runtime.currentRange.start : cursorOffset;

    const startMutation = () => {
      const sessionId = runtime.beginMutationSession();
      runtime.suppressNextUpdate = true;
      panelOps.setPanelVisible(false);
      return sessionId;
    };
    const settleMutation = (sessionId: number, options?: { focus?: boolean; clearCandidates?: boolean }) => {
      finalizeMutationSession(sessionId, {
        focusTarget: options?.focus ? mathfieldApi : null,
        reopenExplicitSession: shouldKeepExplicitSession,
        clearCandidates: options?.clearCandidates,
      });
    };

    const insertedLatex = typeof candidate.key.latex === "string" ? normalizeLatexKey(candidate.key.latex) : "";

    const clearTriggerRange = () => {
      if (typeof mathfieldApi.executeCommand !== "function") {
        return;
      }
      // Maximum number of characters that can safely be deleted without
      // crossing into content that predates the current edit session.
      const maxSafeDelete =
        savedEditAnchor !== null &&
        Number.isFinite(savedEditAnchor) &&
        cursorOffset > savedEditAnchor
          ? cursorOffset - savedEditAnchor
          : Infinity;
      const deleteBackwardChars = (count: number) => {
        if (!Number.isFinite(count) || count <= 0) {
          return false;
        }
        const safeCount = Math.min(count, maxSafeDelete);
        if (safeCount <= 0) {
          return false;
        }
        for (let i = 0; i < safeCount; i += 1) {
          try {
            mathfieldApi.executeCommand("deleteBackward");
          } catch {
            return i > 0;
          }
        }
        return true;
      };
      const tokenSuffixFromMatch = (match: TokenMatch | null) => {
        if (!match) {
          return "";
        }
        if (match.kind === "command") {
          return `\\${match.token}`;
        }
        if (match.kind === "slash-command") {
          return `//${match.token}`;
        }
        return match.token;
      };
      const clearSuffixFromBuffer = (source: string, suffix: string) => {
        if (!source || !suffix || !source.endsWith(suffix)) {
          return false;
        }
        return deleteBackwardChars(suffix.length);
      };

      // Extract the base command name from the candidate LaTeX (e.g. "sin"
      // from "\\sin", "sum" from "\\sum_{#?}^{#?}").  Used to limit the
      // deletion to only the matching suffix of the current word token so
      // that preceding content is never accidentally removed.
      const extractCandidateBaseName = (): string | null => {
        if (!insertedLatex) return null;
        const m = /^\\([A-Za-z*]+)/.exec(insertedLatex);
        return m ? m[1] : null;
      };

      const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex") ?? "";

      // Safety check: when the current token is a plain word (no leading
      // backslash) and the candidate is a LaTeX command, only delete the
      // portion of the word that matches the command's base name instead of
      // the entire word.  This prevents "sumsin" → select \sin from wiping
      // out the preceding "sum" characters, and "sumsin" → select \sum from
      // wiping out the trailing "sin" characters.
      if (runtime.currentTokenMatch?.kind === "word") {
        const baseName = extractCandidateBaseName();
        if (baseName) {
          const token = runtime.currentTokenMatch.token;
          if (token.length > baseName.length) {
            // Suffix match: e.g. "sumsin" → select \sin → delete only "sin"
            if (token.endsWith(baseName)) {
              if (clearSuffixFromBuffer(beforeCursor, baseName)) {
                return;
              }
            }
            // Prefix match: e.g. "sumsin" → select \sum → select "sum" portion
            // and delete it so that "sin" remains after the inserted command.
            if (token.startsWith(baseName) && runtime.currentRange) {
              const prefixEndOffset = runtime.currentRange.start + baseName.length;
              if (prefixEndOffset > runtime.currentRange.start && prefixEndOffset <= cursorOffset) {
                setSelectionRange(mathfieldApi, runtime.currentRange.start, prefixEndOffset);
                try {
                  mathfieldApi.executeCommand("deleteBackward");
                } catch {
                  // ignore
                }
                return;
              }
            }
          }
        }
      }

      const expectedSuffix = tokenSuffixFromMatch(runtime.currentTokenMatch);
      if (clearSuffixFromBuffer(beforeCursor, expectedSuffix)) {
        return;
      }

      if (wasExplicitSession) {
        let explicitBuffer = beforeCursor;
        if (explicitSessionPrefix && beforeCursor.startsWith(explicitSessionPrefix)) {
          explicitBuffer = beforeCursor.slice(explicitSessionPrefix.length);
        } else if (explicitSessionPrefix) {
          const relaxedPrefix = explicitSessionPrefix.replace(/\s+$/, "");
          if (relaxedPrefix && beforeCursor.startsWith(relaxedPrefix)) {
            explicitBuffer = beforeCursor.slice(relaxedPrefix.length);
          }
        }
        const trailingToken =
          /(\\?[A-Za-z*]+)$/.exec(explicitBuffer)?.[1] ??
          /(\/\/[A-Za-z*]*)$/.exec(explicitBuffer)?.[1] ??
          /([+\-*/=<>:;,!?.]+)$/.exec(explicitBuffer)?.[1] ??
          "";
        if (trailingToken && deleteBackwardChars(trailingToken.length)) {
          return;
        }
      }

      if (!runtime.currentRange) {
        return;
      }

      const rangeContainsCursor = cursorOffset >= runtime.currentRange.start && cursorOffset <= runtime.currentRange.end + 1;
      const rangeText = readMathfieldLatex(mathfieldApi, runtime.currentRange.start, runtime.currentRange.end, "latex") ?? "";
      if (rangeContainsCursor && clearSuffixFromBuffer(beforeCursor, rangeText)) {
        return;
      }

      const fallbackToken =
        /(\\?[A-Za-z*]+)$/.exec(beforeCursor)?.[1] ??
        /(\/\/[A-Za-z*]*)$/.exec(beforeCursor)?.[1] ??
        /([+\-*/=<>:;,!?.]+)$/.exec(beforeCursor)?.[1] ??
        "";
      if (fallbackToken) {
        deleteBackwardChars(fallbackToken.length);
      }
    };

    const isAuxCommandCandidate =
      AUX_COMMAND_TEMPLATE_RE.test(insertedLatex) || AUX_COMMAND_BARE_RE.test(insertedLatex) || INTERTEXT_TEMPLATE_RE.test(insertedLatex);
    const shouldHoistAuxCommand = isAuxCommandCandidate && isCursorInBlockedAuxEnvironment(mathfieldApi, cursorOffset);

    if (INTERTEXT_TEMPLATE_RE.test(insertedLatex)) {
      const mutationId = startMutation();
      clearTriggerRange();
      const commandLatex = insertedLatex.startsWith("\\shortintertext") ? "\\shortintertext{}" : "\\intertext{}";
      if (shouldHoistAuxCommand) {
        insertAuxCommandOutsideBlockedContext(runtime, mathfieldApi, commandLatex, cursorOffset);
        settleMutation(mutationId, { focus: true });
        return;
      }
      runtime.deps.insertKey(toLiteralInsertKey(getKeyByLatex(commandLatex, commandLatex, commandLatex)));
      const currentSelection = getMathFieldSelectionRange(mathfieldApi);
      const cursorAtInsert = resolveCursorOffset(mathfieldApi, currentSelection);
      const targetOffset = Math.max(0, cursorAtInsert - 1);
      setSelectionRange(mathfieldApi, targetOffset, targetOffset);
      try {
        setMathfieldMode(mathfieldApi, "text");
        runtime.forcedTextMode = true;
        runtime.holdTextModeUntil = nowMs() + 200;
      } catch {
        // ignore mode switch failures
      }
      settleMutation(mutationId, { focus: true });
      return;
    }

    if (insertedLatex === "\\text{#?}") {
      const mutationId = startMutation();
      clearTriggerRange();
      try {
        setMathfieldMode(mathfieldApi, "text");
        try {
          mathfieldApi.mode = "text";
        } catch {
          // ignore
        }
        runtime.forcedTextMode = true;
        runtime.holdTextModeUntil = nowMs() + 200;
      } catch {
        // ignore mode switch failures
      }
      settleMutation(mutationId, { focus: true });
      return;
    }

    if (candidate.apply) {
      const mutationId = startMutation();
      if (runtime.currentRange) {
        setSelectionRange(mathfieldApi, runtime.currentRange.start, runtime.currentRange.end);
      }
      candidate.apply(mathfieldApi);
      settleMutation(mutationId);
      return;
    }

    const mutationId = startMutation();
    clearTriggerRange();
    if (shouldHoistAuxCommand && insertAuxCommandOutsideBlockedContext(runtime, mathfieldApi, insertedLatex, cursorOffset)) {
      settleMutation(mutationId, { focus: true });
      return;
    }

    const insertionKey = toLiteralInsertKey(candidate.key);
    runtime.deps.insertKey(insertionKey);
    const hasPlaceholderTemplate = typeof insertionKey.latex === "string" && insertionKey.latex.includes("#?");
    if (hasPlaceholderTemplate) {
      const inserted = normalizeLatexKey(insertionKey.latex);
      const isAuxCommandTemplate = AUX_COMMAND_TEMPLATE_RE.test(inserted);
      try {
        if (isAuxCommandTemplate) {
          const ranges = getInternalSelectionRanges(mathfieldApi);
          const literalTarget =
            findLiteralPlaceholderRange(mathfieldApi, insertionAnchorStart) ?? findLiteralPlaceholderRange(mathfieldApi, 0);
          const lastRange = ranges.length > 0 ? ranges[ranges.length - 1] : null;
          const target = literalTarget ?? lastRange;
          if (target) {
            setSelectionRange(mathfieldApi, target.start, target.end);
            const shouldForceText = inserted.startsWith("\\text{") || inserted.startsWith("\\operatorname{");
            if (shouldForceText) {
              try {
                setMathfieldMode(mathfieldApi, "text");
                runtime.forcedTextMode = true;
                runtime.holdTextModeUntil = nowMs() + 200;
              } catch {
                // ignore mode switch failures
              }
            } else {
              syncMathfieldMode(runtime, mathfieldApi, target.end);
            }
          }
        } else {
          const insertedSelection = getMathFieldSelectionRange(mathfieldApi);
          if (insertedSelection.start !== insertedSelection.end) {
            syncMathfieldMode(runtime, mathfieldApi, insertedSelection.end);
          } else {
            const ranges = getInternalSelectionRanges(mathfieldApi);
            const target = ranges.find((range) => range.start >= insertionAnchorStart) ?? ranges[0] ?? null;
            if (target) {
              setSelectionRange(mathfieldApi, target.start, target.end);
              syncMathfieldMode(runtime, mathfieldApi, target.end);
            }
          }
        }
      } catch {
        // ignore placeholder positioning failures
      }

      const settledRange = getMathFieldSelectionRange(mathfieldApi);
      if (settledRange.start === settledRange.end && typeof mathfieldApi.executeCommand === "function") {
        try {
          const moved = Boolean(mathfieldApi.executeCommand("moveToNextPlaceholder"));
          if (moved) {
            const movedRange = getMathFieldSelectionRange(mathfieldApi);
            if (movedRange.start !== movedRange.end) {
              setSelectionRange(mathfieldApi, movedRange.start, movedRange.end);
              syncMathfieldMode(runtime, mathfieldApi, movedRange.end);
            }
          }
        } catch {
          // ignore placeholder fallback move failures
        }
      }
    } else {
      const settled = getMathFieldSelectionRange(mathfieldApi);
      if (settled.start !== settled.end) {
        const collapseTo = Math.max(settled.start, settled.end);
        setSelectionRange(mathfieldApi, collapseTo, collapseTo);
      }
    }

    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    settleMutation(mutationId, { focus: true });
  };

  return { applyCandidate };
};
