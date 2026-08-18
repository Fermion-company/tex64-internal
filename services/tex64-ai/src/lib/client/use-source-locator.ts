"use client";

import { useCallback, useState } from "react";

import { getNativeHost, requestFromHost, type HostMessage } from "./native-host";

export type SourceLocation = {
  /** Workspace-relative path of the file the click landed in. */
  path: string;
  /** 1-based line. */
  line: number;
  /** False when SyncTeX had to guess between candidates. */
  confident: boolean;
  /** The line's own text, for showing what was picked. */
  text: string;
};

export type SourceLocator = {
  location: SourceLocation | null;
  error: string | null;
  locating: boolean;
  locate: (point: { page: number; x: number; y: number; pdfPath: string | null }) => void;
  clear: () => void;
};

/**
 * Turns a click on the page into a place in the source.
 *
 * SyncTeX answers with a file and a line; the line's own text comes back with
 * it so the reader can be shown what was picked rather than a line number.
 */
export function useSourceLocator(): SourceLocator {
  const [location, setLocation] = useState<SourceLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const locate = useCallback((point: {
    page: number;
    x: number;
    y: number;
    pdfPath: string | null;
  }) => {
    const host = getNativeHost();    if (!host) return;
    setLocating(true);
    setError(null);
    void (async () => {
      try {
        const found = await requestFromHost<
          HostMessage & {
            ok?: boolean;
            path?: string;
            line?: number;
            confidence?: boolean;
            error?: string;
          }
        >(host, {
          type: "synctex:reverse",
          resultType: "synctex:reverseResult",
          payload: {
            page: point.page,
            x: point.x,
            y: point.y,
            // Without this, the host can only answer for a build that ran in
            // its own lifetime.
            ...(point.pdfPath ? { pdfPath: point.pdfPath } : {}),
          },
        });
        if (!found.ok || typeof found.path !== "string" || typeof found.line !== "number") {
          setError(found.error ?? "この場所は本文と結び付けられませんでした。");
          setLocation(null);
          return;
        }
        const excerpt = await requestFromHost<
          HostMessage & { ok?: boolean; lines?: unknown; startLine?: number }
        >(host, {
          type: "file:excerpt",
          resultType: "file:excerptResult",
          payload: { path: found.path, line: found.line, radius: 0, maxLines: 1 },
        });
        const text =
          excerpt.ok && Array.isArray(excerpt.lines)
            ? String(excerpt.lines[0] ?? "")
            : "";
        setLocation({
          path: found.path,
          line: found.line,
          confident: found.confidence === true,
          text,
        });
      } catch {
        setError("本文の場所を確かめられませんでした。");
        setLocation(null);
      } finally {
        setLocating(false);
      }
    })();
  }, []);

  const clear = useCallback(() => {
    setLocation(null);
    setError(null);
  }, []);

  return { location, error, locating, locate, clear };
}
