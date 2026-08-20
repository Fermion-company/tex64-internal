import { uiText } from "./i18n.js";
export const PRO_STASH_STORAGE_KEY = "tex64.proStash.v1";
export const PRO_STASH_MAX_BYTES = 8 * 1024 * 1024;
export const reorderStashItems = (items, from, to) => {
    const next = [...items];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to)
        return next;
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
};
// "Copy all" is plain text, so images have nothing to contribute: report how
// many were left out instead of pasting base64 blobs into someone's document.
export const stashClipboardText = (items) => {
    const texts = items.filter((item) => item.kind === "text");
    return { text: texts.map((item) => item.content).join("\n\n"), skipped: items.length - texts.length };
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
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => { var _a; return reject((_a = reader.error) !== null && _a !== void 0 ? _a : new Error("clipboard image could not be read")); };
    reader.readAsDataURL(blob);
});
const dataTransferImages = (data) => { var _a; return Array.from((_a = data === null || data === void 0 ? void 0 : data.files) !== null && _a !== void 0 ? _a : []).filter((file) => file.type.startsWith("image/")); };
export const initProStashUi = (deps) => {
    var _a, _b, _c, _d, _e;
    const bridge = window;
    const panel = document.querySelector('.panel[data-panel="stash"]');
    if (!panel)
        return { add: () => { } };
    let items = [];
    let result = null;
    try {
        const saved = JSON.parse(localStorage.getItem(PRO_STASH_STORAGE_KEY) || "[]");
        if (Array.isArray(saved))
            items = saved.filter((x) => x && (x.kind === "image" || x.kind === "text") && typeof x.content === "string");
    }
    catch { /* ignore corrupt storage */ }
    panel.innerHTML = `<div class="panel-header"><span class="panel-title">${uiText("Stash", "スタッシュ")}</span><div class="panel-header-actions"><span data-stash-count>0</span><button class="panel-button ghost" data-stash-clear type="button">${uiText("Clear", "全クリア")}</button></div></div><div class="panel-body pro-stash" tabindex="0"><div class="pro-stash-list"></div><div class="pro-stash-dropzone">${uiText("Drop or paste text and images here", "テキストや画像をここへドロップ / 貼り付け")}</div><div class="pro-stash-add"><button data-stash-selection type="button">${uiText("Add selection", "選択範囲を追加")}</button></div><textarea data-stash-instruction rows="3" placeholder="${uiText("Swap 1 and 2, shorten 5, remove 6", "1と2を入れ替え、5はもっと短く、6は丸々カット")}"></textarea><div class="pro-stash-actions"><button data-stash-ai type="button">${uiText("AI edit", "AI編集")}</button><span data-stash-status></span></div><div class="pro-stash-output" hidden><button data-stash-apply type="button">${uiText("Apply", "適用")}</button><button data-stash-discard type="button">${uiText("Discard", "破棄")}</button></div></div>`;
    const body = panel.querySelector(".pro-stash");
    const list = panel.querySelector(".pro-stash-list");
    const status = panel.querySelector("[data-stash-status]");
    const output = panel.querySelector(".pro-stash-output");
    const setStatus = (text) => { status.textContent = text; };
    const persist = () => localStorage.setItem(PRO_STASH_STORAGE_KEY, JSON.stringify(items));
    const copyItem = async (item) => {
        var _a;
        try {
            if (item.kind === "image" && typeof ClipboardItem !== "undefined" && ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.write)) {
                const blob = await (await fetch(item.content)).blob();
                await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
            }
            else
                await navigator.clipboard.writeText(item.content);
            setStatus(uiText("Copied.", "コピーしました。"));
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };
    const render = () => {
        const shown = result !== null && result !== void 0 ? result : items;
        panel.querySelector("[data-stash-count]").textContent = String(shown.length);
        body.classList.toggle("is-result", result !== null);
        output.hidden = result === null;
        list.replaceChildren(...shown.map((item, index) => {
            const row = document.createElement("article");
            row.className = "pro-stash-item";
            row.tabIndex = 0;
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
                var _a;
                var _b;
                if (event.target.closest("button"))
                    return;
                // A click that ends a text selection is someone copying, not someone
                // asking for the full fragment: re-rendering here would drop it.
                if (((_b = (_a = window.getSelection()) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : "").length > 0)
                    return;
                row.classList.toggle("is-expanded");
                if (preview instanceof HTMLPreElement)
                    preview.textContent = row.classList.contains("is-expanded") ? item.content : item.content.split("\n").slice(0, 3).join("\n");
            });
            row.addEventListener("keydown", (event) => {
                var _a;
                var _b;
                if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c")
                    return;
                if (((_b = (_a = window.getSelection()) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : "").length > 0)
                    return;
                event.preventDefault();
                void copyItem(item);
            });
            row.append(badge, preview);
            const controls = document.createElement("span");
            controls.className = "pro-stash-item-actions";
            const copy = document.createElement("button");
            copy.type = "button";
            copy.className = "is-copy";
            copy.textContent = "⧉";
            copy.title = uiText("Copy", "コピー");
            copy.onclick = () => { void copyItem(item); };
            controls.appendChild(copy);
            if (!result) {
                // The number badge is the drag handle so the fragment itself stays
                // selectable — a draggable row swallows text selection.
                badge.draggable = true;
                badge.title = uiText("Drag to reorder", "ドラッグで並べ替え");
                badge.addEventListener("dragstart", (event) => { var _a, _b; (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.setData("application/x-tex64-stash-index", String(index)); (_b = event.dataTransfer) === null || _b === void 0 ? void 0 : _b.setDragImage(row, 12, 12); row.classList.add("is-dragging"); });
                badge.addEventListener("dragend", () => row.classList.remove("is-dragging"));
                row.addEventListener("dragover", (event) => { var _a; if ((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types.includes("application/x-tex64-stash-index")) {
                    event.preventDefault();
                    row.classList.add("is-drag-over");
                } });
                row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
                row.addEventListener("drop", (event) => { var _a; const from = Number((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData("application/x-tex64-stash-index")); row.classList.remove("is-drag-over"); if (Number.isInteger(from)) {
                    event.preventDefault();
                    items = reorderStashItems(items, from, index);
                    persist();
                    render();
                } });
                [["↑", -1, "is-move-up"], ["↓", 1, "is-move-down"]].forEach(([label, delta, cls]) => { const button = document.createElement("button"); button.type = "button"; button.className = cls; button.textContent = String(label); button.disabled = index + Number(delta) < 0 || index + Number(delta) >= items.length; button.onclick = () => { const next = index + Number(delta); [items[index], items[next]] = [items[next], items[index]]; persist(); render(); }; controls.appendChild(button); });
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "is-remove";
                remove.textContent = "×";
                remove.title = uiText("Remove", "削除");
                remove.onclick = () => { items.splice(index, 1); persist(); render(); };
                controls.appendChild(remove);
            }
            row.appendChild(controls);
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
            setStatus(uiText(`${limited.removed.length} oldest item(s) removed (8 MB limit).`, `8MB制限のため古い項目を${limited.removed.length}件削除しました。`));
        persist();
        render();
    };
    window.addEventListener("tex64:pro-stash-add", (event) => {
        var _a;
        const detail = event.detail;
        if (!detail)
            return;
        add(detail.kind, detail.content);
        (_a = deps.revealStash) === null || _a === void 0 ? void 0 : _a.call(deps);
    });
    (_a = panel.querySelector("[data-stash-clear]")) === null || _a === void 0 ? void 0 : _a.addEventListener("click", () => { items = []; result = null; persist(); render(); });
    (_b = panel.querySelector("[data-stash-selection]")) === null || _b === void 0 ? void 0 : _b.addEventListener("click", () => {
        var _a, _b, _c, _d;
        const editor = deps.getActiveGroup().editor;
        const selection = (_a = editor === null || editor === void 0 ? void 0 : editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
        const text = selection ? (_d = (_c = (_b = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _b === void 0 ? void 0 : _b.call(editor)) === null || _c === void 0 ? void 0 : _c.getValueInRange) === null || _d === void 0 ? void 0 : _d.call(_c, selection) : "";
        if (text)
            add("text", text);
        else
            setStatus(uiText("Select text in the editor first.", "先にエディタでテキストを選択してください。"));
    });
    // Cmd+V anywhere in the tray stashes the clipboard; the instruction box keeps
    // its own native paste.
    body.addEventListener("paste", (event) => {
        var _a, _b;
        var _c;
        if ((_a = event.target) === null || _a === void 0 ? void 0 : _a.closest("textarea, input"))
            return;
        const images = dataTransferImages(event.clipboardData);
        const text = ((_c = (_b = event.clipboardData) === null || _b === void 0 ? void 0 : _b.getData("text/plain")) !== null && _c !== void 0 ? _c : "").trim();
        if (!images.length && !text)
            return;
        event.preventDefault();
        images.forEach((file) => { void blobToDataUrl(file).then((url) => add("image", url)); });
        if (text)
            add("text", text);
    });
    (_c = panel.querySelector("[data-stash-ai]")) === null || _c === void 0 ? void 0 : _c.addEventListener("click", async () => {
        const instruction = panel.querySelector("[data-stash-instruction]").value.trim();
        if (!items.length || !instruction) {
            setStatus(uiText("Add items and enter an instruction.", "項目を追加して指示を入力してください。"));
            return;
        }
        const button = panel.querySelector("[data-stash-ai]");
        button.disabled = true;
        try {
            result = await runStashAiEdit(items, instruction, {
                texize: async (base64) => { var _a, _b; const response = await ((_b = (_a = bridge.tex64Texize) === null || _a === void 0 ? void 0 : _a.snippet) === null || _b === void 0 ? void 0 : _b.call(_a, { imageBase64: base64 })); if (!(response === null || response === void 0 ? void 0 : response.ok))
                    throw new Error((response === null || response === void 0 ? void 0 : response.error) || "texize failed."); return response.tex || ""; },
                complete: async (prompt) => { var _a, _b; const response = await ((_b = (_a = bridge.tex64Ai) === null || _a === void 0 ? void 0 : _a.complete) === null || _b === void 0 ? void 0 : _b.call(_a, prompt)); if (!(response === null || response === void 0 ? void 0 : response.ok))
                    throw new Error((response === null || response === void 0 ? void 0 : response.error) || "AI edit failed."); return response.text || ""; },
                onConverting: (index) => { setStatus(uiText(`Converting image ${index + 1}…`, `画像${index + 1}をTeX化中…`)); },
            });
            setStatus(uiText("Review the result.", "結果を確認してください。"));
            render();
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
        finally {
            button.disabled = false;
        }
    });
    (_d = panel.querySelector("[data-stash-apply]")) === null || _d === void 0 ? void 0 : _d.addEventListener("click", () => { if (result) {
        items = result;
        result = null;
        persist();
        render();
    } });
    (_e = panel.querySelector("[data-stash-discard]")) === null || _e === void 0 ? void 0 : _e.addEventListener("click", () => { result = null; render(); });
    const dropzone = panel.querySelector(".pro-stash-dropzone");
    dropzone.addEventListener("dragover", (event) => {
        var _a;
        if (!((_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.types.some((type) => type === "text/plain" || type === "Files")))
            return;
        event.preventDefault();
        dropzone.classList.add("is-drag-over");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag-over"));
    dropzone.addEventListener("drop", (event) => {
        var _a;
        var _b;
        const images = dataTransferImages(event.dataTransfer);
        const text = ((_b = (_a = event.dataTransfer) === null || _a === void 0 ? void 0 : _a.getData("text/plain")) !== null && _b !== void 0 ? _b : "").trim();
        dropzone.classList.remove("is-drag-over");
        if (!images.length && !text)
            return;
        event.preventDefault();
        images.forEach((file) => { void blobToDataUrl(file).then((url) => add("image", url)); });
        if (text)
            add("text", text);
    });
    render();
    return { add };
};
