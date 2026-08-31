"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  getNativeHost,
  hostMessageBody,
  requestFromHost,
  type HostMessage,
} from "./native-host";
import {
  EMPTY_WORKSPACE_IDENTITY,
  normalizeWorkspaceMainFile,
  normalizeWorkspaceRelativePath,
  replyMatchesWorkspace,
  sameWorkspaceSession,
  workspaceIdentityFromHost,
  workspaceRequestFields,
  workspaceStorageKey,
  type NativeWorkspaceIdentity,
} from "./workspace-identity";

const LAST_PDF_KEY_PREFIX = "tex64.ai.lastBuiltPdf";

export type WorkspacePdf = {
  url: string | null;
  path: string | null;
  building: boolean;
  native: boolean;
  failure: string | null;
  hasWorkspace: boolean;
};

const subscribeToNothing = () => () => {};

export type BuiltPage = {
  path: string;
  stamp: number;
  mainFile: string;
  requestId: string | null;
};
export type TargetBuildState = {
  building: boolean;
  failure: string | null;
  page: BuiltPage | null;
  requestId: string | null;
};
type LoadedPdf = { key: string; scopeKey: string; url: string };
type WorkspacePdfCatalog = { sessionKey: string; paths: string[] };

const MAX_NATIVE_PDF_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_PDF_BASE64_LENGTH = Math.ceil(MAX_NATIVE_PDF_BYTES / 3) * 4 + 4;

export const buildTargetFromEvent = (body: Record<string, unknown>): string =>
  normalizeWorkspaceMainFile(body.documentMainFile) ||
  normalizeWorkspaceMainFile(body.targetFile);

const requestIdFromEvent = (body: Record<string, unknown>): string | null =>
  typeof body.requestId === "string" && body.requestId.trim() ? body.requestId : null;

const rememberedPdfKey = (identity: NativeWorkspaceIdentity, mainFile: string) =>
  workspaceStorageKey(LAST_PDF_KEY_PREFIX, identity, mainFile);

export const nativePdfRequestKey = (
  identity: NativeWorkspaceIdentity,
  mainFile: string,
  page: BuiltPage,
): string =>
  [
    identity.workspaceId,
    identity.workspaceGeneration,
    normalizeWorkspaceMainFile(mainFile),
    page.path,
    page.stamp,
    page.requestId ?? "remembered",
  ].join("\u0000");

const nativePdfScopeKey = (
  identity: NativeWorkspaceIdentity,
  mainFile: string,
): string =>
  [
    identity.workspaceId,
    identity.workspaceGeneration,
    normalizeWorkspaceMainFile(mainFile),
  ].join("\u0000");

const workspaceSessionKey = (identity: NativeWorkspaceIdentity): string =>
  [
    identity.workspaceId,
    identity.workspaceRoot ?? "",
    identity.workspaceGeneration,
  ].join("\u0000");

const pdfFilesFromWorkspace = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const paths = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeWorkspaceRelativePath(entry);
    if (normalized?.toLowerCase().endsWith(".pdf")) paths.add(normalized);
  }
  return [...paths];
};

/**
 * Locate a PDF that already exists on disk before the first AI-mode build.
 * Only the exact sibling is deterministic. A same-named PDF elsewhere could
 * belong to another `main.tex` and must wait for an explicitly correlated
 * successful build event.
 */
export const existingPdfForDocument = (
  mainFile: string,
  workspaceFiles: readonly string[],
): string | null => {
  const normalizedMain = normalizeWorkspaceRelativePath(mainFile);
  if (!normalizedMain?.toLowerCase().endsWith(".tex")) return null;
  const expected = `${normalizedMain.slice(0, -4)}.pdf`;
  const pdfPaths = workspaceFiles
    .map((entry) => normalizeWorkspaceRelativePath(entry))
    .filter((entry): entry is string => Boolean(entry?.toLowerCase().endsWith(".pdf")));
  const exact = pdfPaths.find((entry) => entry.toLowerCase() === expected.toLowerCase());
  return exact ?? null;
};

export const selectWorkspacePdfPage = (input: {
  currentMainFile: string;
  currentBuild: TargetBuildState | null;
  lastBuilt: BuiltPage | null;
  rememberedPath: string | null;
  /** null until the current workspace snapshot has arrived. */
  workspaceFiles: readonly string[] | null;
}): BuiltPage | null => {
  if (!input.currentMainFile) return input.lastBuilt;
  if (input.currentBuild?.page) return input.currentBuild.page;
  // A failed first build describes the new source, but it must not erase the
  // last PDF that is still present on disk.
  const remembered = normalizeWorkspaceRelativePath(input.rememberedPath);
  const existing = existingPdfForDocument(
    input.currentMainFile,
    input.workspaceFiles ?? [],
  );
  const rememberedIsListed = Boolean(
    remembered &&
      input.workspaceFiles?.some(
        (entry) => normalizeWorkspaceRelativePath(entry)?.toLowerCase() === remembered.toLowerCase(),
      ),
  );
  // A stale remembered outDir must not hide a sibling PDF that the fresh
  // workspace snapshot proves exists. If the tree omitted the outDir (ignored
  // directory or file limit), keep trying the explicitly correlated path.
  const path =
    remembered && (input.workspaceFiles === null || rememberedIsListed || !existing)
      ? remembered
      : existing;
  return path
    ? {
        path,
        stamp: 0,
        mainFile: input.currentMainFile,
        requestId: null,
      }
    : null;
};

export const nativePdfReplyMatches = (
  reply: Record<string, unknown>,
  expected: NativeWorkspaceIdentity,
  expectedMainFile: string,
  expectedPath: string,
): boolean => {
  if (reply.ok !== true || !replyMatchesWorkspace(reply, expected)) return false;
  if (
    reply.workspaceId !== expected.workspaceId ||
    reply.workspaceGeneration !== expected.workspaceGeneration
  ) {
    return false;
  }
  if (normalizeWorkspaceRelativePath(reply.path) !== expectedPath) return false;
  const replyMainFile = normalizeWorkspaceMainFile(reply.documentMainFile);
  if (replyMainFile !== expectedMainFile) return false;
  return (
    typeof reply.base64 === "string" &&
    reply.base64.length > 0 &&
    reply.base64.length <= MAX_NATIVE_PDF_BASE64_LENGTH &&
    reply.mimeType === "application/pdf" &&
    typeof reply.byteSize === "number" &&
    Number.isSafeInteger(reply.byteSize) &&
    reply.byteSize >= 0 &&
    reply.byteSize <= MAX_NATIVE_PDF_BYTES
  );
};

export const decodeNativePdf = (
  base64: string,
  reportedByteSize?: unknown,
): Uint8Array<ArrayBuffer> => {
  if (!base64 || base64.length > MAX_NATIVE_PDF_BASE64_LENGTH) {
    throw new Error("Invalid PDF payload size.");
  }
  const binary = globalThis.atob(base64);
  if (binary.length > MAX_NATIVE_PDF_BYTES) {
    throw new Error("PDF payload is too large.");
  }
  if (
    typeof reportedByteSize === "number" &&
    Number.isSafeInteger(reportedByteSize) &&
    reportedByteSize !== binary.length
  ) {
    throw new Error("PDF payload size does not match.");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  // ISO 32000 readers permit a short binary preamble before the header.
  const headerLimit = Math.min(bytes.length - 4, 1024);
  let hasPdfHeader = false;
  for (let index = 0; index <= headerLimit; index += 1) {
    if (
      bytes[index] === 0x25 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46 &&
      bytes[index + 4] === 0x2d
    ) {
      hasPdfHeader = true;
      break;
    }
  }
  if (!hasPdfHeader) throw new Error("The payload is not a PDF.");
  return bytes;
};

/**
 * Shows only a build belonging to the current workspace generation and exact
 * main file. PDF output directories are deliberately irrelevant: targetFile,
 * not dirname(pdfPath), identifies the document.
 */
export function useWorkspacePdf(
  currentDocument: { folder?: string; mainFile: string } | null = null,
): WorkspacePdf {
  const [identity, setIdentity] = useState<NativeWorkspaceIdentity>(EMPTY_WORKSPACE_IDENTITY);
  const identityRef = useRef<NativeWorkspaceIdentity>(EMPTY_WORKSPACE_IDENTITY);
  const [builds, setBuilds] = useState<Record<string, TargetBuildState>>({});
  const buildsRef = useRef<Record<string, TargetBuildState>>({});
  const [lastBuilt, setLastBuilt] = useState<BuiltPage | null>(null);
  const [pdfCatalog, setPdfCatalog] = useState<WorkspacePdfCatalog | null>(null);
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null);
  const loadedPdfRef = useRef<LoadedPdf | null>(null);
  const [pdfLoadError, setPdfLoadError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const native = useSyncExternalStore(
    subscribeToNothing,
    () => getNativeHost() !== null,
    () => false,
  );
  useEffect(() => {
    const host = getNativeHost();
    if (!host) return;

    const unsubscribe = host.onMessage((message: HostMessage) => {
      const body = hostMessageBody(message);
      if (message.type === "updateWorkspace") {
        const next = workspaceIdentityFromHost(body, identityRef.current);
        setPdfCatalog({
          sessionKey: workspaceSessionKey(next),
          paths: pdfFilesFromWorkspace(body.files),
        });
        if (!sameWorkspaceSession(next, identityRef.current)) {
          identityRef.current = next;
          setIdentity(next);
          buildsRef.current = {};
          setBuilds({});
          setLastBuilt(null);
        }
        return;
      }
      if (message.type !== "setBuildState") return;
      const expected = identityRef.current;
      if (!expected.workspaceRoot || !replyMatchesWorkspace(body, expected)) return;
      const targetFile = buildTargetFromEvent(body);
      // A global Code build must never be guessed into whichever AI document
      // happens to be visible. New host events always carry the exact target.
      if (!targetFile) return;

      const state = body.state;
      const requestId = requestIdFromEvent(body);
      const running = state === "running" || state === "building";
      const current = buildsRef.current;
      const previous = current[targetFile] ?? {
          building: false,
          failure: null,
          page: null,
          requestId: null,
      };
      // Once a newer request for the same document starts, its older terminal
      // event cannot replace the page or failure state.
      if (
        !running &&
        requestId &&
        previous.requestId &&
        requestId !== previous.requestId
      ) {
        return;
      }
      let nextTarget: TargetBuildState | null = null;
      if (running) {
        nextTarget = {
          ...previous,
          building: true,
          failure: null,
          requestId: requestId ?? previous.requestId,
        };
      } else if (state === "success") {
        const pdfPath = normalizeWorkspaceRelativePath(body.pdfPath);
        if (!pdfPath) return;
        const page: BuiltPage = {
          path: pdfPath,
          stamp: Date.now(),
          mainFile: targetFile,
          requestId,
        };
        nextTarget = { building: false, failure: null, page, requestId };
        setLastBuilt(page);
        window.localStorage.setItem(rememberedPdfKey(expected, targetFile), pdfPath);
      } else if (state === "failed") {
        nextTarget = {
          ...previous,
          building: false,
          failure:
            typeof body.message === "string" && body.message
              ? body.message
              : "紙面を組み立てられませんでした。",
          requestId: requestId ?? previous.requestId,
        };
      } else if (state === "idle") {
        nextTarget = {
          ...previous,
          building: false,
          requestId: requestId ?? previous.requestId,
        };
      }
      if (nextTarget) {
        const nextBuilds = { ...current, [targetFile]: nextTarget };
        buildsRef.current = nextBuilds;
        setBuilds(nextBuilds);
      }
    });

    host.send("workspace:state:get", {});
    return unsubscribe;
  }, []);

  const currentMainFile = normalizeWorkspaceMainFile(currentDocument?.mainFile);
  const currentBuild = currentMainFile ? (builds[currentMainFile] ?? null) : null;
  const shown = useMemo<BuiltPage | null>(() => {
    const currentCatalog =
      pdfCatalog?.sessionKey === workspaceSessionKey(identity) ? pdfCatalog.paths : null;
    const remembered =
      typeof window !== "undefined" && identity.workspaceRoot && currentMainFile
        ? window.localStorage.getItem(rememberedPdfKey(identity, currentMainFile))
        : null;
    return selectWorkspacePdfPage({
      currentMainFile,
      currentBuild,
      lastBuilt,
      rememberedPath: remembered,
      workspaceFiles: currentCatalog,
    });
  }, [currentBuild, currentMainFile, identity, lastBuilt, pdfCatalog]);

  const loadKey =
    identity.workspaceRoot && shown && currentMainFile
      ? nativePdfRequestKey(identity, currentMainFile, shown)
      : null;
  const scopeKey =
    identity.workspaceRoot && currentMainFile
      ? nativePdfScopeKey(identity, currentMainFile)
      : null;
  const replaceLoadedPdf = useCallback((next: LoadedPdf | null) => {
    const previous = loadedPdfRef.current;
    loadedPdfRef.current = next;
    if (previous && previous.url !== next?.url) URL.revokeObjectURL(previous.url);
    setLoadedPdf(next);
  }, []);

  useEffect(() => {
    return () => {
      const loaded = loadedPdfRef.current;
      loadedPdfRef.current = null;
      if (loaded) URL.revokeObjectURL(loaded.url);
    };
  }, []);

  useEffect(() => {
    const host = getNativeHost();
    const expected = identity;
    const expectedMainFile = currentMainFile;
    const expectedPath = normalizeWorkspaceRelativePath(shown?.path);
    const expectedKey = loadKey;
    const expectedScopeKey = scopeKey;
    if (
      !native ||
      !host ||
      !expected.workspaceRoot ||
      !expectedMainFile ||
      !expectedPath ||
      !expectedKey ||
      !expectedScopeKey
    ) {
      // The state owns the Blob URL; clearing it and revoking the resource are
      // one external-resource synchronization step.
      if (loadedPdfRef.current) {
        replaceLoadedPdf(null);
      }
      return;
    }

    if (
      loadedPdfRef.current &&
      loadedPdfRef.current.scopeKey !== expectedScopeKey
    ) {
      replaceLoadedPdf(null);
    }
    let cancelled = false;
    void requestFromHost(host, {
      type: "file:bytes",
      resultType: "file:bytesResult",
      payload: {
        path: expectedPath,
        documentMainFile: expectedMainFile,
        ...workspaceRequestFields(expected),
      },
      timeoutMs: 30_000,
    })
      .then((reply) => {
        if (cancelled || !sameWorkspaceSession(identityRef.current, expected)) return;
        if (!nativePdfReplyMatches(reply, expected, expectedMainFile, expectedPath)) {
          throw new Error("The PDF response did not match its request.");
        }
        const bytes = decodeNativePdf(reply.base64 as string, reply.byteSize);
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        if (cancelled || !sameWorkspaceSession(identityRef.current, expected)) {
          URL.revokeObjectURL(url);
          return;
        }
        replaceLoadedPdf({ key: expectedKey, scopeKey: expectedScopeKey, url });
        setPdfLoadError(null);
      })
      .catch(() => {
        if (!cancelled && sameWorkspaceSession(identityRef.current, expected)) {
          setPdfLoadError({
            key: expectedKey,
            message: "紙面を読み込めませんでした。もう一度組版してください。",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    currentMainFile,
    identity,
    loadKey,
    native,
    replaceLoadedPdf,
    scopeKey,
    shown?.path,
  ]);

  // Keep the prior successfully loaded page while a newer build of the same
  // document is transferred. A workspace/document change never shares scope.
  const url = scopeKey && loadedPdf?.scopeKey === scopeKey ? loadedPdf.url : null;
  const currentPdfLoadError =
    loadKey && pdfLoadError?.key === loadKey ? pdfLoadError.message : null;

  return {
    url,
    path: shown?.path ?? null,
    building: currentBuild?.building ?? false,
    native,
    failure:
      currentBuild?.failure ??
      (currentBuild?.building ? null : currentPdfLoadError),
    hasWorkspace: identity.workspaceRoot !== null,
  };
}
