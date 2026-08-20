import { uiText } from "./i18n.js";
import type { BridgeWindow } from "./types.js";

export const PRO_STASH_STORAGE_KEY = "tex64.proStash.v1";
export const PRO_STASH_MAX_BYTES = 8 * 1024 * 1024;

export type ProStashItem = {
  id: string;
  kind: "image" | "text";
  content: string;
  createdAt: number;
};

export type StashPrompt = { system: string; user: string };

export const reorderStashItems = <T>(items: readonly T[], from: number, to: number): T[] => {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
};

// "Copy all" is plain text, so images have nothing to contribute: report how
// many were left out instead of pasting base64 blobs into someone's document.
export const stashClipboardText = (items: readonly ProStashItem[]): { text: string; skipped: number } => {
  const texts = items.filter((item) => item.kind === "text");
  return { text: texts.map((item) => item.content).join("\n\n"), skipped: items.length - texts.length };
};

export const buildStashEditPrompt = (items: readonly ProStashItem[], instruction: string): StashPrompt => ({
  system: 'You are a LaTeX editing assistant. Apply the user\'s instruction to the numbered fragments and return the results, still numbered. Omit any fragment the instruction says to delete. Keep each fragment in its own language. Reply with JSON only: {"items": [{"n": <number>, "text": "..."}]}.',
  user: `${items.map((item, index) => `[${index + 1}]\n${item.content}`).join("\n\n")}\n\nInstruction:\n${instruction.trim()}`,
});

export const parseStashEditResponse = (raw: string): Array<{ n: number; text: string }> => {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(trimmed) as { items?: unknown };
  if (!Array.isArray(parsed?.items)) throw new Error("AI response does not contain an items array.");
  return parsed.items.map((value) => {
    const entry = value as { n?: unknown; text?: unknown };
    if (!Number.isInteger(entry.n) || (entry.n as number) < 1 || typeof entry.text !== "string") {
      throw new Error("AI response contains an invalid item.");
    }
    return { n: entry.n as number, text: entry.text };
  });
};

const storageBytes = (items: readonly ProStashItem[]) => new TextEncoder().encode(JSON.stringify(items)).byteLength;

export const enforceStashCapacity = (
  items: readonly ProStashItem[],
  maxBytes = PRO_STASH_MAX_BYTES
): { items: ProStashItem[]; removed: ProStashItem[]; bytes: number } => {
  const kept = [...items];
  const removed: ProStashItem[] = [];
  let bytes = storageBytes(kept);
  while (kept.length > 0 && bytes > maxBytes) {
    removed.push(kept.shift()!);
    bytes = storageBytes(kept);
  }
  return { items: kept, removed, bytes };
};

export const runStashAiEdit = async (
  items: readonly ProStashItem[],
  instruction: string,
  deps: {
    texize: (base64: string) => Promise<string>;
    complete: (prompt: StashPrompt) => Promise<string>;
    onConverting?: (index: number) => void;
  }
): Promise<ProStashItem[]> => {
  const converted: ProStashItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "image") {
      deps.onConverting?.(index);
      converted.push({ ...item, kind: "text", content: await deps.texize(item.content.slice(item.content.indexOf(",") + 1)) });
    } else converted.push({ ...item });
  }
  const response = await deps.complete(buildStashEditPrompt(converted, instruction));
  const now = Date.now();
  return parseStashEditResponse(response).map((entry, index) => ({
    id: `stash-result-${now}-${index}`,
    kind: "text",
    content: entry.text,
    createdAt: now + index,
  }));
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("clipboard image could not be read"));
    reader.readAsDataURL(blob);
  });

const dataTransferImages = (data: DataTransfer | null) =>
  Array.from(data?.files ?? []).filter((file) => file.type.startsWith("image/"));

type StashDeps = {
  getActiveGroup: () => { editor: unknown | null };
  // Captures and the editor's "Add selection to stash" land in a sidebar tab
  // that may not be the open one, so the tray asks to be shown.
  revealStash?: () => void;
};

export const initProStashUi = (deps: StashDeps) => {
  const bridge = window as BridgeWindow;
  const panel = document.querySelector<HTMLElement>('.panel[data-panel="stash"]');
  if (!panel) return { add: () => {} };
  let items: ProStashItem[] = [];
  let result: ProStashItem[] | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(PRO_STASH_STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) items = saved.filter((x) => x && (x.kind === "image" || x.kind === "text") && typeof x.content === "string");
  } catch { /* ignore corrupt storage */ }

  panel.innerHTML = `<div class="panel-header"><span class="panel-title">${uiText("Stash", "スタッシュ")}</span><div class="panel-header-actions"><span data-stash-count>0</span><button class="panel-button ghost" data-stash-clear type="button">${uiText("Clear", "全クリア")}</button></div></div><div class="panel-body pro-stash" tabindex="0"><div class="pro-stash-list"></div><div class="pro-stash-dropzone">${uiText("Drop or paste text and images here", "テキストや画像をここへドロップ / 貼り付け")}</div><div class="pro-stash-add"><button data-stash-selection type="button">${uiText("Add selection", "選択範囲を追加")}</button></div><textarea data-stash-instruction rows="3" placeholder="${uiText("Swap 1 and 2, shorten 5, remove 6", "1と2を入れ替え、5はもっと短く、6は丸々カット")}"></textarea><div class="pro-stash-actions"><button data-stash-ai type="button">${uiText("AI edit", "AI編集")}</button><span data-stash-status></span></div><div class="pro-stash-output" hidden><button data-stash-apply type="button">${uiText("Apply", "適用")}</button><button data-stash-discard type="button">${uiText("Discard", "破棄")}</button></div></div>`;
  const body = panel.querySelector<HTMLElement>(".pro-stash")!;
  const list = panel.querySelector<HTMLElement>(".pro-stash-list")!;
  const status = panel.querySelector<HTMLElement>("[data-stash-status]")!;
  const output = panel.querySelector<HTMLElement>(".pro-stash-output")!;
  const setStatus = (text: string) => { status.textContent = text; };

  const persist = () => localStorage.setItem(PRO_STASH_STORAGE_KEY, JSON.stringify(items));

  const copyItem = async (item: ProStashItem) => {
    try {
      if (item.kind === "image" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const blob = await (await fetch(item.content)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      } else await navigator.clipboard.writeText(item.content);
      setStatus(uiText("Copied.", "コピーしました。"));
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const render = () => {
    const shown = result ?? items;
    panel.querySelector<HTMLElement>("[data-stash-count]")!.textContent = String(shown.length);
    body.classList.toggle("is-result", result !== null);
    output.hidden = result === null;
    list.replaceChildren(...shown.map((item, index) => {
      const row = document.createElement("article"); row.className = "pro-stash-item"; row.tabIndex = 0; row.dataset.stashIndex = String(index);
      const badge = document.createElement("b"); badge.textContent = String(index + 1);
      const preview = item.kind === "image" ? document.createElement("img") : document.createElement("pre");
      if (preview instanceof HTMLImageElement) { preview.src = item.content; preview.alt = `${uiText("Stash item", "スタッシュ項目")} ${index + 1}`; }
      else preview.textContent = item.content.split("\n").slice(0, 3).join("\n");
      row.addEventListener("click", (event) => {
        if ((event.target as Element).closest("button")) return;
        // A click that ends a text selection is someone copying, not someone
        // asking for the full fragment: re-rendering here would drop it.
        if ((window.getSelection()?.toString() ?? "").length > 0) return;
        row.classList.toggle("is-expanded");
        if (preview instanceof HTMLPreElement) preview.textContent = row.classList.contains("is-expanded") ? item.content : item.content.split("\n").slice(0, 3).join("\n");
      });
      row.addEventListener("keydown", (event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c") return;
        if ((window.getSelection()?.toString() ?? "").length > 0) return;
        event.preventDefault(); void copyItem(item);
      });
      row.append(badge, preview);
      const controls = document.createElement("span"); controls.className = "pro-stash-item-actions";
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "is-copy"; copy.textContent = "⧉"; copy.title = uiText("Copy", "コピー");
      copy.onclick = () => { void copyItem(item); }; controls.appendChild(copy);
      if (!result) {
        // The number badge is the drag handle so the fragment itself stays
        // selectable — a draggable row swallows text selection.
        badge.draggable = true; badge.title = uiText("Drag to reorder", "ドラッグで並べ替え");
        badge.addEventListener("dragstart", (event) => { event.dataTransfer?.setData("application/x-tex64-stash-index", String(index)); event.dataTransfer?.setDragImage(row, 12, 12); row.classList.add("is-dragging"); });
        badge.addEventListener("dragend", () => row.classList.remove("is-dragging"));
        row.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("application/x-tex64-stash-index")) { event.preventDefault(); row.classList.add("is-drag-over"); } });
        row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
        row.addEventListener("drop", (event) => { const from = Number(event.dataTransfer?.getData("application/x-tex64-stash-index")); row.classList.remove("is-drag-over"); if (Number.isInteger(from)) { event.preventDefault(); items = reorderStashItems(items, from, index); persist(); render(); } });
        ([["↑", -1, "is-move-up"], ["↓", 1, "is-move-down"]] as const).forEach(([label, delta, cls]) => { const button = document.createElement("button"); button.type = "button"; button.className = cls; button.textContent = String(label); button.disabled = index + Number(delta) < 0 || index + Number(delta) >= items.length; button.onclick = () => { const next = index + Number(delta); [items[index], items[next]] = [items[next], items[index]]; persist(); render(); }; controls.appendChild(button); });
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "is-remove"; remove.textContent = "×"; remove.title = uiText("Remove", "削除"); remove.onclick = () => { items.splice(index, 1); persist(); render(); }; controls.appendChild(remove);
      }
      row.appendChild(controls);
      return row;
    }));
  };

  const add = (kind: "image" | "text", content: string) => {
    if (!content) return;
    items.push({ id: `stash-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind, content, createdAt: Date.now() });
    const limited = enforceStashCapacity(items);
    items = limited.items;
    if (limited.removed.length) setStatus(uiText(`${limited.removed.length} oldest item(s) removed (8 MB limit).`, `8MB制限のため古い項目を${limited.removed.length}件削除しました。`));
    persist(); render();
  };
  window.addEventListener("tex64:pro-stash-add", (event) => {
    const detail = (event as CustomEvent<{ kind: "image" | "text"; content: string }>).detail;
    if (!detail) return;
    add(detail.kind, detail.content);
    deps.revealStash?.();
  });

  panel.querySelector("[data-stash-clear]")?.addEventListener("click", () => { items = []; result = null; persist(); render(); });
  panel.querySelector("[data-stash-selection]")?.addEventListener("click", () => {
    const editor = deps.getActiveGroup().editor as any; const selection = editor?.getSelection?.(); const text = selection ? editor?.getModel?.()?.getValueInRange?.(selection) : "";
    if (text) add("text", text); else setStatus(uiText("Select text in the editor first.", "先にエディタでテキストを選択してください。"));
  });
  // Cmd+V anywhere in the tray stashes the clipboard; the instruction box keeps
  // its own native paste.
  body.addEventListener("paste", (event) => {
    if ((event.target as Element | null)?.closest("textarea, input")) return;
    const images = dataTransferImages(event.clipboardData);
    const text = (event.clipboardData?.getData("text/plain") ?? "").trim();
    if (!images.length && !text) return;
    event.preventDefault();
    images.forEach((file) => { void blobToDataUrl(file).then((url) => add("image", url)); });
    if (text) add("text", text);
  });

  panel.querySelector("[data-stash-ai]")?.addEventListener("click", async () => {
    const instruction = (panel.querySelector("[data-stash-instruction]") as HTMLTextAreaElement).value.trim();
    if (!items.length || !instruction) { setStatus(uiText("Add items and enter an instruction.", "項目を追加して指示を入力してください。")); return; }
    const button = panel.querySelector<HTMLButtonElement>("[data-stash-ai]")!; button.disabled = true;
    try {
      result = await runStashAiEdit(items, instruction, {
        texize: async (base64) => { const response = await bridge.tex64Texize?.snippet?.({ imageBase64: base64 }); if (!response?.ok) throw new Error(response?.error || "texize failed."); return response.tex || ""; },
        complete: async (prompt) => { const response = await bridge.tex64Ai?.complete?.(prompt); if (!response?.ok) throw new Error(response?.error || "AI edit failed."); return response.text || ""; },
        onConverting: (index) => { setStatus(uiText(`Converting image ${index + 1}…`, `画像${index + 1}をTeX化中…`)); },
      }); setStatus(uiText("Review the result.", "結果を確認してください。")); render();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { button.disabled = false; }
  });
  panel.querySelector("[data-stash-apply]")?.addEventListener("click", () => { if (result) { items = result; result = null; persist(); render(); } });
  panel.querySelector("[data-stash-discard]")?.addEventListener("click", () => { result = null; render(); });

  const dropzone = panel.querySelector<HTMLElement>(".pro-stash-dropzone")!;
  dropzone.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.some((type) => type === "text/plain" || type === "Files")) return;
    event.preventDefault(); dropzone.classList.add("is-drag-over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag-over"));
  dropzone.addEventListener("drop", (event) => {
    const images = dataTransferImages(event.dataTransfer);
    const text = (event.dataTransfer?.getData("text/plain") ?? "").trim();
    dropzone.classList.remove("is-drag-over");
    if (!images.length && !text) return;
    event.preventDefault();
    images.forEach((file) => { void blobToDataUrl(file).then((url) => add("image", url)); });
    if (text) add("text", text);
  });

  render();
  return { add };
};
