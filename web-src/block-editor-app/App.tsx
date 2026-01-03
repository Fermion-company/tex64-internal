import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import { MathFieldProvider } from "@/lib/math/MathFieldContext";
import type { Document } from "@/lib/document/types";
import { DocumentEditor } from "@/components/editor/document/DocumentEditor";
import { Tex180MathKeyboard } from "@/components/Tex180MathKeyboard";
import { parseContentToDocument, type BlockEntry, type BlockAnchor } from "@/adapter/blockParser";
import { buildPatchOperations, type PatchOperation } from "@/adapter/patcher";
import { buildDiffPreview } from "@/adapter/diff";
import { DiffViewer } from "@/components/diff/DiffViewer";

type BridgeMessage = {
  type?: string;
  payload?: unknown;
};

type BridgeWindow = Window & {
  tex180Bridge?: {
    postMessage: (payload: { type: string; [key: string]: unknown }) => void;
    onMessage?: (handler: (message: BridgeMessage) => void) => void;
  };
  webkit?: { messageHandlers?: { tex180?: { postMessage: (payload: unknown) => void } } };
};

type SyncResponse = { requestId: string; path: string; content?: string; error?: string };

type PatchResponse = { requestId: string; ok: boolean; error?: string; content?: string };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ApplyPatch = {
  start: number;
  end: number;
  snippet: string;
  replacement: string;
  anchor?: BlockAnchor;
};

const applyPatchesToString = (content: string, patches: ApplyPatch[]) => {
  const sorted = [...patches].sort((a, b) => b.start - a.start);
  let next = content;
  sorted.forEach((patch) => {
    next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  });
  return next;
};

const buildRequestId = () => `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const isEscaped = (text: string, index: number) => {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

const isInLineComment = (text: string, index: number) => {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  for (let i = lineStart; i < index; i += 1) {
    if (text[i] === "%" && !isEscaped(text, i)) {
      return true;
    }
  }
  return false;
};

const findClosing = (text: string, start: number, openChar: string, closeChar: string) => {
  if (text[start] !== openChar) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === openChar && !isEscaped(text, i)) {
      depth += 1;
    } else if (ch === closeChar && !isEscaped(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
};

const findCommandRange = (text: string, command: string) => {
  const needle = `\\${command}`;
  let index = text.indexOf(needle);
  while (index !== -1) {
    if (!isInLineComment(text, index)) {
      let cursor = index + needle.length;
      while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor += 1;
      }
      if (text[cursor] === "[") {
        const optEnd = findClosing(text, cursor, "[", "]");
        if (optEnd !== null) {
          cursor = optEnd + 1;
          while (cursor < text.length && /\s/.test(text[cursor])) {
            cursor += 1;
          }
        }
      }
      if (text[cursor] === "{") {
        const closeIndex = findClosing(text, cursor, "{", "}");
        if (closeIndex !== null) {
          return {
            start: index,
            end: closeIndex + 1,
            prefix: text.slice(index, cursor + 1),
          };
        }
      }
    }
    index = text.indexOf(needle, index + needle.length);
  }
  return null;
};

const buildMetadataPatches = (content: string, source: Document, draft: Document): ApplyPatch[] => {
  const beginDocMatch = content.match(/\\begin\{document\}/);
  if (!beginDocMatch || beginDocMatch.index === undefined) {
    return [];
  }

  const beginSnippet = beginDocMatch[0];
  const beginIndex = beginDocMatch.index;

  const patches: ApplyPatch[] = [];
  const inserts: string[] = [];

  const fields = [
    { key: "title", command: "title" },
    { key: "author", command: "author" },
    { key: "date", command: "date" },
  ] as const;

  fields.forEach(({ key, command }) => {
    const oldValue = (source.metadata[key] ?? "").trim();
    const newValue = (draft.metadata[key] ?? "").trim();
    if (oldValue === newValue) return;

    const match = findCommandRange(content, command);
    if (match) {
      patches.push({
        start: match.start,
        end: match.end,
        snippet: content.slice(match.start, match.end),
        replacement: newValue ? `${match.prefix}${newValue}}` : "",
      });
      return;
    }

    if (newValue) {
      inserts.push(`\\\\${command}{${newValue}}`);
    }
  });

  if (inserts.length > 0) {
    patches.push({
      start: beginIndex,
      end: beginIndex + beginSnippet.length,
      snippet: beginSnippet,
      replacement: `${inserts.join("\n")}\n${beginSnippet}`,
    });
  }

  return patches;
};

export function BlockEditorApp() {
  const bridgeWindow = window as BridgeWindow;
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());

  const [filePath, setFilePath] = useState("");
  const [sourceContent, setSourceContent] = useState("");
  const [sourceEntries, setSourceEntries] = useState<BlockEntry[]>([]);
  const [sourceDocument, setSourceDocument] = useState<Document>(() => {
    const parsed = parseContentToDocument("");
    return parsed.document;
  });
  const [draftDocument, setDraftDocument] = useState<Document>(sourceDocument);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const [paneSplit, setPaneSplit] = useState(30);
  const paneSplitRef = useRef(paneSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const syncFromContent = useCallback((content: string, path?: string) => {
    const { entries, document } = parseContentToDocument(content);
    setSourceContent(content);
    setSourceEntries(entries);
    setSourceDocument(document);
    setDraftDocument(document);
    setStatus("");
    if (typeof path === "string") {
      setFilePath(path);
    }
  }, []);

  const postToNative = useCallback(
    (payload: { type: string; [key: string]: unknown }) => {
      const handler = bridgeWindow.tex180Bridge ?? bridgeWindow.webkit?.messageHandlers?.tex180;
      if (!handler || typeof handler.postMessage !== "function") {
        setStatus("ネイティブ連携が利用できません。");
        return false;
      }
      handler.postMessage(payload);
      return true;
    },
    [bridgeWindow],
  );

  const sendRequest = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      const requestId = buildRequestId();
      return new Promise((resolve, reject) => {
        pendingRequestsRef.current.set(requestId, { resolve, reject });
        const ok = postToNative({ type, requestId, ...payload });
        if (!ok) {
          pendingRequestsRef.current.delete(requestId);
          reject(new Error("ネイティブ連携に失敗しました。"));
        }
      });
    },
    [postToNative],
  );

  const handleSync = useCallback(async () => {
    if (!filePath) {
      setStatus("ファイルが選択されていません。");
      return;
    }
    setStatus("同期中...");
    try {
      const result = (await sendRequest("blockEditorRequestSync", { path: filePath })) as SyncResponse;
      if (result.error) {
        setStatus(result.error);
        return;
      }
      syncFromContent(result.content ?? "", result.path);
      setStatus("同期しました。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "同期に失敗しました。");
    }
  }, [filePath, sendRequest, syncFromContent]);

  const blockPatches = useMemo(() => {
    if (!sourceEntries.length) {
      return [] as PatchOperation[];
    }
    return buildPatchOperations(sourceEntries, sourceDocument, draftDocument);
  }, [sourceEntries, sourceDocument, draftDocument]);

  const metadataPatches = useMemo(
    () => buildMetadataPatches(sourceContent, sourceDocument, draftDocument),
    [sourceContent, sourceDocument, draftDocument],
  );

  const patches = useMemo<ApplyPatch[]>(() => {
    const converted = blockPatches.map((patch) => ({
      start: patch.entry.start,
      end: patch.entry.end,
      snippet: patch.entry.snippet,
      replacement: patch.replacement,
      anchor: patch.entry.anchor,
    }));
    return [...metadataPatches, ...converted];
  }, [blockPatches, metadataPatches]);

  const isDirty = patches.length > 0;

  const modifiedContent = useMemo(() => {
    if (!patches.length) return sourceContent;
    return applyPatchesToString(sourceContent, patches);
  }, [sourceContent, patches]);

  const diffText = useMemo(() => {
    if (!showDiff) return "";
    if (!patches.length) return "変更なし";
    return buildDiffPreview(sourceContent, modifiedContent);
  }, [showDiff, sourceContent, modifiedContent, patches.length]);

  const applyChanges = useCallback(async () => {
    if (!filePath) {
      setStatus("ファイルが選択されていません。");
      return;
    }
    if (!patches.length) {
      setStatus("変更はありません。");
      return;
    }

    setPending(true);
    setStatus("適用中...");

    let latestContent = sourceContent;

    try {
      const result = (await sendRequest("blockEditorApplyPatch", {
        path: filePath,
        target: {
          start: 0,
          end: sourceContent.length,
          snippet: sourceContent,
        },
        replacement: modifiedContent,
      })) as PatchResponse;

      if (!result.ok) {
        throw new Error(result.error || "適用に失敗しました。");
      }
      if (typeof result.content === "string") {
        latestContent = result.content;
      } else {
        latestContent = modifiedContent;
      }

      syncFromContent(latestContent, filePath);
      setStatus("適用しました。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "適用に失敗しました。");
    } finally {
      setPending(false);
    }
  }, [filePath, patches, sendRequest, sourceContent, syncFromContent, modifiedContent]);

  useEffect(() => {
    const handleBridgeMessage = (message: BridgeMessage) => {
      if (!message?.type) return;
      if (message.type === "blockEditorInit") {
        const payload = message.payload as { path?: string; content?: string } | undefined;
        syncFromContent(payload?.content ?? "", payload?.path ?? "");
        return;
      }
      if (message.type === "blockEditorSyncResult") {
        const payload = message.payload as SyncResponse;
        const pendingRequest = pendingRequestsRef.current.get(payload.requestId);
        if (pendingRequest) {
          pendingRequestsRef.current.delete(payload.requestId);
          pendingRequest.resolve(payload);
        }
        return;
      }
      if (message.type === "blockEditorPatchResult") {
        const payload = message.payload as PatchResponse;
        const pendingRequest = pendingRequestsRef.current.get(payload.requestId);
        if (pendingRequest) {
          pendingRequestsRef.current.delete(payload.requestId);
          pendingRequest.resolve(payload);
        }
      }
    };

    if (bridgeWindow.tex180Bridge?.onMessage) {
      bridgeWindow.tex180Bridge.onMessage(handleBridgeMessage);
    }
  }, [bridgeWindow, syncFromContent]);

  return (
    <LanguageProvider>
      <MathFieldProvider>
        <div className="h-screen w-screen flex flex-col bg-slate-50">
          <header className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white/80 backdrop-blur">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-800">ブロック編集</div>
              <div className="text-xs text-slate-500 truncate">{filePath || "ファイル未選択"}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${showDiff ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
                onClick={() => setShowDiff((prev) => !prev)}
              >
                差分
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-60"
                onClick={applyChanges}
                disabled={!isDirty || pending}
              >
                適用
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                onClick={() => window.close()}
              >
                閉じる
              </button>
            </div>
          </header>

          <div
            className="flex flex-1 overflow-hidden relative bg-gradient-to-br from-slate-50 via-indigo-50/30 to-white"
            ref={containerRef}
          >
            <div
              ref={leftPaneRef}
              className="p-4 flex-shrink-0"
              style={{ width: `${paneSplit}%`, minWidth: "20%", maxWidth: "50%" }}
            >
              <Tex180MathKeyboard forceOpen />
            </div>

            <div
              className={`w-1 cursor-col-resize flex-shrink-0 group relative ${
                isDragging ? "bg-indigo-500" : "bg-slate-200 hover:bg-indigo-400"
              } transition-colors`}
              onMouseDown={(event) => {
                event.preventDefault();
                setIsDragging(true);
                const startX = event.clientX;
                const startSplit = paneSplitRef.current;
                const container = containerRef.current;
                const leftPane = leftPaneRef.current;
                if (!container || !leftPane) return;
                const containerWidth = container.offsetWidth;

                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const deltaX = moveEvent.clientX - startX;
                  const deltaPercent = (deltaX / containerWidth) * 100;
                  const newSplit = Math.min(50, Math.max(20, startSplit + deltaPercent));
                  paneSplitRef.current = newSplit;
                  leftPane.style.width = `${newSplit}%`;
                };

                const handleMouseUp = () => {
                  setIsDragging(false);
                  setPaneSplit(paneSplitRef.current);
                  window.removeEventListener("mousemove", handleMouseMove);
                  window.removeEventListener("mouseup", handleMouseUp);
                };

                window.addEventListener("mousemove", handleMouseMove);
                window.addEventListener("mouseup", handleMouseUp);
              }}
            >
              <div
                className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-8 rounded-full flex items-center justify-center ${
                  isDragging ? "bg-indigo-600" : "bg-slate-300 group-hover:bg-indigo-500"
                } transition-colors`}
              >
                <div className="flex flex-col gap-0.5">
                  <div
                    className={`w-0.5 h-1.5 rounded-full ${
                      isDragging ? "bg-white" : "bg-slate-500 group-hover:bg-white"
                    }`}
                  />
                  <div
                    className={`w-0.5 h-1.5 rounded-full ${
                      isDragging ? "bg-white" : "bg-slate-500 group-hover:bg-white"
                    }`}
                  />
                  <div
                    className={`w-0.5 h-1.5 rounded-full ${
                      isDragging ? "bg-white" : "bg-slate-500 group-hover:bg-white"
                    }`}
                  />
                </div>
              </div>
            </div>

            <div className="p-4 flex-1 relative" style={{ minWidth: "35%" }}>
              <div className="h-full rounded-2xl border border-slate-200 bg-white shadow-[0_14px_45px_rgba(0,0,0,0.08)] overflow-hidden">
                <DocumentEditor
                  document={draftDocument}
                  onChange={setDraftDocument}
                  canUndo={false}
                  canRedo={false}
                />
              </div>

              <DiffViewer 
                original={sourceContent} 
                modified={modifiedContent} 
                isOpen={showDiff} 
                onClose={() => setShowDiff(false)} 
              />

              {status && (
                <div className="absolute left-6 bottom-6 bg-white/90 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-600 shadow">
                  {status}
                </div>
              )}
            </div>
          </div>
        </div>
      </MathFieldProvider>
    </LanguageProvider>
  );
}
