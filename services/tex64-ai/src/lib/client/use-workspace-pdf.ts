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
  issue: { file: string; line: number | null } | null;
  url: string | null;
  /** Displayed revision whose source map is ready for a new positional lookup. */
  sourceMapUrl: string | null;
  path: string | null;
  building: boolean;
  native: boolean;
  failure: string | null;
  retryPdfRead: (() => void) | null;
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
  issue?: { file: string; line: number | null } | null;
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

const documentPathsFromWorkspace = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const paths = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeWorkspaceRelativePath(entry);
    if (normalized && /\.(pdf|tex)$/i.test(normalized)) paths.add(normalized);
  }
  return [...paths];
};

/**
 * Locate a PDF that already exists on disk before the first AI-mode build.
 * Prefer the exact sibling. A case-insensitive fallback must identify one PDF
 * and one source, even when the workspace is on a case-sensitive volume.
 */
export const existingPdfForDocument = (
  mainFile: string,
  workspaceFiles: readonly string[],
): string | null => {
  const normalizedMain = normalizeWorkspaceRelativePath(mainFile);
  if (!normalizedMain?.toLowerCase().endsWith(".tex")) return null;
  const expected = `${normalizedMain.slice(0, -4)}.pdf`;
  const expectedFolded = expected.toLowerCase();
  const mainFolded = normalizedMain.toLowerCase();
  let fallback: string | null = null;
  let ambiguous = false;
  for (const item of workspaceFiles) {
    const path = normalizeWorkspaceRelativePath(item);
    if (!path) continue;
    if (path === expected) return path;
    const folded = path.toLowerCase();
    if (folded === expectedFolded) {
      if (fallback && fallback !== path) ambiguous = true;
      fallback = path;
    } else if (folded === mainFolded && path !== normalizedMain) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : fallback;
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
        (entry) => normalizeWorkspaceRelativePath(entry) === remembered,
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
  const [paperVisible, setPaperVisible] = useState(true);
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null);
  const loadedPdfRef = useRef<LoadedPdf | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
      if (message.type === "paper:visibility" && typeof body.visible === "boolean") {
        setPaperVisible(body.visible);
        return;
      }
      if (message.type === "updateWorkspace") {
        const next = workspaceIdentityFromHost(body, identityRef.current);
        setPdfCatalog({
          sessionKey: workspaceSessionKey(next),
          paths: documentPathsFromWorkspace(body.files),
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
        try {
          window.localStorage.setItem(rememberedPdfKey(expected, targetFile), pdfPath);
        } catch {
          // Remembering the path for next launch is optional, even at quota.
        }
      } else if (state === "failed") {
        const issues = Array.isArray(body.issues) ? body.issues : [];
        const issue = issues.find((value) => value && typeof value === "object" && value.severity === "error") ?? issues[0];
        const issueFile = normalizeWorkspaceRelativePath(issue?.path) ?? targetFile;
        // The host leads with the file's absolute path, sometimes already cut from the left;
        // show it the way the workspace names it, then the message: "main.tex:24 Undefined …".
        const detail = typeof body.message === "string"
          ? body.message
              .trim()
              .replace(/^[^\n]*?[\\/]([^\\/:\n]+)(?=:\d+:)/, (_path: string, base: string) => (issueFile?.endsWith(base) ? issueFile : base))
              .replace(/^([^\n]*?:\d+):[ \t]*/, "$1 ")
          : "";
        nextTarget = {
          ...previous,
          building: false,
          failure: `ビルドできませんでした。${detail}`,
          issue: { file: issueFile, line: Number.isSafeInteger(issue?.line) && issue.line > 0 ? issue.line : null },
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

    host.send("paper:visibility:get", {});
    host.send("workspace:state:get", {});
    return unsubscribe;
  }, []);

  const currentMainFile = normalizeWorkspaceMainFile(currentDocument?.mainFile);
  const currentBuild = currentMainFile ? (builds[currentMainFile] ?? null) : null;
  const shown = useMemo<BuiltPage | null>(() => {
    const currentCatalog =
      pdfCatalog?.sessionKey === workspaceSessionKey(identity) ? pdfCatalog.paths : null;
    let remembered: string | null = null;
    if (typeof window !== "undefined" && identity.workspaceRoot && currentMainFile) {
      try {
        remembered = window.localStorage.getItem(rememberedPdfKey(identity, currentMainFile));
      } catch {
        // The workspace snapshot and current build still identify the PDF.
      }
    }
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
    // Keep the build state and the last displayed paper while Code is open.
    // When AI is shown again, only the newest missing revision needs a transfer.
    if (!paperVisible || loadedPdfRef.current?.key === expectedKey) return;
    const controller = new AbortController();
    // The host streams the PDF through its own scheme: a plain fetch of the
    // file, scoped to the current workspace. The bridge (base64 in a message)
    // is only the fallback for a host without the scheme.
    const streamedUrl = `tex64-pdf://workspace/${expectedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}?workspaceId=${encodeURIComponent(expected.workspaceId)}&workspaceGeneration=${encodeURIComponent(String(expected.workspaceGeneration))}`;
    const loadThroughBridge = () =>
      requestFromHost(host, {
        type: "file:bytes",
        resultType: "file:bytesResult",
        payload: {
          path: expectedPath,
          documentMainFile: expectedMainFile,
          ...workspaceRequestFields(expected),
        },
        timeoutMs: 30_000,
      }).then((reply) => {
        controller.signal.throwIfAborted();
        if (!nativePdfReplyMatches(reply, expected, expectedMainFile, expectedPath)) {
          throw new Error("The PDF response did not match its request.");
        }
        return new Blob([decodeNativePdf(reply.base64 as string, reply.byteSize)], { type: "application/pdf" });
      });
    const loadPdf = async () => {
      let response: Response;
      try {
        response = await fetch(streamedUrl, { cache: "no-store", signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return loadThroughBridge();
      }
      if (!response.ok) throw new Error(`PDF stream failed (${response.status}).`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("The PDF is empty.");
      return blob;
    };
    void loadPdf()
      .then((pdf) => {
        if (controller.signal.aborted || !sameWorkspaceSession(identityRef.current, expected)) return;
        const url = URL.createObjectURL(pdf);
        replaceLoadedPdf({ key: expectedKey, scopeKey: expectedScopeKey, url });
        setPdfLoadError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted && sameWorkspaceSession(identityRef.current, expected)) {
          setPdfLoadError({
            key: expectedKey,
            message: "PDFを読み込めませんでした。",
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [
    currentMainFile,
    identity,
    loadAttempt,
    loadKey,
    native,
    paperVisible,
    replaceLoadedPdf,
    scopeKey,
    shown?.path,
  ]);

  // Keep the prior successfully loaded page while a newer build of the same
  // document is transferred. A workspace/document change never shares scope.
  const url = scopeKey && loadedPdf?.scopeKey === scopeKey ? loadedPdf.url : null;
  const currentPdfLoadError =
    loadKey && pdfLoadError?.key === loadKey ? pdfLoadError.message : null;

  const readFailed = !currentBuild?.building && !currentBuild?.failure && Boolean(currentPdfLoadError);
  return {
    issue: readFailed ? null : currentBuild?.issue ?? null,
    retryPdfRead: readFailed ? () => {
      setPdfLoadError(null);
      setLoadAttempt(attempt => attempt + 1);
    } : null,
    url,
    sourceMapUrl: !currentBuild?.building && !currentBuild?.failure && loadedPdf?.key === loadKey ? url : null,
    path: shown?.path ?? null,
    building: currentBuild?.building ?? false,
    native,
    failure:
      currentBuild?.failure ??
      (currentBuild?.building ? null : currentPdfLoadError),
    hasWorkspace: identity.workspaceRoot !== null,
  };
}
