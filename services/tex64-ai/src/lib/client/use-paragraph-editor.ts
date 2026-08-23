"use client";

import { useCallback, useState } from "react";

import {
  findParagraphRange,
  segmentParagraph,
  type ParagraphSegment,
} from "@/domain/source/paragraph-editing";
import { getNativeHost, requestFromHost } from "./native-host";

export type EditableParagraph = {
  /** Workspace-relative path the paragraph lives in. */
  path: string;
  startLine: number;
  endLine: number;
  /** The paragraph exactly as read — the write-back guard compares against this. */
  originalText: string;
  segments: ParagraphSegment[];
};

export type ParagraphEditor = {
  paragraph: EditableParagraph | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Reads the paragraph around a located line and opens it for editing. */
  open: (location: { path: string; line: number }) => void;
  /** Writes the edited paragraph back, then asks the host to typeset. */
  save: (replacementText: string) => Promise<boolean>;
  close: () => void;
};

/**
 * Direct editing of one paragraph: prose is editable, commands are chips.
 *
 * The paragraph is read once, split by segmentParagraph, and written back with
 * a compare-and-swap on the exact lines read — if the file moved underneath
 * (an agent turn, an edit in Code mode), the save is refused rather than
 * clobbering it.
 */
export function useParagraphEditor(): ParagraphEditor {
  const [paragraph, setParagraph] = useState<EditableParagraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((location: { path: string; line: number }) => {
    const host = getNativeHost();
    if (!host) return;
    setLoading(true);
    setError(null);
    setParagraph(null);
    void (async () => {
      try {
        const excerpt = await requestFromHost(host, {
          type: "file:excerpt",
          resultType: "file:excerptResult",
          // Wide enough for any real paragraph; the handler caps the payload.
          payload: { path: location.path, line: location.line, radius: 60, maxLines: 121 },
          timeoutMs: 8_000,
        });
        if (
          excerpt.ok !== true ||
          !Array.isArray(excerpt.lines) ||
          typeof excerpt.startLine !== "number"
        ) {
          setError(
            typeof excerpt.error === "string"
              ? excerpt.error
              : "本文を読み出せませんでした。",
          );
          return;
        }
        const range = findParagraphRange(
          excerpt.lines.map((line) => String(line)),
          excerpt.startLine,
          location.line,
        );
        if (!range) {
          setError("ここは文章の段落ではないため、この場では直せません。");
          return;
        }
        setParagraph({
          path: location.path,
          startLine: range.startLine,
          endLine: range.endLine,
          originalText: range.text,
          segments: segmentParagraph(range.text),
        });
      } catch {
        setError("本文を読み出せませんでした。");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = useCallback(
    async (replacementText: string): Promise<boolean> => {
      const host = getNativeHost();
      if (!host || !paragraph) return false;
      setSaving(true);
      setError(null);
      try {
        const result = await requestFromHost(host, {
          type: "file:replaceLines",
          resultType: "file:replaceLinesResult",
          payload: {
            path: paragraph.path,
            startLine: paragraph.startLine,
            endLine: paragraph.endLine,
            expectedText: paragraph.originalText,
            replacementText,
          },
          timeoutMs: 8_000,
        });
        if (result.ok !== true) {
          setError(
            result.stale === true
              ? "本文が先に変わっていたため、上書きを避けました。もう一度選び直してください。"
              : typeof result.error === "string"
                ? result.error
                : "書き戻せませんでした。",
          );
          return false;
        }
        // The host rebuilds the page itself right after a successful write —
        // a second "build" message from here proved losable in practice.
        setParagraph(null);
        return true;
      } catch {
        setError("書き戻せませんでした。");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [paragraph],
  );

  const close = useCallback(() => {
    setParagraph(null);
    setError(null);
    setLoading(false);
  }, []);

  return { paragraph, loading, saving, error, open, save, close };
}
