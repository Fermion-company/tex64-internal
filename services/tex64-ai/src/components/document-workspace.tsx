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
  patchDocument,
  restoreDocument,
  sendMessage,
} from "@/lib/client/api";
import {
  diffDocumentPatch,
  mergePendingPatch,
  rebasePatchAfterConflict,
} from "@/lib/client/document-save";
import { drainPendingSaves } from "@/lib/client/save-drain";
import { useWorkspacePdf } from "@/lib/client/use-workspace-pdf";
import type {
  ChatMessage,
  CreateDocumentInput,
  DocumentBlock,
  DocumentChanges,
  DocumentDetail,
  DocumentPatch,
  DocumentSummary,
} from "@/lib/client/types";
import { useDebouncedCallback } from "@/lib/client/use-debounced-callback";

type MobileView = "conversation" | "document";

/** How long editing must be quiet before the page catches up on its own. */
const IDLE_COMPILE_DELAY_MS = 8_000;

const KIND_LABELS: Record<string, string> = {
  // `proposal` is the stored/API value; 企画書 is what the user reads.
  proposal: "企画書",
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

type PendingCreateRequest = CreateDocumentInput & { idempotencyKey: string };

export function DocumentWorkspace() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentCache, setDocumentCache] = useState<Record<string, DocumentDetail>>({});
  const [activeDocument, setActiveDocument] = useState<DocumentDetail | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>("conversation");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [creating, setCreating] = useState(false);
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
  const [streamingText, setStreamingText] = useState("");
  const [activityTool, setActivityTool] = useState<string | null>(null);
  const [turnDocumentId, setTurnDocumentId] = useState<string | null>(null);
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const compileInFlightRef = useRef(false);
  const lastFailedCompileRef = useRef<string | null>(null);
  const flushOutstandingSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const turnAbortRef = useRef<AbortController | null>(null);
  const queuedPromptRef = useRef<string | null>(null);
  const runTurnRef = useRef<
    ((document: DocumentDetail, prompt: string, targetNodeId?: string) => Promise<void>) | null
  >(null);
  const initialLoadRef = useRef(true);
  const navigationVersionRef = useRef(0);
  const selectedDocumentRef = useRef<string | null>(null);
  const latestDocumentsRef = useRef<Record<string, DocumentDetail>>({});
  const localMutationEpochRef = useRef<Record<string, number>>({});
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const saveVersionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const pendingCreateRequestRef = useRef<PendingCreateRequest | null>(null);
  const agentWorking = turnDocumentId !== null;
  const messages = useMemo<ChatMessage[]>(
    () => activeDocument?.messages ?? [],
    [activeDocument?.messages],
  );
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
  // Inside the desktop app the page comes from the workspace build, not from
  // this service's own artifact.
  const workspacePdf = useWorkspacePdf();
  const ownPdfUrl = activeDocument
    ? (activeDocument.previewUrl ??
      (lastPreview?.documentId === activeDocument.id ? lastPreview.url : null))
    : null;
  const displayPdfUrl = workspacePdf.native ? workspacePdf.url : ownPdfUrl;
  const previewStale = workspacePdf.native
    ? workspacePdf.building
    : Boolean(displayPdfUrl && !activeDocument?.previewUrl);

  // Selections and one-off run telemetry do not survive document switches.
  const [selectionDocumentId, setSelectionDocumentId] =
    useState<string | null>(activeDocumentId);
  if (selectionDocumentId !== activeDocumentId) {
    setSelectionDocumentId(activeDocumentId);
    setSelectedElementId(null);
    setHistoryOpen(false);
    setCompileFailed(false);
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
    if (saveState !== "saved" || agentWorking || compiling) return;
    if (
      lastFailedCompileRef.current === `${activeDocumentId}:${activeRevision}`
    ) {
      return;
    }
    // Typing must not drag a typesetting run behind it. The page catches up
    // on its own once editing has clearly stopped; 確定 does it immediately.
    const timer = window.setTimeout(() => {
      void runCompile(activeDocumentId, activeRevision);
    }, IDLE_COMPILE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    activeDocumentId,
    activeRevision,
    hasPreview,
    documentHasContent,
    saveState,
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
      setSaveState("saved");
      setMobileView("document");

      const cached = documentCache[id];
      if (cached) setActiveDocument(cached);
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
      if (selectedDocumentRef.current === id) setDocumentLoading(false);
    },
    [canApplyRemoteDocument, documentCache, flushOutstandingSave, updateStoredDocument],
  );

  const refreshAfterTurn = useCallback(
    async (documentId: string) => {
      const requestEpoch = localMutationEpochRef.current[documentId] ?? 0;
      const result = await getDocument(documentId);
      if (!result.ok) return;
      if (canApplyRemoteDocument(documentId, requestEpoch, result.data.revision)) {
        updateStoredDocument(result.data);
      }
    },
    [canApplyRemoteDocument, updateStoredDocument],
  );

  /**
   * Runs one conversation turn and renders it as it happens. The reply, the
   * tool the agent is running, and every new revision arrive on the same
   * stream; aborting the controller interrupts the turn on the server too.
   */
  const runTurn = useCallback(
    async (document: DocumentDetail, prompt: string, targetNodeId?: string) => {
      const saved = await flushOutstandingSave();
      if (saved === false || selectedDocumentRef.current !== document.id) return;

      const controller = new AbortController();
      turnAbortRef.current = controller;
      setTurnDocumentId(document.id);
      setStreamingText("");
      setActivityTool(null);
      setTurnError(null);
      setMobileView("conversation");
      // The user's own message is shown immediately; the server persists it
      // as part of the turn.
      updateStoredDocument({
        ...(latestDocumentsRef.current[document.id] ?? document),
        status: "working",
        messages: [
          ...(latestDocumentsRef.current[document.id] ?? document).messages,
          {
            id: `local:${Date.now()}`,
            role: "user",
            text: prompt,
            createdAt: new Date().toISOString(),
          },
        ],
      });

      let revisionChanged = false;
      const result = await sendMessage(
        document.id,
        targetNodeId ? { prompt, targetNodeId } : { prompt },
        (frame) => {
          switch (frame.type) {
            case "text":
              setStreamingText((current) => current + frame.delta);
              setActivityTool(null);
              break;
            case "tool":
              if (frame.state === "start") setActivityTool(frame.name);
              break;
            case "revision":
            case "compiled":
              revisionChanged = true;
              break;
            case "error":
              setTurnError(frame.message);
              break;
            default:
              break;
          }
        },
        controller.signal,
      );

      turnAbortRef.current = null;
      setTurnDocumentId(null);
      setActivityTool(null);
      setStreamingText("");
      if (!result.ok) {
        setTurnError("送信できませんでした。もう一度お試しください。");
        return;
      }
      // The stored thread now holds the assistant's reply; reloading also
      // picks up the new revision and its page.
      await refreshAfterTurn(document.id);
      if (revisionChanged) setCompileFailed(false);

      // A message typed while this turn was running goes next, in order.
      const queued = queuedPromptRef.current;
      if (queued) {
        queuedPromptRef.current = null;
        setQueuedPrompt(null);
        const latest = latestDocumentsRef.current[document.id] ?? document;
        void runTurnRef.current?.(latest, queued);
      }
    },
    [
      flushOutstandingSave,
      refreshAfterTurn,
      updateStoredDocument,
    ],
  );

  useEffect(() => {
    runTurnRef.current = runTurn;
  }, [runTurn]);

  const confirmSelectionEdit = useCallback(async () => {
    const documentId = selectedDocumentRef.current;
    setSelectedElementId(null);
    if (!documentId) return;
    const saved = await flushOutstandingSave();
    if (saved === false) return;
    const revision = latestDocumentsRef.current[documentId]?.revision;
    if (revision !== undefined) void runCompile(documentId, revision);
  }, [flushOutstandingSave, runCompile]);

  const stopTurn = useCallback(() => {
    queuedPromptRef.current = null;
    setQueuedPrompt(null);
    turnAbortRef.current?.abort();
  }, []);

  const createNewDocument = useCallback(
    async (prompt: string) => {
      initialLoadRef.current = false;
      const navigationVersion = navigationVersionRef.current + 1;
      navigationVersionRef.current = navigationVersion;
      cancelSave();
      setCreating(true);
      const previousRequest = pendingCreateRequestRef.current;
      const request =
        previousRequest?.prompt === prompt
          ? previousRequest
          : { prompt, idempotencyKey: window.crypto.randomUUID() };
      pendingCreateRequestRef.current = request;
      // No `kind`: the server infers it from the prompt.
      const result = await createDocument({ prompt: request.prompt }, request.idempotencyKey);
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
      await runTurn(result.data, prompt);
    },
    [cancelSave, runTurn, updateStoredDocument],
  );

  const submitWritingRequest = useCallback(
    (prompt: string) => {
      if (!activeDocument) return;
      // A message sent while the agent is working waits its turn instead of
      // being refused; the composer never locks.
      if (agentWorking) {
        queuedPromptRef.current = prompt;
        setQueuedPrompt(prompt);
        return;
      }
      const targetNodeId = selectedElement?.id;
      setSelectedElementId(null);
      void runTurn(activeDocument, prompt, targetNodeId);
    },
    [activeDocument, agentWorking, runTurn, selectedElement],
  );

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
              messages={messages}
              streamingText={streamingText}
              activityTool={activityTool}
              isWorking={agentWorking}
              queuedPrompt={queuedPrompt}
              error={turnError}
              selectedElement={selectedElement}
              composerRef={composerRef}
              onSubmit={submitWritingRequest}
              onStop={stopTurn}
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
                          {/* 閉じる＝編集はそのまま残る。確定＝いま組版まで進める。 */}
                          <button
                            type="button"
                            className="element-card-close"
                            onClick={() => setSelectedElementId(null)}
                          >
                            閉じる
                          </button>
                          <strong>{selectedElement.label}</strong>
                          <div className="element-card-head-actions">
                            {selectedBlock ? (
                              <button
                                type="button"
                                className="element-card-delete"
                                disabled={agentWorking || restoring}
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
                              className="element-card-confirm"
                              disabled={agentWorking || restoring}
                              onClick={() => {
                                void confirmSelectionEdit();
                              }}
                            >
                              確定
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
                              readOnly={agentWorking || restoring}
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
