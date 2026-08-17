"use client";

import { ChevronDown, History, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentPanel } from "@/components/agent-panel";
import { BlockEditor, type SaveState } from "@/components/document-canvas";
import { NewDocumentPanel } from "@/components/new-document-panel";
import { PdfPreview, type PdfElementRegion, type PdfRegionRect } from "@/components/pdf-preview";
import {
  compileDocument,
  createDocument,
  getDocument,
  listDocuments,
  listRunEvents,
  patchDocument,
  restoreDocument,
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
  DocumentBlock,
  DocumentChanges,
  DocumentDetail,
  DocumentPatch,
  DocumentSummary,
  RunProgressEvent,
  StartRunInput,
} from "@/lib/client/types";
import { useDebouncedCallback } from "@/lib/client/use-debounced-callback";

type MobileView = "conversation" | "document";

const KIND_LABELS: Record<string, string> = {
  proposal: "提案書",
  report: "報告書",
  paper: "論文",
  memo: "メモ",
};

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
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [regionNodes, setRegionNodes] = useState<{
    url: string;
    nodes: { id: string; rects: PdfRegionRect[] }[];
  } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileFailed, setCompileFailed] = useState(false);
  const [progressEvents, setProgressEvents] = useState<RunProgressEvent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const compileInFlightRef = useRef(false);
  const lastFailedCompileRef = useRef<string | null>(null);
  const flushOutstandingSaveRef = useRef<(() => Promise<boolean>) | null>(null);
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
  const agentWorking =
    conversationRun?.status === "queued" || conversationRun?.status === "running";
  const selectedElement = useMemo(
    () =>
      activeDocument?.elements.find(
        (element) => element.id === selectedElementId,
      ) ?? null,
    [activeDocument?.elements, selectedElementId],
  );
  const pdfRegions = useMemo<PdfElementRegion[] | null>(() => {
    if (!regionNodes || !activeDocument) return null;
    if (regionNodes.url !== activeDocument.regionsUrl) return null;
    const labelById = new Map(
      activeDocument.elements.map((element) => [element.id, element.label]),
    );
    const joined = regionNodes.nodes.flatMap((node) => {
      const label = labelById.get(node.id);
      return label ? [{ id: node.id, label, rects: node.rects }] : [];
    });
    return joined.length > 0 ? joined : null;
  }, [activeDocument, regionNodes]);
  const selectedBlock = useMemo<DocumentBlock | null>(
    () =>
      activeDocument?.blocks.find((block) => block.id === selectedElementId) ??
      null,
    [activeDocument?.blocks, selectedElementId],
  );
  const { selectedHeadingNumber, selectedEquationNumber } = useMemo(() => {
    let headingNumber: number | undefined;
    let equationNumber: number | undefined;
    if (activeDocument && selectedBlock) {
      let headings = 0;
      let equations = 0;
      for (const block of activeDocument.blocks) {
        if (block.type === "heading" && block.level === 1) headings += 1;
        if (block.type === "equation") equations += 1;
        if (block.id === selectedBlock.id) {
          if (block.type === "heading" && block.level === 1) {
            headingNumber = headings;
          }
          if (block.type === "equation") equationNumber = equations;
          break;
        }
      }
    }
    return {
      selectedHeadingNumber: headingNumber,
      selectedEquationNumber: equationNumber,
    };
  }, [activeDocument, selectedBlock]);

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

  // Element-region map for the PDF overlay. Keyed on the immutable per-PDF
  // URL so the 2-second document polling never refetches it; state carries
  // its own key so switching PDFs needs no synchronous reset.
  const regionsUrl = activeDocument?.regionsUrl ?? null;
  useEffect(() => {
    if (!regionsUrl) return;
    let cancelled = false;
    void fetch(regionsUrl, { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled) return;
        const nodes =
          payload &&
          typeof payload === "object" &&
          "regions" in payload &&
          payload.regions &&
          typeof payload.regions === "object" &&
          "nodes" in payload.regions &&
          Array.isArray(payload.regions.nodes)
            ? (payload.regions.nodes as { id: string; rects: PdfRegionRect[] }[])
            : null;
        setRegionNodes(nodes ? { url: regionsUrl, nodes } : null);
      })
      .catch(() => {
        if (!cancelled) setRegionNodes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [regionsUrl]);

  // 紙面 (PDF) is the default surface once a document has typeset output;
  // documents without one open on 構成 so first-time generation stays visible.
  // Once in 紙面, losing previewUrl (a manual edit staled the artifact) never
  // bounces the view back — the stale paper stays visible while recompiling.
  // State adjustments happen during render (not in effects) per house rules.
  const activeDocumentId = activeDocument?.id ?? null;
  const hasPreview = Boolean(activeDocument?.previewUrl);
  // Keep the last typeset PDF on screen while a newer revision compiles.
  const [lastPreview, setLastPreview] = useState<{
    documentId: string;
    url: string;
  } | null>(null);
  if (
    activeDocument?.previewUrl &&
    (lastPreview?.documentId !== activeDocument.id ||
      lastPreview.url !== activeDocument.previewUrl)
  ) {
    setLastPreview({ documentId: activeDocument.id, url: activeDocument.previewUrl });
  }
  const displayPdfUrl = activeDocument
    ? (activeDocument.previewUrl ??
      (lastPreview?.documentId === activeDocument.id ? lastPreview.url : null))
    : null;
  const previewStale = Boolean(displayPdfUrl && !activeDocument?.previewUrl);

  // Selections and one-off run telemetry do not survive document switches.
  const [selectionDocumentId, setSelectionDocumentId] =
    useState<string | null>(activeDocumentId);
  if (selectionDocumentId !== activeDocumentId) {
    setSelectionDocumentId(activeDocumentId);
    setSelectedElementId(null);
    setHistoryOpen(false);
    setCompileFailed(false);
  }
  const conversationRunId = conversationRun?.id ?? null;
  const [progressRunId, setProgressRunId] = useState<string | null>(conversationRunId);
  if (progressRunId !== conversationRunId) {
    setProgressRunId(conversationRunId);
    setProgressEvents([]);
  }

  const runCompile = useCallback(
    async (documentId: string, revision: number) => {
      if (compileInFlightRef.current) return;
      compileInFlightRef.current = true;
      setCompiling(true);
      const requestEpoch = localMutationEpochRef.current[documentId] ?? 0;
      try {
        const result = await compileDocument(documentId);
        if (selectedDocumentRef.current !== documentId) return;
        if (result.ok) {
          setCompileFailed(false);
          if (
            canApplyRemoteDocument(documentId, requestEpoch, result.data.revision)
          ) {
            updateStoredDocument(result.data);
          }
        } else {
          // Key the failure to the revision this request compiled so a newer
          // revision still auto-compiles.
          lastFailedCompileRef.current = `${documentId}:${revision}`;
          setCompileFailed(true);
        }
      } finally {
        compileInFlightRef.current = false;
        setCompiling(false);
      }
    },
    [canApplyRemoteDocument, updateStoredDocument],
  );

  // Keep the paper alive: after manual edits (or a restore) settle, the
  // current revision recompiles automatically. A failed revision does not
  // retry until it changes; the banner offers a manual retry instead.
  const activeRevision = activeDocument?.revision ?? null;
  const documentHasContent = Boolean(
    activeDocument &&
      (activeDocument.blocks.length > 0 || activeDocument.elements.length > 0),
  );
  useEffect(() => {
    if (!activeDocumentId || activeRevision === null) return;
    if (hasPreview || !documentHasContent) return;
    if (saveState !== "saved" || submitting || agentWorking || compiling) return;
    if (
      lastFailedCompileRef.current === `${activeDocumentId}:${activeRevision}`
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runCompile(activeDocumentId, activeRevision);
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [
    activeDocumentId,
    activeRevision,
    hasPreview,
    documentHasContent,
    saveState,
    submitting,
    agentWorking,
    compiling,
    runCompile,
  ]);

  const restoreVersion = useCallback(
    async (revision: number) => {
      if (!activeDocumentId || restoring) return;
      setRestoring(true);
      try {
        const saved = await flushOutstandingSaveRef.current?.();
        if (saved === false) return;
        const result = await restoreDocument(activeDocumentId, revision);
        if (result.ok && selectedDocumentRef.current === activeDocumentId) {
          localMutationEpochRef.current[activeDocumentId] =
            (localMutationEpochRef.current[activeDocumentId] ?? 0) + 1;
          lastFailedCompileRef.current = null;
          updateStoredDocument(result.data, true);
          setHistoryOpen(false);
        }
      } finally {
        setRestoring(false);
      }
    },
    [activeDocumentId, restoring, updateStoredDocument],
  );

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
  useEffect(() => {
    flushOutstandingSaveRef.current = flushOutstandingSave;
  }, [flushOutstandingSave]);

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

  const updateBlockById = useCallback(
    (id: string, next: DocumentBlock) => {
      const current = activeDocument;
      if (!current) return;
      handleDocumentChange({
        blocks: current.blocks.map((block) => (block.id === id ? next : block)),
      });
    },
    [activeDocument, handleDocumentChange],
  );

  const removeBlockById = useCallback(
    (id: string) => {
      const current = activeDocument;
      if (!current) return;
      handleDocumentChange({
        blocks: current.blocks.filter((block) => block.id !== id),
      });
      setSelectedElementId(null);
    },
    [activeDocument, handleDocumentChange],
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
      // Element selection scopes fresh requests only; clarification answers
      // and approval decisions keep their original scope. selectedElement is
      // resolved against the CURRENT document, so a selection whose element
      // was deleted in the meantime scopes nothing.
      const input: StartRunInput =
        !reply.replyToRunId && selectedElement
          ? { ...reply, targetNodeId: selectedElement.id }
          : reply;
      setSelectedElementId(null);
      void beginRun(
        activeDocument,
        prompt,
        input,
        failedRunRequestKeyRef.current !== null,
      );
    },
    [activeDocument, beginRun, conversationRun, selectedElement, submitting],
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
      const [result, events] = await Promise.all([
        getDocument(activeRun.documentId),
        listRunEvents(activeRun.documentId, activeRun.id),
      ]);
      if (cancelled) return;
      if (events.ok) setProgressEvents(events.data);
      if (!result.ok) return;

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
        setHistoryOpen(false);
        setSelectedElementId(null);
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
        <div className="topbar-left">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/tex64-icon.png" alt="" width={30} height={30} />
            </span>
            <span className="brand-separator" aria-hidden="true">
              /
            </span>
          </div>
          <div className="document-switcher">
            <button
              type="button"
              className="document-switcher-button"
              aria-expanded={documentMenuOpen}
              onClick={() => setDocumentMenuOpen((open) => !open)}
            >
              <span className="document-switcher-titles">
                <strong>{activeDocument?.title ?? "新しい文書"}</strong>
                <small>
                  {activeDocument
                    ? (KIND_LABELS[activeDocument.kind] ?? "文書")
                    : "TeX64"}
                </small>
              </span>
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
        </div>

        <div className="topbar-actions">
          {activeDocument && activeDocument.versions.length > 0 ? (
            <div className="history-anchor">
              <button
                type="button"
                className="topbar-icon-button"
                aria-label="変更履歴"
                title="変更履歴"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <History size={16} />
              </button>
              {historyOpen ? (
                <div className="history-panel" aria-label="変更履歴">
                  <span className="history-title">変更履歴</span>
                  <div className="history-items">
                    {activeDocument.versions.map((version) => (
                      <div className="history-item" key={version.id}>
                        <div className="history-item-main">
                          <strong>{version.label}</strong>
                          <small>
                            {formatHistoryTimestamp(version.createdAt)}
                            {" ・ "}
                            {version.source === "agent" ? "AI" : "手動"}
                          </small>
                        </div>
                        {version.revision < activeDocument.revision ? (
                          <button
                            type="button"
                            disabled={restoring || agentWorking}
                            onClick={() => void restoreVersion(version.revision)}
                          >
                            この状態に戻す
                          </button>
                        ) : (
                          <span className="history-current">現在</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
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
              progressEvents={progressEvents}
              selectedElement={selectedElement}
              composerRef={composerRef}
              submitting={submitting}
              onSubmit={submitWritingRequest}
              onClearSelection={() => setSelectedElementId(null)}
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
            <section className="paper-surface" aria-label="紙面">
                <PdfPreview
                  pdfUrl={displayPdfUrl}
                  regions={pdfRegions}
                  selectedId={selectedElementId}
                  refreshing={
                    compiling ||
                    previewStale ||
                    (agentWorking && displayPdfUrl !== null)
                  }
                  interactive
                  onSelect={(id) => setSelectedElementId(id)}
                  emptyHint={
                    agentWorking
                      ? "紙面を準備しています…"
                      : documentHasContent
                        ? "紙面を組み立てています…"
                        : "まだ紙面がありません。左の欄から執筆を依頼してください。"
                  }
                  selectionCard={
                    selectedElement ? (
                      <div className="element-card" aria-label="選択中の要素">
                        <div className="element-card-head">
                          <strong>{selectedElement.label}</strong>
                          <div className="element-card-head-actions">
                            {selectedBlock ? (
                              <button
                                type="button"
                                className="element-card-delete"
                                disabled={agentWorking || submitting || restoring}
                                onClick={() => {
                                  if (window.confirm("この部分を削除しますか？")) {
                                    removeBlockById(selectedBlock.id);
                                  }
                                }}
                              >
                                削除
                              </button>
                            ) : null}
                            <button
                              type="button"
                              aria-label="選択を解除"
                              onClick={() => setSelectedElementId(null)}
                            >
                              閉じる
                            </button>
                          </div>
                        </div>
                        {selectedBlock ? (
                          <div className="element-card-editor">
                            <BlockEditor
                              block={selectedBlock}
                              headingNumber={selectedHeadingNumber}
                              equationNumber={selectedEquationNumber}
                              onChange={(next) => updateBlockById(selectedBlock.id, next)}
                              readOnly={agentWorking || submitting || restoring}
                            />
                          </div>
                        ) : (
                          <div className="element-card-hint">
                            <p>この要素は左の欄から依頼して編集します。</p>
                          </div>
                        )}
                      </div>
                    ) : null
                  }
                />
                {compileFailed ? (
                  <div className="compile-banner" role="alert">
                    <span>紙面を更新できませんでした。</span>
                    <button
                      type="button"
                      onClick={() => {
                        lastFailedCompileRef.current = null;
                        setCompileFailed(false);
                        void runCompile(activeDocument.id, activeDocument.revision);
                      }}
                    >
                      再試行
                    </button>
                  </div>
                ) : null}
              </section>
          ) : (
            <div className="empty-document-view" aria-hidden="true" />
          )}
        </main>
      </div>
    </div>
  );
}

function formatHistoryTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
