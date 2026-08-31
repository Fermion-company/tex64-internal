"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getNativeHost, requestFromHost } from "./native-host";
import {
  normalizeWorkspaceMainFile,
  normalizeWorkspaceRelativePath,
  replyMatchesWorkspace,
  workspaceRequestFields,
  type NativeWorkspaceIdentity,
} from "./workspace-identity";

export type SourceLocation = {
  path: string;
  line: number;
  confident: boolean;
  selectedText: string;
};

export type SourceLocatorContext = {
  workspaceId?: string;
  workspaceRoot?: string | null;
  workspaceGeneration?: number;
  documentMainFile?: string | null;
};

export type SourceLocator = {
  location: SourceLocation | null;
  error: string | null;
  locating: boolean;
  locate: (point: {
    page: number;
    x: number;
    y: number;
    pdfPath: string | null;
    text?: string;
  }) => void;
  clear: () => void;
};

type SourceLocatorState = {
  contextKey: string;
  location: SourceLocation | null;
  error: string | null;
  locating: boolean;
};

const emptyLocatorState = (contextKey: string): SourceLocatorState => ({
  contextKey,
  location: null,
  error: null,
  locating: false,
});

/** Reverse SyncTeX results are accepted only for the click's workspace and PDF. */
export function useSourceLocator(context: SourceLocatorContext = {}): SourceLocator {
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
  const [locatorState, setLocatorState] = useState<SourceLocatorState>(() =>
    emptyLocatorState(contextKey),
  );
  const lastContextKeyRef = useRef(contextKey);
  useEffect(() => {
    if (lastContextKeyRef.current === contextKey) return;
    lastContextKeyRef.current = contextKey;
    requestEpochRef.current += 1;
  }, [contextKey]);
  const stateIsCurrent = locatorState.contextKey === contextKey;
  const location = stateIsCurrent ? locatorState.location : null;
  const error = stateIsCurrent ? locatorState.error : null;
  const locating = stateIsCurrent ? locatorState.locating : false;

  const updateCurrentState = useCallback(
    (update: Partial<Omit<SourceLocatorState, "contextKey">>) => {
      setLocatorState((current) =>
        current.contextKey === contextKey ? { ...current, ...update } : current,
      );
    },
    [contextKey],
  );

  const locate = useCallback(
    (point: {
      page: number;
      x: number;
      y: number;
      pdfPath: string | null;
      text?: string;
    }) => {
      const host = getNativeHost();
      if (!host) return;
      const requestEpoch = ++requestEpochRef.current;
      const requestedPdf = normalizeWorkspaceRelativePath(point.pdfPath);
      setLocatorState({
        contextKey,
        location: null,
        error: null,
        locating: true,
      });
      void (async () => {
        try {
          const found = await requestFromHost(host, {
            type: "synctex:reverse",
            resultType: "synctex:reverseResult",
            payload: {
              page: point.page,
              x: point.x,
              y: point.y,
              ...(requestedPdf ? { pdfPath: requestedPdf } : {}),
              ...(documentMainFile ? { documentMainFile } : {}),
              ...workspaceRequestFields(expected),
              bypassHint: true,
              refineLines: 0,
              preferExact: true,
            },
            timeoutMs: 20_000,
          });
          if (requestEpoch !== requestEpochRef.current) return;
          const answeredPdf = normalizeWorkspaceRelativePath(found.pdfPath);
          if (
            !replyMatchesWorkspace(found, expected) ||
            (requestedPdf && answeredPdf && requestedPdf !== answeredPdf)
          ) {
            return;
          }
          if (
            found.ok !== true ||
            typeof found.path !== "string" ||
            typeof found.line !== "number"
          ) {
            updateCurrentState({
              error: typeof found.error === "string"
                ? found.error
                : "この場所は本文と結び付けられませんでした。",
              location: null,
            });
            return;
          }
          if (requestEpoch !== requestEpochRef.current) return;
          updateCurrentState({
            location: {
              path: found.path,
              line: found.line,
              confident: found.confidence === true,
              selectedText: point.text?.trim() ?? "",
            },
          });
        } catch {
          if (requestEpoch !== requestEpochRef.current) return;
          updateCurrentState({
            error: "本文の場所を確かめられませんでした。組版し直すと直ることがあります。",
            location: null,
          });
        } finally {
          if (requestEpoch === requestEpochRef.current) {
            updateCurrentState({ locating: false });
          }
        }
      })();
    },
    [contextKey, documentMainFile, expected, updateCurrentState],
  );

  const clear = useCallback(() => {
    requestEpochRef.current += 1;
    setLocatorState(emptyLocatorState(contextKey));
  }, [contextKey]);

  return { location, error, locating, locate, clear };
}
