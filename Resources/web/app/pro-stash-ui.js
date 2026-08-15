import { uiText } from "./i18n.js";
import { insertAtEditorCursor } from "./pro-editor-insert.js";
export const PRO_STASH_STORAGE_KEY = "tex64.proStash.v1";
export const PRO_STASH_UI_STORAGE_KEY = "tex64.proStashUi.v1";
export const PRO_STASH_MAX_BYTES = 8 * 1024 * 1024;
export const reorderStashItems = (items, from, to) => {
    const next = [...items];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to)
        return next;
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
};
export const snapStashSide = (clientX, viewportWidth) => clientX < viewportWidth / 2 ? "left" : "right";
export const clampStashWidth = (width, viewportWidth, min = 260, max = 560) => Math.round(Math.min(Math.max(width, min), Math.min(max, Math.max(min, viewportWidth - 32))));
// The tray starts collapsed: expanded, it is a 340px panel floating over the
// bottom-right of the editor, and on first run it covered the very code the
// canvas had just inserted. Collapsed it is a pill that still shows its name
// and count, so it stays discoverable without hiding the document.
export const parseProStashUiState = (raw, viewportWidth = 1024) => {
    try {
        const value = JSON.parse(raw || "{}");
        return { side: value.side === "left" ? "left" : "right", width: clampStashWidth(Number(value.width) || 340, viewportWidth), collapsed: value.collapsed !== false };
    }
    catch {
        return { side: "right", width: 340, collapsed: true };
    }
};
export const buildStashEditPrompt = (items, instruction) => ({
    system: 'You are a LaTeX editing assistant. Apply the user\'s instruction to the numbered fragments and return the results, still numbered. Omit any fragment the instruction says to delete. Keep each fragment in its own language. Reply with JSON only: {"items": [{"n": <number>, "text": "..."}]}.',
    user: `${items.map((item, index) => `[${index + 1}]\n${item.content}`).join("\n\n")}\n\nInstruction:\n${instruction.trim()}`,
});
export const parseStashEditResponse = (raw) => {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed === null || parsed === void 0 ? void 0 : parsed.items))
        throw new Error("AI response does not contain an items array.");
    return parsed.items.map((value) => {
        const entry = value;
        if (!Number.isInteger(entry.n) || entry.n < 1 || typeof entry.text !== "string") {
            throw new Error("AI response contains an invalid item.");
        }
        return { n: entry.n, text: entry.text };
    });
};
const storageBytes = (items) => new TextEncoder().encode(JSON.stringify(items)).byteLength;
export const enforceStashCapacity = (items, maxBytes = PRO_STASH_MAX_BYTES) => {
    const kept = [...items];
    const removed = [];
    let bytes = storageBytes(kept);
    while (kept.length > 0 && bytes > maxBytes) {
        removed.push(kept.shift());
        bytes = storageBytes(kept);
    }
    return { items: kept, removed, bytes };
};
export const runStashAiEdit = async (items, instruction, deps) => {
    var _a;
    const converted = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.kind === "image") {
            (_a = deps.onConverting) === null || _a === void 0 ? void 0 : _a.call(deps, index);
            converted.push({ ...item, kind: "text", content: await deps.texize(item.content.slice(item.content.indexOf(",") + 1)) });
        }
        else
            converted.push({ ...item });
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
export const initProStashUi = (deps) => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const bridge = window;
    let items = [];
    let result = null;
    let uiState = parseProStashUiState(localStorage.getItem(PRO_STASH_UI_STORAGE_KEY), window.innerWidth);
    try {
        const saved = JSON.parse(localStorage.getItem(PRO_STASH_STORAGE_KEY) || "[]");
        if (Array.isArray(saved))
            items = saved.filter((x) => x && (x.kind === "image" || x.kind === "text") && typeof x.content === "string");
    }
    catch { /* ignore corrupt storage */ }
    const root = document.createElement("aside");
    root.className = "pro-stash";
    root.innerHTML = `<div class="pro-stash-resizer" aria-hidden="true"></div><header><button data-stash-toggle aria-expanded="true">▾</button><strong>${uiText("Stash", "スタッシュ")}</strong><span data-stash-count></span><button data-stash-clear>${uiText("Clear", "全クリア")}</button></header><div class="pro-stash-body"><div class="pro-stash-list"></div><div class="pro-stash-dropzone">${uiText("Drop selected text here", "選択テキストをここへドロップ")}</div><button data-stash-selection>＋ ${uiText("Selection", "選択範囲")}</button><textarea data-stash-instruction rows="3" placeholder="${uiText("Swap 1 and 2, shorten 5, remove 6", "1と2を入れ替え、5はもっと短く、6は丸々カット")}"></textarea><div class="pro-stash-actions"><button data-stash-ai>${uiText("AI edit", "AI編集")}</button><span data-stash-status></span></div><div class="pro-stash-output" hidden><button data-stash-apply>${uiText("Apply", "適用")}</button><button data-stash-discard>${uiText("Discard", "破棄")}</button><button data-stash-insert>${uiText("Insert all at cursor", "全部をカーソル位置に挿入")}</button><button data-stash-copy>${uiText("Copy", "コピー")}</button></div></div>`;
    document.body.appendChild(root);
    const list = root.querySelector(".pro-stash-list");
    const status = root.querySelector("[data-stash-status]");
    const output = root.querySelector(".pro-stash-output");
    const persistUi = () => localStorage.setItem(PRO_STASH_UI_STORAGE_KEY, JSON.stringify(uiState));
    const applyUi = () => {
        var _a;
        root.dataset.side = uiState.side;
        root.style.width = `${uiState.width}px`;
        root.classList.toggle("is-collapsed", uiState.collapsed);
        (_a = root.querySelector("[data-stash-toggle]")) === null || _a === void 0 ? void 0 : _a.setAttribute("aria-expanded", String(!uiState.collapsed));
    };
    const persist = () => localStorage.setItem(PRO_STASH_STORAGE_KEY, JSON.stringify(items));
    const render = () => {
        const shown = result !== null && result !== void 0 ? result : items;
        root.querySelector("[data-stash-count]").textContent = String(shown.length);
        root.classList.toggle("is-result", result !== null);
        output.hidden = result === null;
        list.replaceChildren(...shown.map((item, index) => {
            const row = document.createElement("article");
            row.className = "pro-stash-item";
            row.tabIndex = 0;
            row.draggable = result === null;
            row.dataset.stashIndex = String(index);
            const badge = document.createElement("b");
            badge.textContent = String(index + 1);
            const preview = item.kind === "image" ? document.createElement("img") : document.createElement("pre");
            if (preview instanceof HTMLImageElement) {
                preview.src = item.content;
                preview.alt = `${uiText("Stash item", "スタッシュ項目")} ${index + 1}`;
            }
            else
                preview.textContent = item.content.split("\n").slice(0, 3).join("\n");
            row.addEventListener("click", (event) => {
                if (event.target.closest("button"))
                    return;
                row.classList.toggle("is-expanded");
                if (preview instanceof HTMLPreElement)
                    preview.textContent = row.classList.contains("is-expanded") ? item.content : item.content.split("\n").slice(0, 3).join("\n");
            });
            row.append(badge, preview);
            if (!result) {
                row.addEventListener("dragstart", (event) => { var _a; (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.setData("application/x-tex64-stash-index", String(index)); row.classList.add("is-dragging"); });
                row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
                row.addEventListener("dragover", (event) => { var _a; if ((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types.includes("application/x-tex64-stash-index")) {
                    event.preventDefault();
                    row.classList.add("is-drag-over");
                } });
                row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
                row.addEventListener("drop", (event) => { var _a; const from = Number((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData("application/x-tex64-stash-index")); if (Number.isInteger(from)) {
                    event.preventDefault();
                    items = reorderStashItems(items, from, index);
                    persist();
                    render();
                } });
                const controls = document.createElement("span");
                controls.className = "pro-stash-item-actions";
                [["↑", -1], ["↓", 1]].forEach(([label, delta]) => { const button = document.createElement("button"); button.textContent = String(label); button.disabled = index + Number(delta) < 0 || index + Number(delta) >= items.length; button.onclick = () => { const next = index + Number(delta); [items[index], items[next]] = [items[next], items[index]]; persist(); render(); }; controls.appendChild(button); });
                const remove = document.createElement("button");
                remove.textContent = "×";
                remove.title = uiText("Remove", "削除");
                remove.onclick = () => { items.splice(index, 1); persist(); render(); };
                controls.appendChild(remove);
                row.appendChild(controls);
            }
            return row;
        }));
    };
    const add = (kind, content) => {
        if (!content)
            return;
        items.push({ id: `stash-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind, content, createdAt: Date.now() });
        const limited = enforceStashCapacity(items);
        items = limited.items;
        if (limited.removed.length)
            status.textContent = uiText(`${limited.removed.length} oldest item(s) removed (8 MB limit).`, `8MB制限のため古い項目を${limited.removed.length}件削除しました。`);
        persist();
        render();
    };
    window.addEventListener("tex64:pro-stash-add", (event) => {
        const detail = event.detail;
        if (detail)
            add(detail.kind, detail.content);
    });
    (_a = root.querySelector("[data-stash-toggle]")) === null || _a === void 0 ? void 0 : _a.addEventListener("click", () => { uiState = { ...uiState, collapsed: !uiState.collapsed }; applyUi(); persistUi(); });
    (_b = root.querySelector("[data-stash-clear]")) === null || _b === void 0 ? void 0 : _b.addEventListener("click", () => { items = []; result = null; persist(); render(); });
    (_c = root.querySelector("[data-stash-selection]")) === null || _c === void 0 ? void 0 : _c.addEventListener("click", () => {
        var _a, _b, _c, _d;
        const editor = deps.getActiveGroup().editor;
        const selection = (_a = editor === null || editor === void 0 ? void 0 : editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
        const text = selection ? (_d = (_c = (_b = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _b === void 0 ? void 0 : _b.call(editor)) === null || _c === void 0 ? void 0 : _c.getValueInRange) === null || _d === void 0 ? void 0 : _d.call(_c, selection) : "";
        if (text)
            add("text", text);
        else
            status.textContent = uiText("Select text in the editor first.", "先にエディタでテキストを選択してください。");
    });
    (_d = root.querySelector("[data-stash-ai]")) === null || _d === void 0 ? void 0 : _d.addEventListener("click", async () => {
        const instruction = root.querySelector("[data-stash-instruction]").value.trim();
        if (!items.length || !instruction) {
            status.textContent = uiText("Add items and enter an instruction.", "項目を追加して指示を入力してください。");
            return;
        }
        const button = root.querySelector("[data-stash-ai]");
        button.disabled = true;
        try {
            result = await runStashAiEdit(items, instruction, {
                texize: async (base64) => { var _a, _b; const response = await ((_b = (_a = bridge.tex64Texize) === null || _a === void 0 ? void 0 : _a.snippet) === null || _b === void 0 ? void 0 : _b.call(_a, { imageBase64: base64 })); if (!(response === null || response === void 0 ? void 0 : response.ok))
                    throw new Error((response === null || response === void 0 ? void 0 : response.error) || "texize failed."); return response.tex || ""; },
                complete: async (prompt) => { var _a, _b; const response = await ((_b = (_a = bridge.tex64Ai) === null || _a === void 0 ? void 0 : _a.complete) === null || _b === void 0 ? void 0 : _b.call(_a, prompt)); if (!(response === null || response === void 0 ? void 0 : response.ok))
                    throw new Error((response === null || response === void 0 ? void 0 : response.error) || "AI edit failed."); return response.text || ""; },
                onConverting: (index) => { status.textContent = uiText(`Converting image ${index + 1}…`, `画像${index + 1}をTeX化中…`); },
            });
            status.textContent = uiText("Review the result.", "結果を確認してください。");
            render();
        }
        catch (error) {
            status.textContent = error instanceof Error ? error.message : String(error);
        }
        finally {
            button.disabled = false;
        }
    });
    (_e = root.querySelector("[data-stash-apply]")) === null || _e === void 0 ? void 0 : _e.addEventListener("click", () => { if (result) {
        items = result;
        result = null;
        persist();
        render();
    } });
    (_f = root.querySelector("[data-stash-discard]")) === null || _f === void 0 ? void 0 : _f.addEventListener("click", () => { result = null; render(); });
    const resultText = () => (result !== null && result !== void 0 ? result : items).map((item) => item.content).join("\n\n");
    (_g = root.querySelector("[data-stash-insert]")) === null || _g === void 0 ? void 0 : _g.addEventListener("click", () => { try {
        insertAtEditorCursor(deps.getActiveGroup().editor, resultText());
    }
    catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
    } });
    (_h = root.querySelector("[data-stash-copy]")) === null || _h === void 0 ? void 0 : _h.addEventListener("click", async () => { await navigator.clipboard.writeText(resultText()); status.textContent = uiText("Copied.", "コピーしました。"); });
    const header = root.querySelector("header");
    let headerStartX = 0;
    header.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button"))
            return;
        headerStartX = event.clientX;
        header.setPointerCapture(event.pointerId);
        root.classList.add("is-positioning");
    });
    header.addEventListener("pointerup", (event) => {
        if (!header.hasPointerCapture(event.pointerId))
            return;
        header.releasePointerCapture(event.pointerId);
        root.classList.remove("is-positioning");
        if (Math.abs(event.clientX - headerStartX) >= 8)
            uiState = { ...uiState, side: snapStashSide(event.clientX, window.innerWidth) };
        else if (uiState.collapsed)
            uiState = { ...uiState, collapsed: false };
        applyUi();
        persistUi();
    });
    header.addEventListener("pointercancel", () => root.classList.remove("is-positioning"));
    const resizer = root.querySelector(".pro-stash-resizer");
    let resizeStartX = 0;
    let resizeStartWidth = 0;
    resizer.addEventListener("pointerdown", (event) => { resizeStartX = event.clientX; resizeStartWidth = root.getBoundingClientRect().width; resizer.setPointerCapture(event.pointerId); root.classList.add("is-resizing"); });
    resizer.addEventListener("pointermove", (event) => {
        if (!resizer.hasPointerCapture(event.pointerId))
            return;
        uiState = { ...uiState, width: clampStashWidth(resizeStartWidth + resizeStartX - event.clientX, window.innerWidth) };
        applyUi();
    });
    const stopResize = (event) => { if (!resizer.hasPointerCapture(event.pointerId))
        return; resizer.releasePointerCapture(event.pointerId); root.classList.remove("is-resizing"); persistUi(); };
    resizer.addEventListener("pointerup", stopResize);
    resizer.addEventListener("pointercancel", stopResize);
    const dropzone = root.querySelector(".pro-stash-dropzone");
    dropzone.addEventListener("dragover", (event) => { var _a; if ((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types.includes("text/plain")) {
        event.preventDefault();
        dropzone.classList.add("is-drag-over");
    } });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag-over"));
    dropzone.addEventListener("drop", (event) => { var _a; const text = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData("text/plain").trim(); dropzone.classList.remove("is-drag-over"); if (text) {
        event.preventDefault();
        add("text", text);
    } });
    applyUi();
    render();
    return { add };
};
