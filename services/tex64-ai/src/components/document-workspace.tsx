"use client";

import { ChevronDown, Plus, Sigma, SunMoon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentPanel } from "@/components/agent-panel";
import { DocumentCanvas, type SaveState } from "@/components/document-canvas";
import { NewDocumentPanel } from "@/components/new-document-panel";
import {
  createDocument,
  getDocument,
  listDocuments,
  patchDocument,
  startRun,
} from "@/lib/client/api";
import {
  diffDocumentPatch,
  mergePendingPatch,
  rebasePatchAfterConflict,
} from "@/lib/client/document-save";
import {
  createRunReplyInput,
  recoverableReplySource,
  runRequestIdentity,
  selectConversationRun,
} from "@/lib/client/run-input";
import { drainPendingSaves } from "@/lib/client/save-drain";
import { startSequentialPolling } from "@/lib/client/sequential-polling";
import type {
  AgentRun,
  CreateDocumentInput,
  DocumentChanges,
  DocumentDetail,
  DocumentPatch,
  DocumentSummary,
  StartRunInput,
} from "@/lib/client/types";
import { useDebouncedCallback } from "@/lib/client/use-debounced-callback";

type MobileView = "conversation" | "document";

type PendingSave = {
  id: string;
  baseline: DocumentDetail;
  patch: DocumentPatch;
  version: number;
};

type PendingRunRequest = {
  logicalKey: string;
  documentId: string;
  prompt: string;
  input: StartRunInput;
  idempotencyKey: string;
};

type PendingCreateRequest = CreateDocumentInput & { idempotencyKey: string };

export function DocumentWorkspace() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentCache, setDocumentCache] = useState<Record<string, DocumentDetail>>({});
  const [activeDocument, setActiveDocument] = useState<DocumentDetail | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>("conversation");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [connectionError, setConnectionError] = useState(false);
  const [documentMenuOpen, setDocumentMenuOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const completedRunRef = useRef<string | null>(null);
  const runSubmissionRef = useRef(false);
  const initialLoadRef = useRef(true);
  const navigationVersionRef = useRef(0);
  const selectedDocumentRef = useRef<string | null>(null);
  const latestDocumentsRef = useRef<Record<string, DocumentDetail>>({});
  const localMutationEpochRef = useRef<Record<string, number>>({});
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const saveVersionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const pendingRunRequestsRef = useRef(new Map<string, PendingRunRequest>());
  const failedRunRequestKeyRef = useRef<string | null>(null);
  const pendingCreateRequestRef = useRef<PendingCreateRequest | null>(null);
  const conversationRun = useMemo(
    () => selectConversationRun(activeDocument?.runs ?? [], activeRun),
    [activeDocument?.runs, activeRun],
  );

  const updateStoredDocument = useCallback((document: DocumentDetail, activate = false) => {
    latestDocumentsRef.current[document.id] = document;
    setActiveDocument((current) =>
      activate || current?.id === document.id ? document : current,
    );
    setDocumentCache((current) => ({ ...current, [document.id]: document }));
    setDocuments((current) => {
      const summary = toSummary(document);
      const exists = current.some((item) => item.id === document.id);
      return exists
        ? current.map((item) => (item.id === document.id ? summary : item))
        : [summary, ...current];
    });
  }, []);

  const canApplyRemoteDocument = useCallback(
    (id: string, requestEpoch: number, revision: number): boolean =>
      (localMutationEpochRef.current[id] ?? 0) === requestEpoch &&
      pendingSaveRef.current?.id !== id &&
      revision >= (latestDocumentsRef.current[id]?.revision ?? 0),
    [],
  );

  useLayoutEffect(() => {
    const saved = window.localStorage.getItem("tex64-theme");
    if (saved === "dark" || saved === "light") {
      document.documentElement.dataset.theme = saved;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void listDocuments().then(async (result) => {
      if (cancelled) return;
      if (!result.ok) {
        initialLoadRef.current = false;
        setConnectionError(true);
        return;
      }
      if (!initialLoadRef.current || selectedDocumentRef.current !== null) return;
      setConnectionError(false);
      setDocuments(result.data);

      const first = result.data[0];
      if (!first) {
        initialLoadRef.current = false;
        selectedDocumentRef.current = null;
        setActiveDocument(null);
        setActiveRun(null);
        return;
      }

      selectedDocumentRef.current = first.id;
      const detail = await getDocument(first.id);
      if (
        cancelled ||
        !initialLoadRef.current ||
        selectedDocumentRef.current !== first.id ||
        !detail.ok
      ) {
        if (!cancelled) initialLoadRef.current = false;
        if (!cancelled && !detail.ok) setConnectionError(true);
        return;
      }
      initialLoadRef.current = false;
      updateStoredDocument(detail.data, true);
      setActiveRun(detail.data.runs[0] ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [updateStoredDocument]);

  const performPatch = useCallback(
    async (pending: PendingSave): Promise<boolean> => {
      const id = pending.id;
      if (selectedDocumentRef.current === id) setSaveState("saving");
      let candidate = pending;
      let desired = latestDocumentsRef.current[id];
      if (!desired) return false;
      let requestPatch = {
        ...candidate.patch,
        baseRevision: desired.revision,
      };
      let result = await patchDocument(id, requestPatch);

      if (!result.ok && result.error === "conflict") {
        const latest = await getDocument(id);
        if (latest.ok) {
          const newest = pendingSaveRef.current;
          if (newest?.id === id && newest.version >= candidate.version) {
            candidate = newest;
          }
          desired = latestDocumentsRef.current[id] ?? desired;
          const rebased = rebasePatchAfterConflict({
            baseline: candidate.baseline,
            desired,
            patch: candidate.patch,
            remote: latest.data,
          });
          updateStoredDocument(rebased.desired);

          if (!rebased.patch) {
            if (pendingSaveRef.current?.version === candidate.version) {
              pendingSaveRef.current = null;
            }
            if (selectedDocumentRef.current === id) setSaveState("saved");
            return true;
          }

          candidate = { ...candidate, baseline: latest.data, patch: rebased.patch };
          if (pendingSaveRef.current?.version === candidate.version) {
            pendingSaveRef.current = candidate;
          }
          requestPatch = { ...candidate.patch, baseRevision: latest.data.revision };
          result = await patchDocument(id, requestPatch);
        }
      }

      if (!result.ok) {
        if (selectedDocumentRef.current === id) setSaveState("error");
        return false;
      }

      const local = latestDocumentsRef.current[id] ?? result.data;
      const currentPending = pendingSaveRef.current;
      if (currentPending?.id === id && currentPending.version > candidate.version) {
        const remainingPatch = diffDocumentPatch(result.data, local);
        pendingSaveRef.current = remainingPatch
          ? { ...currentPending, baseline: result.data, patch: remainingPatch }
          : null;
        updateStoredDocument(
          remainingPatch ? preserveLocalEdits(result.data, local) : result.data,
        );
      } else {
        if (currentPending?.id === id) pendingSaveRef.current = null;
        updateStoredDocument(result.data);
      }
      if (selectedDocumentRef.current === id) {
        setSaveState(pendingSaveRef.current?.id === id ? "saving" : "saved");
      }
      return true;
    },
    [updateStoredDocument],
  );

  const persistPatch = useCallback(
    (requested: PendingSave): Promise<boolean> => {
      const previous = saveInFlightRef.current;
      const operation = (async () => {
        if (previous) await previous;
        const newest = pendingSaveRef.current;
        if (!newest || newest.id !== requested.id) return true;
        return performPatch(
          newest.version >= requested.version ? newest : requested,
        );
      })();
      saveInFlightRef.current = operation;
      void operation.finally(() => {
        if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
      });
      return operation;
    },
    [performPatch],
  );

  const {
    schedule: scheduleSave,
    flush: flushSave,
    cancel: cancelSave,
  } = useDebouncedCallback(persistPatch, 700);

  const flushOutstandingSave = useCallback(async (): Promise<boolean> => {
    return drainPendingSaves({
      flushScheduled: flushSave,
      currentInFlight: () => saveInFlightRef.current,
      clearInFlight: (completed) => {
        if (saveInFlightRef.current === completed) saveInFlightRef.current = null;
      },
      currentPending: () => pendingSaveRef.current,
      cancelScheduled: cancelSave,
      persist: persistPatch,
    });
  }, [cancelSave, flushSave, persistPatch]);

  const handleDocumentChange = useCallback(
    (patch: DocumentChanges) => {
      if (!activeDocument) return;
      const nextDocument: DocumentDetail = {
        ...activeDocument,
        ...patch,
        artifactUrl: undefined,
        updatedAt: new Date().toISOString(),
      };
      const savePayload: DocumentPatch = {
        ...mergePendingPatch(
          pendingSaveRef.current?.id === activeDocument.id
            ? pendingSaveRef.current.baseline
            : activeDocument,
          pendingSaveRef.current?.id === activeDocument.id
            ? pendingSaveRef.current.patch
            : null,
          patch,
        ),
      };
      localMutationEpochRef.current[activeDocument.id] =
        (localMutationEpochRef.current[activeDocument.id] ?? 0) + 1;
      saveVersionRef.current += 1;
      pendingSaveRef.current = {
        id: activeDocument.id,
        baseline:
          pendingSaveRef.current?.id === activeDocument.id
            ? pendingSaveRef.current.baseline
            : activeDocument,
        patch: savePayload,
        version: saveVersionRef.current,
      };
      setSaveState("saving");
      updateStoredDocument(nextDocument);
      scheduleSave(pendingSaveRef.current);
    },
    [activeDocument, scheduleSave, updateStoredDocument],
  );

  const openDocument = useCallback(
    async (id: string) => {
      initialLoadRef.current = false;
      const navigationVersion = navigationVersionRef.current + 1;
      navigationVersionRef.current = navigationVersion;
      const saved = await flushOutstandingSave();
      if (saved === false || navigationVersionRef.current !== navigationVersion) return;
      selectedDocumentRef.current = id;
      setDocumentMenuOpen(false);
      setActiveRun(null);
      setSaveState("saved");
      setMobileView("document");

      const cached = documentCache[id];
      if (cached) {
        setActiveDocument(cached);
        setActiveRun(cached.runs[0] ?? null);
      }
      setDocumentLoading(!cached);

      const requestEpoch = localMutationEpochRef.current[id] ?? 0;
      const result = await getDocument(id);
      if (!result.ok) {
        if (selectedDocumentRef.current === id) {
          setDocumentLoading(false);
          setSaveState("error");
        }
        return;
      }
      const canApply = canApplyRemoteDocument(id, requestEpoch, result.data.revision);
      if (canApply) {
        updateStoredDocument(result.data, selectedDocumentRef.current === id);
      }
      if (selectedDocumentRef.current === id) {
        if (canApply) setActiveRun(result.data.runs[0] ?? null);
        setDocumentLoading(false);
      }
    },
    [canApplyRemoteDocument, documentCache, flushOutstandingSave, updateStoredDocument],
  );

  const beginRun = useCallback(
    async (
      document: DocumentDetail,
      prompt: string,
      input: StartRunInput = { prompt },
      retryPendingRequest = false,
    ) => {
      if (runSubmissionRef.current) return;
      runSubmissionRef.current = true;
      setSubmitting(true);
      completedRunRef.current = null;
      let request: PendingRunRequest | null = null;
      const showSubmissionFailure = () => {
        if (selectedDocumentRef.current !== document.id) return;
        const latestDocument = latestDocumentsRef.current[document.id] ?? document;
        setMobileView("conversation");
        setActiveRun(
          recoverableReplySource(latestDocument.runs, input) ??
            failedRequest(document.id, prompt),
        );
      };
      try {
        const saved = await flushOutstandingSave();
        if (saved === false || selectedDocumentRef.current !== document.id) {
          if (saved === false && selectedDocumentRef.current === document.id) {
            showSubmissionFailure();
          }
          return;
        }
        const logicalKey = runRequestIdentity(document.id, prompt, input);
        const retryKey = retryPendingRequest ? failedRunRequestKeyRef.current : null;
        const retryRequest = retryKey
          ? pendingRunRequestsRef.current.get(retryKey)
          : undefined;
        request =
          retryRequest?.documentId === document.id && retryRequest.prompt === prompt
            ? retryRequest
            : (pendingRunRequestsRef.current.get(logicalKey) ?? {
                logicalKey,
                documentId: document.id,
                prompt,
                input,
                idempotencyKey: window.crypto.randomUUID(),
              });
        rememberPendingRunRequest(pendingRunRequestsRef.current, request);
        const result = await startRun(
          document.id,
          request.input,
          request.idempotencyKey,
        );

        if (!result.ok) {
          failedRunRequestKeyRef.current = request.logicalKey;
          showSubmissionFailure();
          return;
        }

        pendingRunRequestsRef.current.delete(request.logicalKey);
        const failedRequestKey = failedRunRequestKeyRef.current;
        if (failedRequestKey) {
          pendingRunRequestsRef.current.delete(failedRequestKey);
          failedRunRequestKeyRef.current = null;
        }
        if (selectedDocumentRef.current !== document.id) return;
        setMobileView("conversation");

        setActiveRun(result.data);

        const latestDocument = latestDocumentsRef.current[document.id] ?? document;
        updateStoredDocument({
          ...latestDocument,
          status: "working",
          runs: [result.data, ...latestDocument.runs.filter((run) => run.id !== result.data.id)],
        });
      } catch {
        if (request) failedRunRequestKeyRef.current = request.logicalKey;
        showSubmissionFailure();
      } finally {
        runSubmissionRef.current = false;
        setSubmitting(false);
      }
    },
    [flushOutstandingSave, updateStoredDocument],
  );

  const createNewDocument = useCallback(
    async (prompt: string, kind: CreateDocumentInput["kind"]) => {
      initialLoadRef.current = false;
      const navigationVersion = navigationVersionRef.current + 1;
      navigationVersionRef.current = navigationVersion;
      cancelSave();
      setCreating(true);
      const previousRequest = pendingCreateRequestRef.current;
      const request =
        previousRequest?.prompt === prompt && previousRequest.kind === kind
          ? previousRequest
          : { prompt, kind, idempotencyKey: window.crypto.randomUUID() };
      pendingCreateRequestRef.current = request;
      const result = await createDocument(
        { prompt: request.prompt, kind: request.kind },
        request.idempotencyKey,
      );
      if (navigationVersionRef.current !== navigationVersion) {
        setCreating(false);
        return;
      }
      if (!result.ok) {
        setConnectionError(true);
        setCreating(false);
        return;
      }
      if (pendingCreateRequestRef.current?.idempotencyKey === request.idempotencyKey) {
        pendingCreateRequestRef.current = null;
      }
      setConnectionError(false);
      selectedDocumentRef.current = result.data.id;
      updateStoredDocument(result.data, true);
      setDocumentLoading(false);
      setCreating(false);
      await beginRun(result.data, prompt);
    },
    [beginRun, cancelSave, updateStoredDocument],
  );

  const submitWritingRequest = useCallback(
    (prompt: string) => {
      if (
        !activeDocument ||
        submitting ||
        conversationRun?.status === "queued" ||
        conversationRun?.status === "running"
      ) {
        return;
      }
      const reply = createRunReplyInput(conversationRun, prompt);
      void beginRun(
        activeDocument,
        prompt,
        reply,
        failedRunRequestKeyRef.current !== null,
      );
    },
    [activeDocument, beginRun, conversationRun, submitting],
  );

  useEffect(() => {
    if (!activeRun) return;
    if (
      ["waiting_approval", "completed", "failed", "cancelled"].includes(
        activeRun.status,
      ) || activeRun.stage === "needs_input"
    ) {
      return;
    }
    let cancelled = false;
    const stopPolling = startSequentialPolling(async () => {
      const requestEpoch = localMutationEpochRef.current[activeRun.documentId] ?? 0;
      const result = await getDocument(activeRun.documentId);
      if (cancelled || !result.ok) return;

      if (
        canApplyRemoteDocument(
          activeRun.documentId,
          requestEpoch,
          result.data.revision,
        )
      ) {
        updateStoredDocument(result.data);
      }
      const updatedRun = result.data.runs.find((run) => run.id === activeRun.id);
      if (updatedRun) {
        setActiveRun((current) =>
          current?.id === activeRun.id &&
          current.documentId === activeRun.documentId
            ? updatedRun
            : current,
        );
      }
    }, 2_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [activeRun, canApplyRemoteDocument, updateStoredDocument]);

  useEffect(() => {
    if (!activeRun || activeRun.status !== "completed") return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (cancelled || completedRunRef.current === activeRun.id) return;
      completedRunRef.current = activeRun.id;
      const requestEpoch = localMutationEpochRef.current[activeRun.documentId] ?? 0;

      void getDocument(activeRun.documentId).then((result) => {
        if (
          !cancelled &&
          result.ok &&
          canApplyRemoteDocument(
            activeRun.documentId,
            requestEpoch,
            result.data.revision,
          )
        ) {
          updateStoredDocument(result.data);
        }
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeRun, canApplyRemoteDocument, updateStoredDocument]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const isCommand = event.metaKey || event.ctrlKey;
      if (isCommand && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileView("conversation");
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
      if (isCommand && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void flushOutstandingSave();
      }
      if (event.key === "Escape") {
        setDocumentMenuOpen(false);
        setMobileView("document");
      }
    };

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [flushOutstandingSave]);

  const showNewDocument = async () => {
    initialLoadRef.current = false;
    const navigationVersion = navigationVersionRef.current + 1;
    navigationVersionRef.current = navigationVersion;
    const saved = await flushOutstandingSave();
    if (saved === false || navigationVersionRef.current !== navigationVersion) return;
    selectedDocumentRef.current = null;
    setDocumentMenuOpen(false);
    setActiveDocument(null);
    setActiveRun(null);
    setDocumentLoading(false);
    setMobileView("conversation");
    setSaveState("saved");
  };

  return (
    <div className="workspace-shell">
      <header className="app-topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Sigma size={17} strokeWidth={2.3} />
          </span>
          <strong>TeX64</strong>
        </div>

        <div className="document-switcher">
          <button
            type="button"
            className="document-switcher-button"
            aria-expanded={documentMenuOpen}
            onClick={() => setDocumentMenuOpen((open) => !open)}
          >
            <span>{activeDocument?.title ?? "新しい文書"}</span>
            {documents.length ? <ChevronDown aria-hidden="true" size={14} /> : null}
          </button>
          {documentMenuOpen && documents.length ? (
            <div className="document-menu" aria-label="文書を選ぶ">
              {documents.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={activeDocument?.id === item.id ? "page" : undefined}
                  onClick={() => void openDocument(item.id)}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-icon-button"
            aria-label="配色を切り替える"
            title="配色を切り替える"
            onClick={() => {
              const next =
                document.documentElement.dataset.theme === "dark" ? "light" : "dark";
              document.documentElement.dataset.theme = next;
              window.localStorage.setItem("tex64-theme", next);
            }}
          >
            <SunMoon size={16} />
          </button>
          <button
            type="button"
            className="topbar-new-button"
            aria-label="新規"
            onClick={() => void showNewDocument()}
          >
            <Plus aria-hidden="true" size={16} />
            <span>新規</span>
          </button>
        </div>
      </header>

      <div className="mobile-view-tabs" role="group" aria-label="表示">
        <button
          type="button"
          aria-pressed={mobileView === "conversation"}
          onClick={() => setMobileView("conversation")}
        >
          執筆
        </button>
        <button
          type="button"
          aria-pressed={mobileView === "document"}
          onClick={() => setMobileView("document")}
        >
          文書
        </button>
      </div>

      <div className="workspace-grid">
        <div
          className="workspace-pane pane-conversation"
          data-mobile-hidden={mobileView !== "conversation"}
        >
          {activeDocument ? (
            <AgentPanel
              document={activeDocument}
              activeRun={conversationRun}
              composerRef={composerRef}
              submitting={submitting}
              onSubmit={submitWritingRequest}
            />
          ) : (
            <NewDocumentPanel
              creating={creating}
              connectionError={connectionError}
              onSubmit={createNewDocument}
            />
          )}
        </div>

        <main
          className="workspace-pane pane-document"
          data-mobile-hidden={mobileView !== "document"}
        >
          {documentLoading ? (
            <DocumentSkeleton />
          ) : activeDocument ? (
            <DocumentCanvas
              document={activeDocument}
              saveState={saveState}
              requestPending={
                submitting ||
                conversationRun?.status === "queued" ||
                conversationRun?.status === "running"
              }
              onChange={handleDocumentChange}
              onAskAgent={submitWritingRequest}
            />
          ) : (
            <div className="empty-document-view" aria-hidden="true" />
          )}
        </main>
      </div>
    </div>
  );
}

function toSummary(document: DocumentDetail): DocumentSummary {
  return {
    id: document.id,
    title: document.title,
    kind: document.kind,
    status: document.status,
    updatedAt: document.updatedAt,
    preview: document.preview,
  };
}

function failedRequest(documentId: string, prompt: string): AgentRun {
  const now = new Date().toISOString();
  return {
    id: `request-failed-${window.crypto.randomUUID()}`,
    documentId,
    prompt,
    stage: "failed",
    status: "failed",
    createdAt: now,
    updatedAt: now,
  };
}

function rememberPendingRunRequest(
  requests: Map<string, PendingRunRequest>,
  request: PendingRunRequest,
): void {
  if (!requests.has(request.logicalKey) && requests.size >= 100) {
    const oldestKey = requests.keys().next().value;
    if (oldestKey !== undefined) requests.delete(oldestKey);
  }
  requests.set(request.logicalKey, request);
}

function preserveLocalEdits(
  remote: DocumentDetail,
  local: DocumentDetail,
): DocumentDetail {
  return {
    ...remote,
    title: local.title,
    eyebrow: local.eyebrow,
    author: local.author,
    status: local.status,
    updatedAt: local.updatedAt,
    preview: local.preview,
    blocks: local.blocks,
    artifactUrl: undefined,
  };
}

function DocumentSkeleton() {
  return (
    <div className="canvas-skeleton" role="status" aria-label="文書を読み込んでいます">
      <div className="canvas-skeleton-paper">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
