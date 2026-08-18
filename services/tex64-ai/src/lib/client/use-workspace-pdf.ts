"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getNativeHost, hostMessageBody, type HostMessage } from "./native-host";

/** Remembers the last built page so a reopened AI mode is not blank. */
const LAST_PDF_KEY = "tex64.ai.lastBuiltPdf";

export type WorkspacePdf = {
  /** Object URL of the page the workspace build produced. */
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

/**
 * The page the workspace itself produced. In the desktop app the AI mode shows
 * what Code mode just built, rather than a document of its own.
 */
/** The host is injected before the page runs and never appears later. */
const subscribeToNothing = () => () => {};

export function useWorkspacePdf(): WorkspacePdf {
  const [url, setUrl] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  /** Absolute workspace root, as the desktop app reports it. */
  const rootRef = useRef<string | null>(null);
  const native = useSyncExternalStore(
    subscribeToNothing,
    () => getNativeHost() !== null,
    () => false,
  );

  useEffect(() => {
    const host = getNativeHost();
    if (!host) return;

    let disposed = false;

    // The page is read over HTTP from this service, which runs on the same
    // machine. A message channel is the wrong transport for megabytes.
    const show = (relativePath: string) => {
      const root = rootRef.current;
      if (!root || disposed) return;
      setUrl(
        `/api/workspace/file?root=${encodeURIComponent(root)}` +
          `&path=${encodeURIComponent(relativePath)}&t=${Date.now()}`,
      );
      setPath(relativePath);
      window.localStorage.setItem(LAST_PDF_KEY, relativePath);
    };

    let started = false;
    const begin = () => {
      if (started || disposed) return;
      started = true;
      const remembered = window.localStorage.getItem(LAST_PDF_KEY);
      if (remembered) {
        show(remembered);
        return;
      }
      // Nothing to show yet. Typesetting the workspace is this mode's whole
      // job, so it does it rather than telling the reader to go elsewhere.
      // The running state arrives with the build's own first report.
      host.send("build", {});
    };

    const unsubscribe = host.onMessage((message: HostMessage) => {
      const body = hostMessageBody(message);
      if (message.type === "updateWorkspace") {
        // Nothing can be read or built until the app has a project open.
        if (typeof body.rootPath === "string" && body.rootPath) {
          rootRef.current = body.rootPath;
          setHasWorkspace(true);
          begin();
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
        show(body.pdfPath);
      }
      if (state === "failed") {
        setFailure(
          typeof body.message === "string" && body.message
            ? body.message
            : "紙面を組み立てられませんでした。",
        );
      }
    });

    const remembered = window.localStorage.getItem(LAST_PDF_KEY);    if (remembered) {
      show(remembered);
    } else {
      // Nothing to show yet. Typesetting the workspace is this mode's whole
      // job, so it does it rather than telling the reader to go elsewhere.
      // The running state arrives with the build's own first report.
      host.send("build", {});
    }

    // Ask what is open. This mode is created long after the project was
    // opened, so the announcement has already been and gone.
    host.send("workspace:state:get", {});

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return { url, path, building, native, failure, hasWorkspace };
}
