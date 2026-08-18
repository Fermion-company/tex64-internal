"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  fetchWorkspaceFileUrl,
  getNativeHost,
  type HostMessage,
} from "./native-host";

/** Remembers the last built page so a reopened AI mode is not blank. */
const LAST_PDF_KEY = "tex64.ai.lastBuiltPdf";

export type WorkspacePdf = {
  /** Object URL of the page the workspace build produced. */
  url: string | null;
  /** A build is running; the page below stays readable meanwhile. */
  building: boolean;
  /** True when the AI mode is running inside the desktop app. */
  native: boolean;
  /** Set when the workspace could not be typeset. */
  failure: string | null;
};

/**
 * The page the workspace itself produced. In the desktop app the AI mode shows
 * what Code mode just built, rather than a document of its own.
 */
/** The host is injected before the page runs and never appears later. */
const subscribeToNothing = () => () => {};

export function useWorkspacePdf(): WorkspacePdf {
  const [url, setUrl] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const native = useSyncExternalStore(
    subscribeToNothing,
    () => getNativeHost() !== null,
    () => false,
  );

  useEffect(() => {
    const host = getNativeHost();
    if (!host) return;

    let disposed = false;
    let currentUrl: string | null = null;

    const show = async (relativePath: string) => {
      try {
        const next = await fetchWorkspaceFileUrl(host, relativePath, "application/pdf");
        if (disposed) {
          URL.revokeObjectURL(next);
          return;
        }
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = next;
        setUrl(next);
        window.localStorage.setItem(LAST_PDF_KEY, relativePath);
      } catch {
        // A page that cannot be read leaves the previous one on screen.
      }
    };

    const unsubscribe = host.onMessage((message: HostMessage) => {
      if (message.type !== "setBuildState") return;
      const state = message.state;
      const running = state === "running" || state === "building";
      setBuilding(running);
      if (running) setFailure(null);
      if (state === "success" && typeof message.pdfPath === "string") {
        setFailure(null);
        void show(message.pdfPath);
      }
      if (state === "failed") {
        setFailure(
          typeof message.message === "string" && message.message
            ? message.message
            : "紙面を組み立てられませんでした。",
        );
      }
    });

    const remembered = window.localStorage.getItem(LAST_PDF_KEY);
    if (remembered) {
      void show(remembered);
    } else {
      // Nothing to show yet. Typesetting the workspace is this mode's whole
      // job, so it does it rather than telling the reader to go elsewhere.
      // The running state arrives with the build's own first report.
      host.send("build", {});
    }

    return () => {
      disposed = true;
      unsubscribe();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, []);

  return { url, building, native, failure };
}
