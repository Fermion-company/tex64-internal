"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  findParagraphRange,
  segmentDisplayMath,
  segmentParagraph,
  type ParagraphSegment,
} from "@/domain/source/paragraph-editing";
import { getNativeHost, requestFromHost } from "./native-host";
import { conversationIdFor } from "./native-agent";
import {
  normalizeWorkspaceMainFile,
  replyMatchesWorkspace,
  workspaceRequestFields,
  type NativeWorkspaceIdentity,
} from "./workspace-identity";

export type ParagraphEditorContext = {
  workspaceId?: string;
  workspaceRoot?: string | null;
  workspaceGeneration?: number;
  documentMainFile?: string | null;
};

export type EditableParagraph = {
  kind: "text" | "math";
  path: string;
  startLine: number;
  endLine: number;
  originalText: string;
  /** Whole-file CAS captured by file:excerpt, not just the visible lines. */
  baseContentHash: string | null;
  documentMainFile: string;
  workspaceId: string;
  workspaceGeneration: number;
  segments: ParagraphSegment[];
};

export type ParagraphEditor = {
  paragraph: EditableParagraph | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  draftText: string | null;
  currentText: string | null;
  acceptCurrent: () => void;
  updateDraft: (text: string) => void;
  discard: () => void;
  open: (location: { path: string; line: number; selectedText?: string }) => void;
  save: (replacementText: string) => Promise<boolean>;
  close: () => void;
};

type ParagraphEditorState = {
  contextKey: string;
  paragraph: EditableParagraph | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  draftText: string | null;
  currentTarget: EditableParagraph | null;
};

const emptyEditorState = (contextKey: string): ParagraphEditorState => ({
  contextKey,
  paragraph: null,
  loading: false,
  saving: false,
  error: null,
  draftText: null,
  currentTarget: null,
});

type ParagraphDraft = { target: EditableParagraph; text: string };
const draftKey = (target: EditableParagraph) => `${target.path}:${target.startLine}:${target.endLine}`;

/** Direct paragraph editing with whole-file CAS and workspace-generation guards. */
export function useParagraphEditor(context: ParagraphEditorContext = {}): ParagraphEditor {
  const requestEpochRef = useRef(0);
  const workspaceId = context.workspaceId ?? "";
  const workspaceRoot = context.workspaceRoot ?? null;
  const workspaceGeneration =
    typeof context.workspaceGeneration === "number" ? context.workspaceGeneration : 0;
  const expected = useMemo<NativeWorkspaceIdentity>(
    () => ({ workspaceId, workspaceRoot, workspaceGeneration }),
    [workspaceGeneration, workspaceId, workspaceRoot],
  );
  const documentMainFile = normalizeWorkspaceMainFile(context.documentMainFile);
  const contextKey = `${expected.workspaceId}:${expected.workspaceGeneration}:${documentMainFile}`;
  // Keep unsaved edits across selections, mode switches and renderer reloads.
  // Workspace generations change on reopen; drafts belong to the stable document.
  const storageKey = `tex64.paperDrafts.v1:${workspaceId}:${documentMainFile}`;
  const draftsRef = useRef<{ key: string; entries: Record<string, ParagraphDraft> }>({ key: "", entries: {} });
  const drafts = useCallback(() => {
    if (draftsRef.current.key !== storageKey) {
      let entries: Record<string, ParagraphDraft> = {};
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          entries = Object.fromEntries(Object.entries(saved).filter(([, draft]) =>
            draft && typeof draft.text === "string" && draft.target &&
            typeof draft.target.path === "string" && typeof draft.target.originalText === "string" &&
            Number.isInteger(draft.target.startLine) && Number.isInteger(draft.target.endLine)));
        }
      } catch { /* Empty on unavailable storage. */ }
      draftsRef.current = { key: storageKey, entries };
    }
    return draftsRef.current.entries;
  }, [storageKey]);
  const persistDrafts = useCallback(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(drafts())); } catch { /* The in-memory draft remains available. */ }
  }, [drafts, storageKey]);
  const [editorState, setEditorState] = useState<ParagraphEditorState>(() =>
    emptyEditorState(contextKey),
  );
  const lastContextKeyRef = useRef(contextKey);
  useEffect(() => {
    if (lastContextKeyRef.current === contextKey) return;
    lastContextKeyRef.current = contextKey;
    requestEpochRef.current += 1;
  }, [contextKey]);
  const stateIsCurrent = editorState.contextKey === contextKey;
  const paragraph = stateIsCurrent ? editorState.paragraph : null;
  const loading = stateIsCurrent ? editorState.loading : false;
  const saving = stateIsCurrent ? editorState.saving : false;
  const error = stateIsCurrent ? editorState.error : null;
  const draftText = stateIsCurrent ? editorState.draftText : null;
  const currentTarget = stateIsCurrent ? editorState.currentTarget : null;

  const updateCurrentState = useCallback(
    (update: Partial<Omit<ParagraphEditorState, "contextKey">>) => {
      setEditorState((current) =>
        current.contextKey === contextKey ? { ...current, ...update } : current,
      );
    },
    [contextKey],
  );

  const open = useCallback(
    (location: { path: string; line: number; selectedText?: string }) => {
      const host = getNativeHost();
      if (!host) return;
      const requestEpoch = ++requestEpochRef.current;
      setEditorState({
        contextKey,
        paragraph: null,
        loading: true,
        saving: false,
        error: null,
        draftText: null,
        currentTarget: null,
      });
      void (async () => {
        try {
          const excerpt = await requestFromHost(host, {
            type: "file:excerpt",
            resultType: "file:excerptResult",
            payload: {
              path: location.path,
              line: location.line,
              radius: 180,
              maxLines: 360,
              ...(documentMainFile ? { documentMainFile } : {}),
              ...workspaceRequestFields(expected),
            },
            timeoutMs: 8_000,
          });
          if (
            requestEpoch !== requestEpochRef.current ||
            !replyMatchesWorkspace(excerpt, expected)
          ) {
            return;
          }
          if (
            excerpt.ok !== true ||
            !Array.isArray(excerpt.lines) ||
            typeof excerpt.startLine !== "number"
          ) {
            updateCurrentState({
              error:
              typeof excerpt.error === "string"
                ? excerpt.error
                : "本文を読み出せませんでした。",
            });
            return;
          }
          const range = findParagraphRange(
            excerpt.lines.map((line) => String(line)),
            excerpt.startLine,
            location.line,
            location.selectedText,
          );
          if (!range) {
            updateCurrentState({
              error: "この箇所には直接編集できる文章や数式がありません。",
            });
            return;
          }
          const segments: ParagraphSegment[] =
            range.kind === "math"
              ? segmentDisplayMath(range.text)
              : segmentParagraph(range.text);
          const hasEditableContent = segments.some(
            (segment) =>
              segment.kind === "math" ||
              (segment.kind === "text" && segment.latex.trim().length > 0),
          );
          if (!hasEditableContent) {
            updateCurrentState({
              error: "この箇所には直接編集できる文章や数式がありません。",
            });
            return;
          }
          const target: EditableParagraph = {
              kind: range.kind,
              path: location.path,
              startLine: range.startLine,
              endLine: range.endLine,
              originalText: range.text,
              baseContentHash:
                typeof excerpt.contentHash === "string" && excerpt.contentHash
                  ? excerpt.contentHash
                  : null,
              documentMainFile,
              workspaceId: expected.workspaceId,
              workspaceGeneration: expected.workspaceGeneration,
              segments,
          };
          const draft = drafts()[draftKey(target)];
          updateCurrentState({
            paragraph: draft
              ? { ...draft.target, workspaceId: expected.workspaceId, workspaceGeneration: expected.workspaceGeneration,
                  // Edits elsewhere in the file do not invalidate this draft.
                  ...(draft.target.originalText === range.text ? { baseContentHash: target.baseContentHash } : {}) }
              : target,
            draftText: draft?.text ?? null,
            currentTarget: draft && draft.target.originalText !== range.text ? target : null,
            error: draft && draft.target.originalText !== range.text
              ? "この箇所の本文が変更されています。下書きは保持しています。"
              : null,
          });
        } catch {
          if (requestEpoch === requestEpochRef.current) {
            updateCurrentState({ error: "本文を読み出せませんでした。" });
          }
        } finally {
          if (requestEpoch === requestEpochRef.current) {
            updateCurrentState({ loading: false });
          }
        }
      })();
    },
    [contextKey, documentMainFile, drafts, expected, updateCurrentState],
  );

  const save = useCallback(
    async (replacementText: string): Promise<boolean> => {
      const target = paragraph;
      if (!target) return false;
      if (
        target.workspaceId !== expected.workspaceId ||
        target.workspaceGeneration !== expected.workspaceGeneration ||
        target.documentMainFile !== documentMainFile
      ) {
        return false;
      }
      if (replacementText === target.originalText) {
        delete drafts()[draftKey(target)];
        persistDrafts();
        updateCurrentState({ paragraph: null, error: null });
        return true;
      }
      const host = getNativeHost();
      if (!host) return false;
      const requestEpoch = ++requestEpochRef.current;
      updateCurrentState({ saving: true, error: null });
      try {
        const result = await requestFromHost(host, {
          type: "file:replaceLines",
          resultType: "file:replaceLinesResult",
          payload: {
            path: target.path,
            startLine: target.startLine,
            endLine: target.endLine,
            expectedText: target.originalText,
            replacementText,
            ...(target.baseContentHash ? { expectedContentHash: target.baseContentHash } : {}),
            documentMainFile: target.documentMainFile,
            ...(expected.workspaceId && target.documentMainFile
              ? { conversationId: conversationIdFor(expected.workspaceId, target.documentMainFile) }
              : {}),
            ...workspaceRequestFields(expected),
          },
          timeoutMs: 8_000,
        });
        if (
          requestEpoch !== requestEpochRef.current ||
          !replyMatchesWorkspace(result, expected)
        ) {
          return false;
        }
        if (result.ok !== true) {
          updateCurrentState({
            error: result.stale === true
              ? "本文が変更されたため保存しませんでした。下書きは保持しています。"
              : typeof result.error === "string"
                ? result.error
                : "書き戻せませんでした。",
          });
          return false;
        }
        delete drafts()[draftKey(target)];
        persistDrafts();
        updateCurrentState({ paragraph: null, draftText: null });
        return true;
      } catch {
        if (requestEpoch === requestEpochRef.current) {
          updateCurrentState({ error: "書き戻せませんでした。" });
        }
        return false;
      } finally {
        if (requestEpoch === requestEpochRef.current) {
          updateCurrentState({ saving: false });
        }
      }
    },
    [documentMainFile, drafts, expected, paragraph, persistDrafts, updateCurrentState],
  );

  const updateDraft = useCallback((text: string) => {
    if (!paragraph) return;
    if (text === paragraph.originalText) delete drafts()[draftKey(paragraph)];
    else drafts()[draftKey(paragraph)] = { target: paragraph, text };
    persistDrafts();
    updateCurrentState({ draftText: text });
  }, [drafts, paragraph, persistDrafts, updateCurrentState]);

  const close = useCallback(() => {
    requestEpochRef.current += 1;
    setEditorState(emptyEditorState(contextKey));
  }, [contextKey]);

  const discard = useCallback(() => {
    if (paragraph) {
      delete drafts()[draftKey(paragraph)];
      persistDrafts();
    }
    close();
  }, [close, drafts, paragraph, persistDrafts]);

  const acceptCurrent = useCallback(() => {
    if (!currentTarget || draftText === null) return;
    drafts()[draftKey(currentTarget)] = { target: currentTarget, text: draftText };
    persistDrafts();
    updateCurrentState({ paragraph: currentTarget, currentTarget: null, error: null });
  }, [currentTarget, draftText, drafts, persistDrafts, updateCurrentState]);

  return { paragraph, loading, saving, error, draftText, currentText: currentTarget?.originalText ?? null, acceptCurrent, updateDraft, discard, open, save, close };
}
