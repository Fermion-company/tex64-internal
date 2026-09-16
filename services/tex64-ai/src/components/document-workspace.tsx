"use client";

import { ChevronDown, History, Play, Plus, Undo2 } from "lucide-react";
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
import {
  conversationIdFor,
  loadNativeConversation,
  nativeConversationRestoreMode,
  nativeTerminalFailed,
  nativeThreadSessionKey,
  runNativeTurn,
  scheduleAttachedAbortFallback,
  stopWorkspaceTurn,
  undoNativeConversation,
} from "@/lib/client/native-agent";
import { getNativeHost, hostMessageBody, requestFromHost, type HostMessage } from "@/lib/client/native-host";
import {
  requestWorkspaceBuild,
  useNativeWorkspace,
} from "@/lib/client/use-native-workspace";
import { useParagraphEditor } from "@/lib/client/use-paragraph-editor";
import { useSourceLocator } from "@/lib/client/use-source-locator";
import { useWorkspacePdf } from "@/lib/client/use-workspace-pdf";
import { useNativePlatform } from "@/lib/client/use-native-platform";
import { NativeWorkspacePanel } from "@/components/native-workspace-panel";
import { NativePlatformControls } from "@/components/native-platform-controls";
import { ParagraphEditCard } from "@/components/paragraph-edit-card";
import type { PdfAnchor } from "@/components/pdf-preview";
import { workspaceRequestFields } from "@/lib/client/workspace-identity";
import {
  attachmentBase64,
  prepareAttachments,
  releasePendingAttachment,
  type PendingAttachment,
} from "@/lib/client/attachments";
import type {
  AgentProposal,
  ChatAttachment,
  ChatMessage,
  MessagePart,
  CreateDocumentInput,
  DocumentBlock,
  DocumentChanges,
  DocumentDetail,
  DocumentPatch,
  DocumentSummary,
  TurnFrame,
} from "@/lib/client/types";
import { useDebouncedCallback } from "@/lib/client/use-debounced-callback";


type NativeTurnOptions = {
  /** A step explicitly picked by the user. */
  origin?: "step";
  /** With "step": a writing step withholds the edit tools on its first turn. */
  stepKind?: "mechanical" | "writing";
  /** Attached files as message parts; the first text part is the prompt. */
  parts?: MessagePart[];
  /** The files as the chat shows them under the user's message. */
  attachments?: ChatAttachment[];
};

/**
 * A message waiting for the agent. Files are prepared (saved into the
 * workspace, read, rendered) while the message already shows as waiting.
 */
type QueuedTurn = {
  id: string;
  prompt: string;
  preparing?: boolean;
  parts?: MessagePart[];
  attachments?: ChatAttachment[];
};

/** The next steps the agent last attached; an assistant reply without any ends the list. */
function latestProposalsOf(messages: ChatMessage[]): AgentProposal[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    return message.proposals && message.proposals.length > 0 ? message.proposals : [];
  }
  return [];
}

function proposalKeyOf(proposals: AgentProposal[]): string {
  return proposals.map((proposal) => `${proposal.id}:${proposal.line ?? ""}`).join("|");
}

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
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedTurn[]>([]);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const compileInFlightRef = useRef(false);
  const lastFailedCompileRef = useRef<string | null>(null);
  const flushOutstandingSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const turnAbortRef = useRef<AbortController | null>(null);
  const queuedPromptsRef = useRef<QueuedTurn[]>([]);
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
  // Code and AI share the same workspace and configured build root. AI has no
  // private document list or document-creation flow inside the desktop app.
  const nativeWorkspace = useNativeWorkspace();
  const nativePlatform = useNativePlatform();
  const nativeWorkspaceId = nativeWorkspace.workspaceId;
  const nativeMainFile = nativeWorkspace.current?.mainFile ?? null;
  const nativeWorkspaceIdentity = useMemo(
    () => ({
      workspaceId: nativeWorkspace.workspaceId,
      workspaceRoot: nativeWorkspace.workspaceRoot,
      workspaceGeneration: nativeWorkspace.workspaceGeneration,
    }),
    [
      nativeWorkspace.workspaceGeneration,
      nativeWorkspace.workspaceId,
      nativeWorkspace.workspaceRoot,
    ],
  );
  const workspacePdf = useWorkspacePdf(nativeWorkspace.current);
  /** A step the user picked on the page; the chat handles it like a row. */
  const [chosenProposal, setChosenProposal] = useState<{ proposal: AgentProposal; pick: number } | null>(null);
  /** The next step under the pointer or keyboard, highlighted in both panes. */
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  /** Proposed steps placed on the page via forward SyncTeX, for one PDF and one proposal set. */
  const [pageAnchors, setPageAnchors] = useState<{ pdfPath: string; key: string; anchors: PdfAnchor[] } | null>(null);
  const nativeDocumentContext = useMemo(
    () => ({
      ...nativeWorkspaceIdentity,
      documentMainFile: nativeMainFile,
      conversationId:
        nativeMainFile && nativeWorkspaceId
          ? conversationIdFor(nativeWorkspaceId, nativeMainFile)
          : null,
    }),
    [nativeMainFile, nativeWorkspaceId, nativeWorkspaceIdentity],
  );
  const sourceLocator = useSourceLocator(nativeDocumentContext);
  const paragraphEditor = useParagraphEditor(nativeDocumentContext);
  const sourceLocation = sourceLocator.location;
  const clearSourceLocation = sourceLocator.clear;
  const openParagraphEditor = paragraphEditor.open;

  // A paper click is already an editing intent. Resolve it and open the
  // human-facing editor directly; never stop at a source file/line card.
  useEffect(() => {
    const location = sourceLocation;
    if (!workspacePdf.native || !location) return;
    openParagraphEditor({
      path: location.path,
      line: location.line,
      selectedText: location.selectedText,
    });
    clearSourceLocation();
  }, [
    clearSourceLocation,
    openParagraphEditor,
    sourceLocation,
    workspacePdf.native,
  ]);
  const agentWorking = turnDocumentId !== null;
  // The desktop agent keeps its own thread; this service's document knows
  // nothing about it, so reloading the document must not wipe the chat.
  const [nativeMessages, setNativeMessages] = useState<ChatMessage[]>([]);
  const [nativeUndoCount, setNativeUndoCount] = useState(0);
  const [nativeHistoryLoading, setNativeHistoryLoading] = useState(false);
  const [nativeTurnStopping, setNativeTurnStopping] = useState(false);
  const nativeThreadWorking =
    turnDocumentId !== null &&
    turnDocumentId === nativeDocumentContext.conversationId;
  const messages = useMemo<ChatMessage[]>(
    () => (workspacePdf.native ? nativeMessages : (activeDocument?.messages ?? [])),
    [activeDocument?.messages, nativeMessages, workspacePdf.native],
  );
  const enqueuePrompt = useCallback((turn: QueuedTurn) => {
    const next = [...queuedPromptsRef.current, turn];
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);
  const updateQueuedTurn = useCallback((id: string, patch: Partial<QueuedTurn>) => {
    const next = queuedPromptsRef.current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn));
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);
  const takeQueuedPrompt = useCallback((): QueuedTurn | null => {
    const [nextPrompt, ...remaining] = queuedPromptsRef.current;
    queuedPromptsRef.current = remaining;
    setQueuedPrompts(remaining);
    return nextPrompt ?? null;
  }, []);
  const clearQueuedPrompts = useCallback(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
  }, []);
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
  const ownPdfUrl = activeDocument
    ? (activeDocument.previewUrl ??
      (lastPreview?.documentId === activeDocument.id ? lastPreview.url : null))
    : null;
  const latestProposals = latestProposalsOf(messages);
  const latestProposalKey = proposalKeyOf(latestProposals);

  // Each proposed step that names a source line is pinned to the page it
  // lands on, so the paper shows the same next steps as the chat.
  useEffect(() => {
    const host = getNativeHost();
    const pdfPath = workspacePdf.native ? workspacePdf.path : null;
    const mainFile = nativeWorkspace.current?.mainFile ?? null;
    const identity = nativeWorkspaceIdentity;
    const proposals = latestProposalsOf(messages);
    const anchored = proposals.filter((proposal) => typeof proposal.line === "number");
    if (!host || !pdfPath || !mainFile || anchored.length === 0 || workspacePdf.building) {
      return;
    }
    const key = proposalKeyOf(proposals);
    let cancelled = false;
    // One request resolves every line from the host's in-memory SyncTeX
    // index, so the anchors are ready by the time the page is drawn.
    void (async () => {
      const anchors: PdfAnchor[] = [];
      try {
        const reply = await requestFromHost(host, {
          type: "synctex:forwardBatch",
          resultType: "synctex:forwardBatchResult",
          payload: {
            path: mainFile,
            pdfPath,
            lines: anchored.map((proposal) => proposal.line),
            documentMainFile: mainFile,
            ...workspaceRequestFields(identity),
          },
          timeoutMs: 10_000,
        });
        if (cancelled) return;
        const results = reply.ok === true && Array.isArray(reply.results) ? reply.results : [];
        const byLine = new Map<number, { page: number; y: number }>();
        for (const entry of results) {
          if (!entry || typeof entry !== "object") continue;
          const hit = entry as { line?: unknown; found?: unknown; page?: unknown; y?: unknown };
          if (
            hit.found === true &&
            typeof hit.line === "number" &&
            typeof hit.page === "number" &&
            typeof hit.y === "number"
          ) {
            byLine.set(hit.line, { page: hit.page, y: hit.y });
          }
        }
        for (const proposal of anchored) {
          const hit = byLine.get(proposal.line as number);
          if (hit) anchors.push({ id: proposal.id, page: hit.page, y: hit.y, title: proposal.title });
        }
      } catch {
        // A step without a place on the page simply stays in the chat.
      }
      if (!cancelled) setPageAnchors({ pdfPath, key, anchors });
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, nativeWorkspace, nativeWorkspaceIdentity, workspacePdf.building, workspacePdf.native, workspacePdf.path]);

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
    // The desktop branch is backed by the Code workspace and local agent. Its
    // bundled Next server has no document database and must not probe the web
    // service routes during startup.
    if (getNativeHost()) {
      initialLoadRef.current = false;
      return;
    }
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
      const onFrame = (frame: TurnFrame) => {
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
      };

      const result = await sendMessage(
        document.id,
        targetNodeId ? { prompt, targetNodeId } : { prompt },
        onFrame,
        controller.signal,
      );

      turnAbortRef.current = null;
      setTurnDocumentId((current) =>
        current === document.id ? null : current,
      );
      setActivityTool(null);
      setStreamingText("");
      if (!result.ok) {
        setTurnError("送信できませんでした。もう一度お試しください。");
        clearQueuedPrompts();
        return;
      }
      // The stored thread now holds the assistant's reply; reloading also
      // picks up the new revision and its page.
      await refreshAfterTurn(document.id);
      if (revisionChanged) setCompileFailed(false);

      // A message typed while this turn was running goes next, in order.
      const queued = takeQueuedPrompt();
      if (queued) {
        const latest = latestDocumentsRef.current[document.id] ?? document;
        void runTurnRef.current?.(latest, queued.prompt);
      }
    },
    [
      clearQueuedPrompts,
      flushOutstandingSave,
      refreshAfterTurn,
      takeQueuedPrompt,
      updateStoredDocument,
    ],
  );

  useEffect(() => {
    runTurnRef.current = runTurn;
  }, [runTurn]);

  /** One desktop-agent turn scoped to Code's current workspace build root. */
  const runNativeDocTurnRef = useRef<
    | ((
        prompt: string,
        onStarted?: () => void,
        options?: NativeTurnOptions,
      ) => Promise<void>)
    | null
  >(null);
  const nativeDocument = nativeWorkspace.current;
  const nativeConversationId = useMemo(
    () =>
      nativeMainFile && nativeWorkspace.workspaceId
        ? conversationIdFor(nativeWorkspace.workspaceId, nativeMainFile)
        : null,
    [nativeMainFile, nativeWorkspace.workspaceId],
  );
  const nativeThreadSession = useMemo(
    () =>
      nativeThreadSessionKey(
        nativeWorkspace.workspaceId,
        nativeWorkspace.workspaceGeneration,
        nativeMainFile,
      ),
    [
      nativeMainFile,
      nativeWorkspace.workspaceGeneration,
      nativeWorkspace.workspaceId,
    ],
  );
  const nativeConversationIdRef = useRef<string | null>(nativeConversationId);
  const nativeThreadSessionRef = useRef<string | null>(nativeThreadSession);
  const activeNativeTurnRef = useRef<{
    sessionKey: string;
    conversationId: string;
    controller: AbortController;
  } | null>(null);
  const nativeTurnStoppingRef = useRef(false);
  const attachedNativeTurnRef = useRef<{
    sessionKey: string;
    conversationId: string;
  } | null>(null);
  const pendingNativeLookupRef = useRef<{
    sessionKey: string;
    conversationId: string;
  } | null>(null);
  const nativeInitialBuildSessionRef = useRef<string | null>(null);
  const cancelAttachedAbortFallbackRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelAttachedAbortFallbackRef.current?.();
    },
    [],
  );
  useEffect(() => {
    nativeConversationIdRef.current = nativeConversationId;
    nativeThreadSessionRef.current = nativeThreadSession;
  }, [nativeConversationId, nativeThreadSession]);
  const runNativeDocTurn = useCallback(
    async (prompt: string, onStarted?: () => void, options?: NativeTurnOptions) => {
      const document = nativeDocument;
      const conversationId = nativeConversationId;
      const sessionKey = nativeThreadSession;
      const workspaceRoot = nativeWorkspaceIdentity.workspaceRoot;
      if (
        !document ||
        !conversationId ||
        !sessionKey ||
        !workspaceRoot ||
        nativeHistoryLoading ||
        !nativePlatform.canRun
      ) {
        return;
      }
      // A queued caller removes its prompt only after these authoritative
      // runtime guards pass. If readiness changed since the effect rendered,
      // the prompt remains at the head of the queue for a later retry.
      onStarted?.();
      const controller = new AbortController();
      nativeTurnStoppingRef.current = false;
      setNativeTurnStopping(false);
      turnAbortRef.current = controller;
      activeNativeTurnRef.current = { sessionKey, conversationId, controller };
      setTurnDocumentId(conversationId);
      setStreamingText("");
      setActivityTool(null);
      setTurnError(null);
      setMobileView("conversation");
      const shownAt = new Date().toISOString();
      {
        setNativeMessages((current) => [
          ...current,
          {
            id: `local:${shownAt}`,
            role: "user",
            text: prompt,
            createdAt: shownAt,
            ...(options?.attachments && options.attachments.length > 0
              ? { attachments: options.attachments }
              : {}),
          },
        ]);
      }

      const onFrame = (frame: TurnFrame) => {
        switch (frame.type) {
          case "text":
            setStreamingText((current) => current + frame.delta);
            setActivityTool(null);
            break;
          case "tool":
            if (frame.state === "start") setActivityTool(frame.name);
            break;
          case "error":
            setTurnError(frame.message);
            break;
          default:
            break;
        }
      };

      const result = await runNativeTurn({
        prompt,
        onFrame,
        signal: controller.signal,
        conversationId,
        activeFilePath: document.mainFile,
        workspaceRoot,
        workspaceId: nativeWorkspaceIdentity.workspaceId,
        workspaceGeneration: nativeWorkspaceIdentity.workspaceGeneration,
        documentMainFile: document.mainFile,
        ...(options?.origin ? { origin: options.origin } : {}),
        ...(options?.stepKind ? { stepKind: options.stepKind } : {}),
        ...(options?.parts && options.parts.length > 0 ? { parts: options.parts } : {}),
      }).catch(() => null);

      const stillOwnsTurn = activeNativeTurnRef.current?.controller === controller;
      if (stillOwnsTurn) {
        if (turnAbortRef.current === controller) turnAbortRef.current = null;
        activeNativeTurnRef.current = null;
        nativeTurnStoppingRef.current = false;
        setNativeTurnStopping(false);
        setTurnDocumentId((current) =>
          current === conversationId ? null : current,
        );
        setActivityTool(null);
        setStreamingText("");
      }
      if (
        nativeConversationIdRef.current !== conversationId ||
        nativeThreadSessionRef.current !== sessionKey
      ) {
        return;
      }
      if (!result) {
        setTurnError("送信できませんでした。もう一度お試しください。");
        clearQueuedPrompts();
        return;
      }
      if (result.finalText.trim()) {
        const repliedAt = new Date().toISOString();
        setNativeMessages((current) => [
          ...current,
          {
            id: `local:${repliedAt}`,
            role: "assistant",
            text: result.finalText,
            createdAt: repliedAt,
            ...(result.proposals ? { proposals: result.proposals } : {}),
            ...(result.question ? { question: result.question } : {}),
          },
        ]);
      }
      getNativeHost()?.send("platform:usage:get", { source: "ai-mode-turn" });
      if (result.status !== "completed") {
        clearQueuedPrompts();
      }
    },
    [
      clearQueuedPrompts,
      nativeWorkspaceIdentity,
      nativeConversationId,
      nativeDocument,
      nativeHistoryLoading,
      nativePlatform.canRun,
      nativeThreadSession,
    ],
  );

  useEffect(() => {
    runNativeDocTurnRef.current = runNativeDocTurn;
  }, [runNativeDocTurn]);

  useEffect(() => {
    const runQueuedTurn = runNativeDocTurnRef.current;
    if (
      !workspacePdf.native ||
      queuedPrompts.length === 0 ||
      agentWorking ||
      nativeHistoryLoading ||
      nativeTurnStopping ||
      !nativePlatform.canRun ||
      !nativeDocument ||
      !nativeConversationId ||
      !nativeThreadSession ||
      !nativeWorkspaceIdentity.workspaceRoot ||
      !runQueuedTurn
    ) {
      return;
    }
    // Dequeue only after every execution precondition is satisfied. Readiness
    // can change between terminal delivery and the next React render, so a
    // direct handoff from the previous turn could otherwise lose this prompt.
    const queued = queuedPromptsRef.current[0] ?? null;
    if (!queued || queued.preparing) return;
    void runQueuedTurn(
      queued.prompt,
      () => {
        if (queuedPromptsRef.current[0]?.id === queued.id) takeQueuedPrompt();
      },
      {
        ...(queued.parts ? { parts: queued.parts } : {}),
        ...(queued.attachments ? { attachments: queued.attachments } : {}),
      },
    );
  }, [
    agentWorking,
    nativeConversationId,
    nativeDocument,
    nativeHistoryLoading,
    nativePlatform.canRun,
    nativeThreadSession,
    nativeTurnStopping,
    nativeWorkspaceIdentity.workspaceRoot,
    queuedPrompts,
    takeQueuedPrompt,
    workspacePdf.native,
  ]);

  // A desktop conversation is persisted by the app. A file-tree refresh may
  // replace the document object, but this effect is keyed only by the stable
  // workspace generation + main file. Only a real session boundary may stop
  // the old turn.
  useEffect(() => {
    const host = getNativeHost();
    const previousLookup = pendingNativeLookupRef.current;
    if (previousLookup && previousLookup.sessionKey !== nativeThreadSession) {
      host?.send("agent:abort", {
        conversationId: previousLookup.conversationId,
        reason: "native-state-lookup-session-changed",
      });
      pendingNativeLookupRef.current = null;
    }
    let activeTurn = activeNativeTurnRef.current;
    if (activeTurn && activeTurn.sessionKey !== nativeThreadSession) {
      activeTurn.controller.abort();
      if (turnAbortRef.current === activeTurn.controller) turnAbortRef.current = null;
      activeNativeTurnRef.current = null;
      nativeTurnStoppingRef.current = false;
      setNativeTurnStopping(false);
      activeTurn = null;
    }
    const activeTurnIsCurrent =
      Boolean(nativeThreadSession) &&
      activeTurn?.sessionKey === nativeThreadSession &&
      !activeTurn.controller.signal.aborted;
    const attachedTurn = attachedNativeTurnRef.current;
    if (attachedTurn && attachedTurn.sessionKey !== nativeThreadSession) {
      cancelAttachedAbortFallbackRef.current?.();
      cancelAttachedAbortFallbackRef.current = null;
      host?.send("agent:abort", {
        conversationId: attachedTurn.conversationId,
        reason: "native-thread-session-changed",
      });
      attachedNativeTurnRef.current = null;
      setTurnDocumentId((current) =>
        current === attachedTurn.conversationId ? null : current,
      );
      setActivityTool(null);
      setStreamingText("");
    }
    if (!activeTurnIsCurrent) {
      clearQueuedPrompts();
      setNativeMessages([]);
      setNativeUndoCount(0);
      setTurnError(null);
      setTurnDocumentId(null);
      setActivityTool(null);
      setStreamingText("");
    }
    if (!nativeConversationId || !nativeThreadSession) {
      setNativeHistoryLoading(false);
      return;
    }

    const lookupIdentity = {
      sessionKey: nativeThreadSession,
      conversationId: nativeConversationId,
    };
    pendingNativeLookupRef.current = lookupIdentity;

    let cancelled = false;
    let lookupRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let waitingForTerminal = false;
    let terminalObserved: "idle" | "error" | "resumable" | null = null;
    let attachedFailureMessage: string | null = null;

    const applyRestoredState = (
      state: Awaited<ReturnType<typeof loadNativeConversation>>,
    ) => {
      if (cancelled || nativeThreadSessionRef.current !== nativeThreadSession) return;
      setNativeMessages(state.messages);
      setNativeUndoCount(state.undoCount);
      if (state.undoUnavailableReason === "persistence_limit") {
        setTurnError(
          "前回の変更は、安全に戻すための保存上限を超えたため、再起動後はまとめて戻せません。",
        );
      }
    };

    const finishAttachedTurn = (terminalState: "idle" | "error" | "resumable") => {
      if (!waitingForTerminal || cancelled) return;
      waitingForTerminal = false;
      cancelAttachedAbortFallbackRef.current?.();
      cancelAttachedAbortFallbackRef.current = null;
      attachedNativeTurnRef.current = null;
      nativeTurnStoppingRef.current = false;
      setNativeTurnStopping(false);
      setActivityTool(null);
      setStreamingText("");
      setNativeHistoryLoading(true);
      const terminalFailed = nativeTerminalFailed(
        terminalState,
        Boolean(attachedFailureMessage),
      );
      if (terminalFailed) {
        clearQueuedPrompts();
        setTurnError(
          attachedFailureMessage ??
            "処理が最後まで進みませんでした。もう一度お試しください。",
        );
      }
      void loadNativeConversation(nativeConversationId)
        .then((state) => {
          applyRestoredState(state);
          if (cancelled || nativeThreadSessionRef.current !== nativeThreadSession) return;
          if (terminalFailed) {
            setTurnError(
              attachedFailureMessage ??
                "処理が最後まで進みませんでした。もう一度お試しください。",
            );
          }
        })
        .catch(() => {
          if (!cancelled && !terminalFailed) {
            setTurnError("会話履歴を読み込めませんでした。");
          }
        })
        .finally(() => {
          if (!cancelled && nativeThreadSessionRef.current === nativeThreadSession) {
            setTurnDocumentId((current) =>
              current === nativeConversationId ? null : current,
            );
            setNativeHistoryLoading(false);
          }
        });
    };

    if (!activeTurnIsCurrent) setNativeHistoryLoading(true);
    const unsubscribe = host?.onMessage((message: HostMessage) => {
      const body = hostMessageBody(message);
      if (
        message.type === "agent:status" &&
        body.conversationId === nativeConversationId &&
        body.state === "stopping"
      ) {
        nativeTurnStoppingRef.current = true;
        setNativeTurnStopping(true);
        clearQueuedPrompts();
        cancelAttachedAbortFallbackRef.current?.();
        cancelAttachedAbortFallbackRef.current = null;
        return;
      }
      if (
        message.type === "agent:error" &&
        body.conversationId === nativeConversationId
      ) {
        attachedFailureMessage =
          typeof body.message === "string" && body.message
            ? body.message
            : "処理が最後まで進みませんでした。もう一度お試しください。";
        if (waitingForTerminal) setTurnError(attachedFailureMessage);
        return;
      }
      if (
        message.type === "agent:status" &&
        body.conversationId === nativeConversationId &&
        (body.state === "idle" ||
          body.state === "error" ||
          body.state === "resumable")
      ) {
        terminalObserved = body.state;
        finishAttachedTurn(body.state);
        return;
      }
      if (
        waitingForTerminal &&
        message.type === "agent:messageDelta" &&
        body.conversationId === nativeConversationId &&
        typeof body.text === "string"
      ) {
        setStreamingText((current) => current + body.text);
        setActivityTool(null);
        return;
      }
      if (
        waitingForTerminal &&
        message.type === "agent:tool" &&
        body.conversationId === nativeConversationId &&
        typeof body.name === "string"
      ) {
        setActivityTool(
          body.summary === "running"
            ? typeof body.label === "string" && body.label
              ? body.label
              : body.name
            : null,
        );
        return;
      }
      if (message.type !== "agent:undoAvailability") return;
      if (body.conversationId !== nativeConversationId) return;
      if (typeof body.count === "number") {
        setNativeUndoCount(Math.max(0, Math.trunc(body.count)));
      }
    });
    const clearPendingLookup = () => {
      if (
        pendingNativeLookupRef.current?.sessionKey === lookupIdentity.sessionKey &&
        pendingNativeLookupRef.current?.conversationId === lookupIdentity.conversationId
      ) {
        pendingNativeLookupRef.current = null;
      }
    };
    const loadAuthoritativeState = () => {
      void loadNativeConversation(nativeConversationId)
        .then((state) => {
        if (cancelled || nativeThreadSessionRef.current !== nativeThreadSession) return;
        clearPendingLookup();
        if (state.stopping) {
          nativeTurnStoppingRef.current = true;
          setNativeTurnStopping(true);
          clearQueuedPrompts();
        } else {
          // A stopping/terminal event may arrive while this authoritative state
          // request is in flight. An idle reply is the final source of truth and
          // must release a stale stopping lock left by the earlier event.
          nativeTurnStoppingRef.current = false;
          setNativeTurnStopping(false);
        }
        const restoreMode = nativeConversationRestoreMode(
          state.running,
          nativeThreadSession,
          activeNativeTurnRef.current?.controller.signal.aborted
            ? null
            : activeNativeTurnRef.current?.sessionKey ?? null,
        );
        if (restoreMode === "active") {
          // A state reply captured just before this component started its turn
          // is stale. Never overwrite the optimistic user message or stop the
          // live controller it belongs to.
          setNativeHistoryLoading(false);
          return;
        }
        applyRestoredState(state);
        if (restoreMode === "reattach") {
          waitingForTerminal = true;
          attachedNativeTurnRef.current = {
            sessionKey: nativeThreadSession,
            conversationId: nativeConversationId,
          };
          setTurnDocumentId(nativeConversationId);
          setNativeHistoryLoading(false);
          if (terminalObserved) finishAttachedTurn(terminalObserved);
        } else if (terminalObserved) {
          // A terminal event can win the race with this lookup while its reply
          // still reports idle. Route that event through the same settlement
          // path so its error and any queued prompt are not stranded.
          waitingForTerminal = true;
          attachedNativeTurnRef.current = {
            sessionKey: nativeThreadSession,
            conversationId: nativeConversationId,
          };
          setTurnDocumentId(nativeConversationId);
          setNativeHistoryLoading(false);
          finishAttachedTurn(terminalObserved);
        } else if (
          nativeMainFile &&
          terminalObserved === null &&
          nativeInitialBuildSessionRef.current !== nativeThreadSession
        ) {
          // The host agent state is authoritative. Build an idle document on
          // initial open, but never race a reattached/stopping turn whose host
          // owns the definitive terminal compile. Key this by the stable
          // workspace generation + main file; a build refresh replaces the
          // document object and must not recursively request another build.
          nativeInitialBuildSessionRef.current = nativeThreadSession;
          requestWorkspaceBuild({ mainFile: nativeMainFile }, nativeWorkspaceIdentity);
        }
        })
        .catch(() => {
          if (cancelled || nativeThreadSessionRef.current !== nativeThreadSession) return;
          // A missing state reply is unknown, not idle. Keep the composer locked
          // and re-query instead of starting a second turn in the same host
          // conversation. An explicitly owned local turn remains usable.
          setTurnError("会話状態を確認しています。接続が戻るまでお待ちください。");
          if (activeTurnIsCurrent) setNativeHistoryLoading(false);
          lookupRetryTimer = setTimeout(loadAuthoritativeState, 1_000);
        })
        .finally(() => {
          if (
            !cancelled &&
            pendingNativeLookupRef.current !== lookupIdentity &&
            !waitingForTerminal
          ) {
            setNativeHistoryLoading(false);
          }
        });
    };
    loadAuthoritativeState();
    return () => {
      cancelled = true;
      if (lookupRetryTimer !== null) clearTimeout(lookupRetryTimer);
      unsubscribe?.();
    };
  }, [
    clearQueuedPrompts,
    nativeConversationId,
    nativeMainFile,
    nativeThreadSession,
    nativeWorkspaceIdentity,
  ]);

  const undoNativeChange = useCallback(async () => {
    if (
      !nativeConversationId ||
      !nativeDocument ||
      nativeHistoryLoading ||
      agentWorking
    ) {
      return;
    }
    const sessionKey = nativeThreadSession;
    if (!sessionKey) return;
    const controller = new AbortController();
    nativeTurnStoppingRef.current = false;
    setNativeTurnStopping(false);
    turnAbortRef.current = controller;
    activeNativeTurnRef.current = {
      sessionKey,
      conversationId: nativeConversationId,
      controller,
    };
    setActivityTool("undo_changes");
    setTurnDocumentId(nativeConversationId);
    setNativeHistoryLoading(true);
    setTurnError(null);
    try {
      const result = await undoNativeConversation(
        nativeConversationId,
        controller.signal,
      );
      if (nativeConversationIdRef.current !== nativeConversationId) return;
      if (!result.ok) {
        if (!result.aborted || result.error) {
          setTurnError(result.error ?? "変更を戻せませんでした。");
        }
        return;
      }
    } catch {
      if (nativeConversationIdRef.current === nativeConversationId) {
        setTurnError("変更を戻せませんでした。");
      }
    } finally {
      if (activeNativeTurnRef.current?.controller === controller) {
        activeNativeTurnRef.current = null;
      }
      if (turnAbortRef.current === controller) turnAbortRef.current = null;
      if (nativeConversationIdRef.current === nativeConversationId) {
        nativeTurnStoppingRef.current = false;
        setNativeTurnStopping(false);
        setTurnDocumentId((current) =>
          current === nativeConversationId ? null : current,
        );
        setActivityTool(null);
        setNativeHistoryLoading(false);
      }
    }
  }, [
    agentWorking,
    nativeConversationId,
    nativeDocument,
    nativeHistoryLoading,
    nativeThreadSession,
  ]);

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
    clearQueuedPrompts();
    nativeTurnStoppingRef.current = true;
    setNativeTurnStopping(true);
    stopWorkspaceTurn({
      activeNativeController: activeNativeTurnRef.current?.controller ?? null,
      attachedConversationId:
        attachedNativeTurnRef.current?.conversationId ?? null,
      // Hosted/web-service turns use the shared controller without a native
      // lifecycle record.
      fallbackController: turnAbortRef.current,
      abortAttached: (conversationId) => {
        getNativeHost()?.send("agent:abort", {
          conversationId,
          reason: "user-stop",
        });
        cancelAttachedAbortFallbackRef.current?.();
        cancelAttachedAbortFallbackRef.current = scheduleAttachedAbortFallback(
          conversationId,
          (expectedConversationId) =>
            attachedNativeTurnRef.current?.conversationId === expectedConversationId,
          () => {
            attachedNativeTurnRef.current = null;
            nativeTurnStoppingRef.current = false;
            setNativeTurnStopping(false);
            setTurnDocumentId((current) =>
              current === conversationId ? null : current,
            );
            setActivityTool(null);
            setStreamingText("");
            setNativeHistoryLoading(false);
            setTurnError(
              "処理の停止確認が届きませんでした。もう一度お試しください。",
            );
          },
        );
      },
    });
  }, [clearQueuedPrompts]);

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

  // Saves one attached file next to the document so the paper can include
  // it; the agent is told the path. Null when it could not be saved.
  const importAttachment = useCallback(
    async (attachment: PendingAttachment): Promise<string | null> => {
      const host = getNativeHost();
      const mainFile = nativeDocument?.mainFile;
      if (!host || !mainFile) return null;
      try {
        const data = await attachmentBase64(attachment.file);
        const reply = await requestFromHost(host, {
          type: "file:importAttachment",
          resultType: "file:importAttachmentResult",
          payload: {
            name: attachment.name,
            data,
            documentMainFile: mainFile,
            ...workspaceRequestFields(nativeWorkspaceIdentity),
          },
          timeoutMs: 60_000,
        });
        return reply.ok === true && typeof reply.path === "string" ? reply.path : null;
      } catch {
        return null;
      }
    },
    [nativeDocument, nativeWorkspaceIdentity],
  );

  // A message with files shows as waiting at once; the files are saved and
  // read meanwhile, and the turn starts as soon as they are ready.
  const submitWithAttachments = useCallback(
    (prompt: string, pending: PendingAttachment[]) => {
      const id = `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const text = prompt.trim() || "添付ファイルを確認してください。";
      enqueuePrompt({
        id,
        prompt: text,
        preparing: true,
        attachments: pending.map((attachment) => ({ name: attachment.name, kind: attachment.kind })),
      });
      void prepareAttachments(pending, importAttachment)
        .then((prepared) => {
          updateQueuedTurn(id, {
            preparing: false,
            parts: [{ text }, ...prepared.parts],
            attachments: prepared.attachments,
          });
        })
        .catch(() => {
          updateQueuedTurn(id, { preparing: false, parts: [{ text }] });
        })
        .finally(() => {
          pending.forEach(releasePendingAttachment);
        });
    },
    [enqueuePrompt, importAttachment, updateQueuedTurn],
  );

  const submitWritingRequest = useCallback(
    (prompt: string, attachments?: PendingAttachment[], options?: { origin?: "step"; stepKind?: "mechanical" | "writing" }) => {
      if (workspacePdf.native) {
        if (!nativeDocument || nativeHistoryLoading || !nativePlatform.canRun) return;
        if (attachments && attachments.length > 0) {
          submitWithAttachments(prompt, attachments);
          return;
        }
        // A message sent while the agent is working waits its turn instead of
        // being refused; the composer never locks.
        if (agentWorking && nativeThreadWorking) {
          enqueuePrompt({ id: `queued-${Date.now()}`, prompt });
          return;
        }
        if (agentWorking) return;
        void runNativeDocTurn(prompt, undefined, options?.origin === "step" ? { origin: "step", stepKind: options.stepKind } : undefined);
        return;
      }
      if (!activeDocument) return;
      if (agentWorking) {
        enqueuePrompt({ id: `queued-${Date.now()}`, prompt });
        return;
      }
      const targetNodeId = selectedElement?.id;
      setSelectedElementId(null);
      void runTurn(activeDocument, prompt, targetNodeId);
    },
    [
      activeDocument,
      agentWorking,
      enqueuePrompt,
      nativeDocument,
      nativeHistoryLoading,
      nativePlatform.canRun,
      nativeThreadWorking,
      runNativeDocTurn,
      runTurn,
      selectedElement,
      submitWithAttachments,
      workspacePdf.native,
    ],
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
          {workspacePdf.native ? (
            <div
              className="native-workspace-title"
              aria-label={`ワークスペース: ${nativeDocument?.name ?? "未選択"}`}
            >
              <span className="document-switcher-titles">
                <strong>{nativeDocument?.name ?? "ワークスペース未選択"}</strong>
                <small>ワークスペース</small>
              </span>
            </div>
          ) : (
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
                {documents.length ? (
                  <ChevronDown aria-hidden="true" size={14} />
                ) : null}
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
          )}
        </div>

        <div className="topbar-actions">
          {workspacePdf.native ? (
            <div className="native-command-bar">
              <NativePlatformControls platform={nativePlatform} />
              {nativeDocument && nativeUndoCount > 0 ? (
                <button
                  type="button"
                  className="topbar-icon-button"
                  aria-label="直前の変更を戻す"
                  title="直前の変更を戻す"
                  disabled={nativeHistoryLoading || agentWorking}
                  onClick={() => void undoNativeChange()}
                >
                  <Undo2 size={16} />
                </button>
              ) : null}
              <span className="native-command-divider" aria-hidden="true" />
              <button
                type="button"
                className="topbar-build-button"
                disabled={
                  !workspacePdf.hasWorkspace ||
                  !nativeDocument ||
                  workspacePdf.building
                }
                onClick={() =>
                  nativeDocument
                    ? requestWorkspaceBuild(
                        nativeDocument,
                        nativeWorkspaceIdentity,
                      )
                    : null
                }
              >
                <Play aria-hidden="true" size={15} fill="currentColor" />
                <span>{workspacePdf.building ? "ビルド中…" : "ビルド"}</span>
              </button>
            </div>
          ) : null}
          {!workspacePdf.native && activeDocument && activeDocument.versions.length > 0 ? (
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
          {!workspacePdf.native ? (
            <button
              type="button"
              className="topbar-new-button"
              aria-label="新規"
              onClick={() => void showNewDocument()}
            >
              <Plus aria-hidden="true" size={16} />
              <span>新規</span>
            </button>
          ) : null}
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
          {workspacePdf.native ? (
            !nativeWorkspace.hasWorkspace && !nativeWorkspace.loading ? (
              <NativeWorkspacePanel
                onOpen={nativeWorkspace.openWorkspace}
                onCreate={nativeWorkspace.createWorkspace}
              />
            ) : (
              <AgentPanel
                document={null}
                ready={
                  Boolean(nativeDocument) &&
                  !nativeHistoryLoading &&
                  (!agentWorking || nativeThreadWorking) &&
                  !nativeTurnStopping &&
                  nativePlatform.canRun
                }
                messages={messages}
                streamingText={streamingText}
                activityTool={activityTool}
                isWorking={agentWorking}
                queuedPrompts={queuedPrompts.map((turn) => turn.prompt)}
                error={
                  turnError ??
                  nativePlatform.blockedReason ??
                  (!nativeDocument && !nativeWorkspace.loading
                    ? "Codeでビルドするルート文書を設定してください。"
                    : null)
                }
                selectedElement={null}
                composerRef={composerRef}
                onSubmit={submitWritingRequest}
                onStop={stopTurn}
                onClearSelection={() => setSelectedElementId(null)}
                chosenProposal={chosenProposal}
                activeProposalId={activeProposalId}
                onActiveProposalChange={setActiveProposalId}
              />
            )
          ) : activeDocument ? (
            <AgentPanel
              document={activeDocument}
              messages={messages}
              streamingText={streamingText}
              activityTool={activityTool}
              isWorking={agentWorking}
              queuedPrompts={queuedPrompts.map((turn) => turn.prompt)}
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
          {documentLoading && !workspacePdf.native ? (
            <DocumentSkeleton />
          ) : workspacePdf.native || activeDocument ? (
            <section className="paper-surface" aria-label="紙面">
                <PdfPreview
                  pdfUrl={displayPdfUrl}
                  onExport={workspacePdf.native ? () => {
                    const host = getNativeHost();
                    if (!host || !workspacePdf.path) return;
                    void requestFromHost(host, { type: "file:exportPdf", resultType: "file:exportPdfResult", timeoutMs: null,
                      payload: { path: workspacePdf.path, documentMainFile: nativeMainFile, ...workspaceRequestFields(nativeWorkspaceIdentity) },
                    }).then((result) => { if (!result.ok && !result.cancelled) setTurnError(String(result.error || "PDFを保存できませんでした。")); });
                  } : undefined}
                  anchors={
                    workspacePdf.native &&
                    pageAnchors &&
                    pageAnchors.pdfPath === workspacePdf.path &&
                    pageAnchors.key === latestProposalKey
                      ? pageAnchors.anchors
                      : null
                  }
                  activeAnchorId={activeProposalId}
                  onAnchorHover={setActiveProposalId}
                  onAnchorSelect={(id) => {
                    const proposal = latestProposals.find((entry) => entry.id === id);
                    if (!proposal || agentWorking) return;
                    setMobileView("conversation");
                    if (proposal.asks) {
                      setChosenProposal((current) => ({ proposal, pick: (current?.pick ?? 0) + 1 }));
                    } else {
                      submitWritingRequest(proposal.request);
                    }
                  }}
                  regions={workspacePdf.native ? null : pdfRegions}
                  selectedId={selectedElementId}
                  refreshing={
                    compiling ||
                    previewStale ||
                    (agentWorking && displayPdfUrl !== null)
                  }
                  interactive
                  onSelect={(id) => setSelectedElementId(id)}
                  onPointSelect={
                    workspacePdf.native
                      ? (point) => {
                          // Closing retains a range-specific draft before selecting another spot.
                          paragraphEditor.close();
                          sourceLocator.locate({
                            ...point,
                            pdfPath: workspacePdf.path,
                          });
                        }
                      : undefined
                  }
                  pointSelectionActive={
                    workspacePdf.native
                      ? sourceLocator.locating ||
                        paragraphEditor.loading ||
                        paragraphEditor.paragraph !== null
                      : undefined
                  }
                  emptyHint={
                    workspacePdf.native
                      ? !workspacePdf.hasWorkspace
                        ? "プロジェクトを選んでください。"
                        : !nativeDocument && !nativeWorkspace.loading
                          ? "Codeでビルドするルート文書を設定してください。"
                          : workspacePdf.building
                            ? "紙面を組み立てています…"
                            : workspacePdf.failure
                              ? ""
                              : "紙面を組み立てています…"
                      : agentWorking
                        ? "紙面を準備しています…"
                        : documentHasContent
                          ? "紙面を組み立てています…"
                          : "まだ紙面がありません。左の欄から執筆を依頼してください。"
                  }
                  buildFailed={workspacePdf.native && Boolean(workspacePdf.failure)}
                  toolbarAction={
                    !workspacePdf.native && activeDocument ? (
                      <button
                        type="button"
                        className="paper-build-button"
                        disabled={compiling}
                        onClick={() =>
                          void runCompile(activeDocument.id, activeDocument.revision)
                        }
                      >
                        {compiling ? "組版中…" : "組版"}
                      </button>
                    ) : null
                  }
                  selectionCard={
                    workspacePdf.native ? (
                      paragraphEditor.paragraph ? (
                        <ParagraphEditCard
                          key={`${paragraphEditor.paragraph.path}:${paragraphEditor.paragraph.startLine}:${paragraphEditor.paragraph.endLine}`}
                          originalText={paragraphEditor.paragraph.originalText}
                          initialDraft={paragraphEditor.draftText}
                          kind={paragraphEditor.paragraph.kind}
                          currentText={paragraphEditor.currentText}
                          onAcceptCurrent={paragraphEditor.acceptCurrent}
                          onDraftChange={paragraphEditor.updateDraft}
                          onDiscard={() => { paragraphEditor.discard(); sourceLocator.clear(); }}
                          onReload={() => {
                            const target = paragraphEditor.paragraph;
                            if (target) paragraphEditor.open({ path: target.path, line: target.startLine });
                          }}
                          saving={paragraphEditor.saving}
                          error={paragraphEditor.error}
                          onCancel={() => {
                            paragraphEditor.close();
                            sourceLocator.clear();
                          }}
                          onSave={(replacementText) => {
                            return paragraphEditor
                              .save(replacementText)
                              .then((saved) => {
                                if (saved) sourceLocator.clear();
                              });
                          }}
                        />
                      ) : null
                    ) : selectedElement ? (
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
                {workspacePdf.native && !paragraphEditor.paragraph && (sourceLocator.error || paragraphEditor.error) ? <div className="compile-banner" role="alert">{sourceLocator.error || paragraphEditor.error}</div> : null}
                {workspacePdf.native &&
                workspacePdf.failure &&
                nativeDocument ? (
                  <div className="compile-banner" role="alert">
                    <span>{workspacePdf.failure}</span>
                    {workspacePdf.issue ? <button onClick={() => getNativeHost()?.send("source:reveal", { requestId: `ai-source-${Date.now()}`, ...workspaceRequestFields(nativeWorkspaceIdentity), documentMainFile: nativeMainFile, path: workspacePdf.issue!.file || nativeMainFile, line: workspacePdf.issue!.line || 1 })}>{workspacePdf.issue.line ? "原因の箇所を開く" : "ソースを開く"}</button> : null}
                    <button disabled={workspacePdf.building} onClick={() => { if (nativeMainFile) requestWorkspaceBuild({ mainFile: nativeMainFile }, nativeWorkspaceIdentity); }}>再ビルド</button>
                  </div>
                ) : compileFailed && activeDocument ? (
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
