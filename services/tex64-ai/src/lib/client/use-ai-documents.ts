"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { getNativeHost, hostMessageBody, requestFromHost, type HostMessage } from "./native-host";

/**
 * One document of the AI mode: a folder in the workspace with its main.tex.
 * The reader sees only the name; the files stay out of sight.
 */
export type AiDocument = {
  name: string;
  /** Workspace-relative folder; "" is the workspace root itself. */
  folder: string;
  /** Workspace-relative path of the document's main.tex. */
  mainFile: string;
};

export type AiDocuments = {
  documents: AiDocument[];
  current: AiDocument | null;
  /** True once the desktop app has a project open. */
  hasWorkspace: boolean;
  /** True while 新規 is creating the folder. */
  creating: boolean;
  /** True until the first list has arrived (nothing to show yet). */
  loading: boolean;
  error: string | null;
  select: (document: AiDocument) => void;
  create: (title: string) => Promise<AiDocument | null>;
};

const CURRENT_DOC_KEY = "tex64.ai.currentDocumentFolder";

const subscribeToNothing = () => () => {};

/** Asks the host to typeset one document, without opening any viewer. */
function requestDocumentBuild(document: AiDocument): void {
  getNativeHost()?.send("build", {
    targetFile: document.mainFile,
    pdfViewerMode: "none",
  });
}

function parseDocuments(value: unknown): AiDocument[] {
  if (!Array.isArray(value)) return [];
  const documents: AiDocument[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.mainFile !== "string") continue;
    if (typeof item.folder !== "string") continue;
    documents.push({ name: item.name, folder: item.folder, mainFile: item.mainFile });
  }
  return documents;
}

/**
 * The AI mode's documents: list them, move between them, make new ones.
 *
 * 新規 creates a folder named after the title (the host sanitizes and
 * deduplicates it) with a minimal main.tex inside, then typesets it so the
 * first page appears on its own. Selection persists across reopens.
 */
export function useAiDocuments(): AiDocuments {
  const native = useSyncExternalStore(
    subscribeToNothing,
    () => getNativeHost() !== null,
    () => false,
  );
  const [documents, setDocuments] = useState<AiDocument[]>([]);
  const [current, setCurrent] = useState<AiDocument | null>(null);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [creating, setCreating] = useState(false);
  const [listArrived, setListArrived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!native) return;
    const host = getNativeHost();
    if (!host) return;
    let disposed = false;

    const restore = async () => {
      try {
        const answer = await requestFromHost(host, {
          type: "document:list",
          resultType: "document:listResult",
          timeoutMs: 8_000,
        });
        if (disposed) return;
        const list = answer.ok === true ? parseDocuments(answer.documents) : [];
        setDocuments(list);
        const rememberedFolder = window.localStorage.getItem(CURRENT_DOC_KEY);
        const restored =
          list.find((document) => document.folder === rememberedFolder) ??
          list[0] ??
          null;
        setCurrent(restored);
        // The page follows the restored document; latexmk skips the work
        // when nothing changed, so asking is cheap and keeps it honest.
        if (restored) requestDocumentBuild(restored);
      } catch {
        // A host that does not know document:list is an app that has not
        // been restarted onto this code. Say so instead of crashing the page.
        if (!disposed) {
          setError(
            "文書の一覧を取得できませんでした。デスクトップアプリを再起動して、もう一度開いてください。",
          );
        }
      } finally {
        if (!disposed) setListArrived(true);
      }
    };

    // The workspace may already be open (announced before this hook ran) or
    // open later; both paths land here exactly once.
    let started = false;
    const begin = () => {
      if (started || disposed) return;
      started = true;
      setHasWorkspace(true);
      void restore();
    };
    const unsubscribe = host.onMessage((message: HostMessage) => {
      if (message.type !== "updateWorkspace") return;
      const body = hostMessageBody(message);
      if (typeof body.rootPath === "string" && body.rootPath) begin();
    });
    host.send("workspace:state:get", {});

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [native]);

  const select = useCallback((document: AiDocument) => {
    window.localStorage.setItem(CURRENT_DOC_KEY, document.folder);
    setCurrent(document);
    requestDocumentBuild(document);
  }, []);

  const create = useCallback(async (title: string): Promise<AiDocument | null> => {
    const host = getNativeHost();
    if (!host) return null;
    setCreating(true);
    setError(null);
    try {
      const answer = await requestFromHost(host, {
        type: "document:create",
        resultType: "document:createResult",
        payload: { title },
        timeoutMs: 8_000,
      });
      if (
        answer.ok !== true ||
        typeof answer.name !== "string" ||
        typeof answer.folder !== "string" ||
        typeof answer.mainFile !== "string"
      ) {
        setError(
          typeof answer.error === "string"
            ? answer.error
            : "文書を作れませんでした。",
        );
        return null;
      }
      const created: AiDocument = {
        name: answer.name,
        folder: answer.folder,
        mainFile: answer.mainFile,
      };
      setDocuments((current) => [created, ...current]);
      window.localStorage.setItem(CURRENT_DOC_KEY, created.folder);
      setCurrent(created);
      requestDocumentBuild(created);
      return created;
    } catch {
      setError("文書を作れませんでした。");
      return null;
    } finally {
      setCreating(false);
    }
  }, []);

  return {
    documents,
    current,
    hasWorkspace,
    creating,
    // Until the first list answer, nothing is known — the UI holds back the
    // "make a new document" panel rather than flashing it at every launch.
    loading: native && !listArrived,
    error,
    select,
    create,
  };
}
