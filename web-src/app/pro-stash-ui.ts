import { uiText } from "./i18n.js";
import { insertAtEditorCursor, type ProEditorLike } from "./pro-editor-insert.js";
import type { BridgeWindow } from "./types.js";

export const PRO_STASH_STORAGE_KEY = "tex64.proStash.v1";
export const PRO_STASH_UI_STORAGE_KEY = "tex64.proStashUi.v1";
export const PRO_STASH_MAX_BYTES = 8 * 1024 * 1024;

export type ProStashItem = {
  id: string;
  kind: "image" | "text";
  content: string;
  createdAt: number;
};

export type StashPrompt = { system: string; user: string };
export type ProStashUiState = { side: "left" | "right"; width: number; collapsed: boolean };

export const reorderStashItems = <T>(items: readonly T[], from: number, to: number): T[] => {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
};
export const snapStashSide = (clientX: number, viewportWidth: number): "left" | "right" => clientX < viewportWidth / 2 ? "left" : "right";
export const clampStashWidth = (width: number, viewportWidth: number, min = 260, max = 560): number =>
  Math.round(Math.min(Math.max(width, min), Math.min(max, Math.max(min, viewportWidth - 32))));
export const parseProStashUiState = (raw: string | null, viewportWidth = 1024): ProStashUiState => {
  try {
    const value = JSON.parse(raw || "{}") as Partial<ProStashUiState>;
    return { side: value.side === "left" ? "left" : "right", width: clampStashWidth(Number(value.width) || 340, viewportWidth), collapsed: value.collapsed === true };
  } catch { return { side: "right", width: 340, collapsed: false }; }
};

export const buildStashEditPrompt = (items: readonly ProStashItem[], instruction: string): StashPrompt => ({
  system: 'あなたはLaTeX編集アシスタント。番号付き断片群にユーザー指示を適用し、結果を番号付きで返す。削除指定は出力から除外。JSON で {"items": [{"n": 番号, "text": "..."}]} のみ返す。',
  user: `${items.map((item, index) => `[${index + 1}]\n${item.content}`).join("\n\n")}\n\nユーザー指示:\n${instruction.trim()}`,
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

type StashDeps = {
  getActiveGroup: () => { editor: unknown | null };
};

export const initProStashUi = (deps: StashDeps) => {
  const bridge = window as BridgeWindow;
  let items: ProStashItem[] = [];
  let result: ProStashItem[] | null = null;
  let uiState = parseProStashUiState(localStorage.getItem(PRO_STASH_UI_STORAGE_KEY), window.innerWidth);
  try {
    const saved = JSON.parse(localStorage.getItem(PRO_STASH_STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) items = saved.filter((x) => x && (x.kind === "image" || x.kind === "text") && typeof x.content === "string");
  } catch { /* ignore corrupt storage */ }

  const root = document.createElement("aside");
  root.className = "pro-stash";
  root.innerHTML = `<div class="pro-stash-resizer" aria-hidden="true"></div><header><button data-stash-toggle aria-expanded="true">▾</button><strong>${uiText("Stash", "スタッシュ")}</strong><span data-stash-count></span><button data-stash-clear>${uiText("Clear", "全クリア")}</button></header><div class="pro-stash-body"><div class="pro-stash-list"></div><div class="pro-stash-dropzone">${uiText("Drop selected text here", "選択テキストをここへドロップ")}</div><button data-stash-selection>＋ ${uiText("Selection", "選択範囲")}</button><textarea data-stash-instruction rows="3" placeholder="${uiText("Swap 1 and 2, shorten 5, remove 6", "1と2を入れ替え、5はもっと短く、6は丸々カット")}"></textarea><div class="pro-stash-actions"><button data-stash-ai>${uiText("AI edit", "AI編集")}</button><span data-stash-status></span></div><div class="pro-stash-output" hidden><button data-stash-apply>${uiText("Apply", "適用")}</button><button data-stash-discard>${uiText("Discard", "破棄")}</button><button data-stash-insert>${uiText("Insert all at cursor", "全部をカーソル位置に挿入")}</button><button data-stash-copy>${uiText("Copy", "コピー")}</button></div></div>`;
  document.body.appendChild(root);
  const list = root.querySelector<HTMLElement>(".pro-stash-list")!;
  const status = root.querySelector<HTMLElement>("[data-stash-status]")!;
  const output = root.querySelector<HTMLElement>(".pro-stash-output")!;

  const persistUi = () => localStorage.setItem(PRO_STASH_UI_STORAGE_KEY, JSON.stringify(uiState));
  const applyUi = () => {
    root.dataset.side = uiState.side; root.style.width = `${uiState.width}px`;
    root.classList.toggle("is-collapsed", uiState.collapsed);
    root.querySelector("[data-stash-toggle]")?.setAttribute("aria-expanded", String(!uiState.collapsed));
  };

  const persist = () => localStorage.setItem(PRO_STASH_STORAGE_KEY, JSON.stringify(items));
  const render = () => {
    const shown = result ?? items;
    root.querySelector<HTMLElement>("[data-stash-count]")!.textContent = String(shown.length);
    root.classList.toggle("is-result", result !== null);
    output.hidden = result === null;
    list.replaceChildren(...shown.map((item, index) => {
      const row = document.createElement("article"); row.className = "pro-stash-item"; row.tabIndex = 0; row.draggable = result === null; row.dataset.stashIndex = String(index);
      const badge = document.createElement("b"); badge.textContent = String(index + 1);
      const preview = item.kind === "image" ? document.createElement("img") : document.createElement("pre");
      if (preview instanceof HTMLImageElement) { preview.src = item.content; preview.alt = `${uiText("Stash item", "スタッシュ項目")} ${index + 1}`; }
      else preview.textContent = item.content.split("\n").slice(0, 3).join("\n");
      row.addEventListener("click", (event) => {
        if ((event.target as Element).closest("button")) return;
        row.classList.toggle("is-expanded");
        if (preview instanceof HTMLPreElement) preview.textContent = row.classList.contains("is-expanded") ? item.content : item.content.split("\n").slice(0, 3).join("\n");
      });
      row.append(badge, preview);
      if (!result) {
        row.addEventListener("dragstart", (event) => { event.dataTransfer?.setData("application/x-tex64-stash-index", String(index)); row.classList.add("is-dragging"); });
        row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
        row.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("application/x-tex64-stash-index")) { event.preventDefault(); row.classList.add("is-drag-over"); } });
        row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
        row.addEventListener("drop", (event) => { const from = Number(event.dataTransfer?.getData("application/x-tex64-stash-index")); if (Number.isInteger(from)) { event.preventDefault(); items = reorderStashItems(items, from, index); persist(); render(); } });
        const controls = document.createElement("span"); controls.className = "pro-stash-item-actions";
        [["↑", -1], ["↓", 1]].forEach(([label, delta]) => { const button = document.createElement("button"); button.textContent = String(label); button.disabled = index + Number(delta) < 0 || index + Number(delta) >= items.length; button.onclick = () => { const next = index + Number(delta); [items[index], items[next]] = [items[next], items[index]]; persist(); render(); }; controls.appendChild(button); });
        const remove = document.createElement("button"); remove.textContent = "×"; remove.title = uiText("Remove", "削除"); remove.onclick = () => { items.splice(index, 1); persist(); render(); }; controls.appendChild(remove); row.appendChild(controls);
      }
      return row;
    }));
  };

  const add = (kind: "image" | "text", content: string) => {
    if (!content) return;
    items.push({ id: `stash-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind, content, createdAt: Date.now() });
    const limited = enforceStashCapacity(items);
    items = limited.items;
    if (limited.removed.length) status.textContent = uiText(`${limited.removed.length} oldest item(s) removed (8 MB limit).`, `8MB制限のため古い項目を${limited.removed.length}件削除しました。`);
    persist(); render();
  };
  window.addEventListener("tex64:pro-stash-add", (event) => {
    const detail = (event as CustomEvent<{ kind: "image" | "text"; content: string }>).detail;
    if (detail) add(detail.kind, detail.content);
  });

  root.querySelector("[data-stash-toggle]")?.addEventListener("click", () => { uiState = { ...uiState, collapsed: !uiState.collapsed }; applyUi(); persistUi(); });
  root.querySelector("[data-stash-clear]")?.addEventListener("click", () => { items = []; result = null; persist(); render(); });
  root.querySelector("[data-stash-selection]")?.addEventListener("click", () => {
    const editor = deps.getActiveGroup().editor as any; const selection = editor?.getSelection?.(); const text = selection ? editor?.getModel?.()?.getValueInRange?.(selection) : "";
    if (text) add("text", text); else status.textContent = uiText("Select text in the editor first.", "先にエディタでテキストを選択してください。");
  });
  root.querySelector("[data-stash-ai]")?.addEventListener("click", async () => {
    const instruction = (root.querySelector("[data-stash-instruction]") as HTMLTextAreaElement).value.trim();
    if (!items.length || !instruction) { status.textContent = uiText("Add items and enter an instruction.", "項目を追加して指示を入力してください。"); return; }
    const button = root.querySelector<HTMLButtonElement>("[data-stash-ai]")!; button.disabled = true;
    try {
      result = await runStashAiEdit(items, instruction, {
        texize: async (base64) => { const response = await bridge.tex64Texize?.snippet?.({ imageBase64: base64 }); if (!response?.ok) throw new Error(response?.error || "texize failed."); return response.tex || ""; },
        complete: async (prompt) => { const response = await bridge.tex64Ai?.complete?.(prompt); if (!response?.ok) throw new Error(response?.error || "AI edit failed."); return response.text || ""; },
        onConverting: (index) => { status.textContent = uiText(`Converting image ${index + 1}…`, `画像${index + 1}をTeX化中…`); },
      }); status.textContent = uiText("Review the result.", "結果を確認してください。"); render();
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { button.disabled = false; }
  });
  root.querySelector("[data-stash-apply]")?.addEventListener("click", () => { if (result) { items = result; result = null; persist(); render(); } });
  root.querySelector("[data-stash-discard]")?.addEventListener("click", () => { result = null; render(); });
  const resultText = () => (result ?? items).map((item) => item.content).join("\n\n");
  root.querySelector("[data-stash-insert]")?.addEventListener("click", () => { try { insertAtEditorCursor(deps.getActiveGroup().editor as ProEditorLike | null, resultText()); } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); } });
  root.querySelector("[data-stash-copy]")?.addEventListener("click", async () => { await navigator.clipboard.writeText(resultText()); status.textContent = uiText("Copied.", "コピーしました。"); });

  const header = root.querySelector<HTMLElement>("header")!;
  let headerStartX = 0;
  header.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest("button")) return;
    headerStartX = event.clientX; header.setPointerCapture(event.pointerId); root.classList.add("is-positioning");
  });
  header.addEventListener("pointerup", (event) => {
    if (!header.hasPointerCapture(event.pointerId)) return;
    header.releasePointerCapture(event.pointerId); root.classList.remove("is-positioning");
    if (Math.abs(event.clientX - headerStartX) >= 8) uiState = { ...uiState, side: snapStashSide(event.clientX, window.innerWidth) };
    else if (uiState.collapsed) uiState = { ...uiState, collapsed: false };
    applyUi(); persistUi();
  });
  header.addEventListener("pointercancel", () => root.classList.remove("is-positioning"));

  const resizer = root.querySelector<HTMLElement>(".pro-stash-resizer")!;
  let resizeStartX = 0; let resizeStartWidth = 0;
  resizer.addEventListener("pointerdown", (event) => { resizeStartX = event.clientX; resizeStartWidth = root.getBoundingClientRect().width; resizer.setPointerCapture(event.pointerId); root.classList.add("is-resizing"); });
  resizer.addEventListener("pointermove", (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    uiState = { ...uiState, width: clampStashWidth(resizeStartWidth + resizeStartX - event.clientX, window.innerWidth) }; applyUi();
  });
  const stopResize = (event: PointerEvent) => { if (!resizer.hasPointerCapture(event.pointerId)) return; resizer.releasePointerCapture(event.pointerId); root.classList.remove("is-resizing"); persistUi(); };
  resizer.addEventListener("pointerup", stopResize); resizer.addEventListener("pointercancel", stopResize);

  const dropzone = root.querySelector<HTMLElement>(".pro-stash-dropzone")!;
  dropzone.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("text/plain")) { event.preventDefault(); dropzone.classList.add("is-drag-over"); } });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag-over"));
  dropzone.addEventListener("drop", (event) => { const text = event.dataTransfer?.getData("text/plain").trim(); dropzone.classList.remove("is-drag-over"); if (text) { event.preventDefault(); add("text", text); } });

  applyUi();
  render();
  return { add };
};
