"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { getNativeHost, hostMessageBody, type HostMessage } from "./native-host";

/** Remembers each document's last built page so reopening is not blank. */
const LAST_PDF_KEY_PREFIX = "tex64.ai.lastBuiltPdf";

export type WorkspacePdf = {
  /** URL of the page the workspace build produced. */
  url: string | null;
  /** Workspace-relative path of that page, for SyncTeX. */
  path: string | null;
  /** A build is running; the page below stays readable meanwhile. */
  building: boolean;
  /** True when the AI mode is running inside the desktop app. */
  native: boolean;
  /** Set when the workspace could not be typeset. */
  failure: string | null;
  /** False until the desktop app has a project open. */
  hasWorkspace: boolean;
};

/** The host is injected before the page runs and never appears later. */
const subscribeToNothing = () => () => {};

const rememberKeyFor = (folder: string) => `${LAST_PDF_KEY_PREFIX}:${folder}`;

/** The folder a built page belongs to: "" for the workspace root. */
const folderOf = (relativePath: string) =>
  relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";

type BuiltPage = { path: string; stamp: number };

/**
 * The page of the AI mode's current document, as the workspace build makes it.
 *
 * Builds land as events and are kept per folder; what is *shown* is derived
 * from the current document — builds of other documents (Code mode's, another
 * folder's) pass by without touching the view. When to start a build is the
 * documents hook's decision, not this one's. The page itself is read over
 * HTTP from this service: a message channel is the wrong transport for
 * megabytes.
 */
export function useWorkspacePdf(
  currentDocument: { folder: string } | null = null,
): WorkspacePdf {
  const [root, setRoot] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Latest built page per folder, from this session's build events. */
  const [builtPages, setBuiltPages] = useState<Record<string, BuiltPage>>({});
  /** Latest build overall, for callers with no document scoping. */
  const [lastBuilt, setLastBuilt] = useState<BuiltPage | null>(null);
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
        // Nothing can be read or built until the app has a project open.
        if (typeof body.rootPath === "string" && body.rootPath) {
          setRoot(body.rootPath);
        }
        return;
      }
      if (message.type !== "setBuildState") return;
      const state = body.state;
      const running = state === "running" || state === "building";
      setBuilding(running);
      if (running) setFailure(null);
      if (state === "success" && typeof body.pdfPath === "string") {
        setFailure(null);
        const entry: BuiltPage = { path: body.pdfPath, stamp: Date.now() };
        setLastBuilt(entry);
        setBuiltPages((current) => ({ ...current, [folderOf(entry.path)]: entry }));
        window.localStorage.setItem(rememberKeyFor(folderOf(entry.path)), entry.path);
      }
      if (state === "failed") {
        setFailure(
          typeof body.message === "string" && body.message
            ? body.message
            : "紙面を組み立てられませんでした。",
        );
      }
    });

    // Ask what is open. This mode is created long after the project was
    // opened, so the announcement has already been and gone.
    host.send("workspace:state:get", {});

    return () => {
      unsubscribe();
    };
  }, []);

  const currentFolder = currentDocument ? currentDocument.folder : null;
  const shown = useMemo<BuiltPage | null>(() => {
    if (currentFolder === null) return lastBuilt;
    const built = builtPages[currentFolder];
    if (built) return built;
    if (typeof window === "undefined") return null;
    // Nothing built this session: the document's remembered page bridges the
    // seconds until the build that the selection already requested lands.
    const remembered = window.localStorage.getItem(rememberKeyFor(currentFolder));
    if (remembered && folderOf(remembered) === currentFolder) {
      return { path: remembered, stamp: 0 };
    }
    return null;
  }, [currentFolder, builtPages, lastBuilt]);

  const url =
    root && shown
      ? `/api/workspace/file?root=${encodeURIComponent(root)}` +
        `&path=${encodeURIComponent(shown.path)}&t=${shown.stamp}`
      : null;

  return {
    url,
    path: shown?.path ?? null,
    building,
    native,
    failure,
    hasWorkspace: root !== null,
  };
}
