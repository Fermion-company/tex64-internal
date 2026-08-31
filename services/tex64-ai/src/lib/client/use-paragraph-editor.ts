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
};

const emptyEditorState = (contextKey: string): ParagraphEditorState => ({
  contextKey,
  paragraph: null,
  loading: false,
  saving: false,
  error: null,
});

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
          updateCurrentState({
            paragraph: {
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
            },
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
    [contextKey, documentMainFile, expected, updateCurrentState],
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
              ? "本文が先に変わっていたため、上書きを避けました。もう一度選び直してください。"
              : typeof result.error === "string"
                ? result.error
                : "書き戻せませんでした。",
          });
          return false;
        }
        updateCurrentState({ paragraph: null });
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
    [documentMainFile, expected, paragraph, updateCurrentState],
  );

  const close = useCallback(() => {
    requestEpochRef.current += 1;
    setEditorState(emptyEditorState(contextKey));
  }, [contextKey]);

  return { paragraph, loading, saving, error, open, save, close };
}
