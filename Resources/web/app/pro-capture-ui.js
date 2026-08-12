import { insertAtEditorCursor } from "./pro-editor-insert.js";
export const normalizeCaptureRect = (startX, startY, endX, endY) => ({
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
});
export const mapSelectionToImagePixels = (selection, imageBounds, naturalWidth, naturalHeight) => {
    if (naturalWidth <= 0 || naturalHeight <= 0 || imageBounds.width <= 0 || imageBounds.height <= 0)
        return null;
    const scale = Math.min(imageBounds.width / naturalWidth, imageBounds.height / naturalHeight);
    const shownWidth = naturalWidth * scale;
    const shownHeight = naturalHeight * scale;
    const shownX = imageBounds.x + (imageBounds.width - shownWidth) / 2;
    const shownY = imageBounds.y + (imageBounds.height - shownHeight) / 2;
    const left = Math.max(selection.x, shownX);
    const top = Math.max(selection.y, shownY);
    const right = Math.min(selection.x + selection.width, shownX + shownWidth);
    const bottom = Math.min(selection.y + selection.height, shownY + shownHeight);
    if (right <= left || bottom <= top)
        return null;
    return {
        x: Math.round((left - shownX) / scale),
        y: Math.round((top - shownY) / scale),
        width: Math.max(1, Math.round((right - left) / scale)),
        height: Math.max(1, Math.round((bottom - top) / scale)),
    };
};
export const chooseCaptureDirectory = (files) => {
    for (const dir of ["figures", "images", "assets"]) {
        if (files.some((file) => file === dir || file.startsWith(`${dir}/`)))
            return dir;
    }
    return "assets";
};
export const buildIncludeGraphicsSnippet = (path, figure) => {
    const command = `\\includegraphics[width=0.8\\linewidth]{${path}}`;
    return figure ? `\\begin{figure}[htbp]\n  \\centering\n  ${command}\n\\end{figure}\n` : `${command}\n`;
};
const dataUrlBase64 = (url) => url.slice(url.indexOf(",") + 1);
const timestampName = (now = new Date()) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `capture-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
};
export const initProCaptureUi = (deps) => {
    const bridgeWindow = window;
    let cleanup = null;
    const insertText = (text) => {
        insertAtEditorCursor(deps.getActiveGroup().editor, text, "pro-capture");
    };
    const capturePdf = (iframe, rect) => new Promise((resolve, reject) => {
        var _a;
        const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("PDF capture timed out.")); }, 10000);
        const receive = (event) => {
            var _a;
            if (event.source !== iframe.contentWindow || ((_a = event.data) === null || _a === void 0 ? void 0 : _a.source) !== "tex64-pdf")
                return;
            const payload = event.data.payload;
            if ((payload === null || payload === void 0 ? void 0 : payload.type) !== "capture-region-result" || payload.requestId !== requestId)
                return;
            clearTimeout(timer);
            window.removeEventListener("message", receive);
            if (payload.ok && payload.dataUrl)
                resolve(payload.dataUrl);
            else
                reject(new Error(payload.error || "The PDF region could not be captured."));
        };
        window.addEventListener("message", receive);
        (_a = iframe.contentWindow) === null || _a === void 0 ? void 0 : _a.postMessage({ source: "tex64-pdf", payload: { type: "capture-region", requestId, payload: rect } }, "*");
    });
    const captureImage = (image, rect, bodyRect) => {
        var _a;
        const imageRect = image.getBoundingClientRect();
        const pixels = mapSelectionToImagePixels(rect, {
            x: imageRect.left - bodyRect.left, y: imageRect.top - bodyRect.top,
            width: imageRect.width, height: imageRect.height,
        }, image.naturalWidth, image.naturalHeight);
        if (!pixels)
            throw new Error("The selection does not overlap the image.");
        const canvas = document.createElement("canvas");
        canvas.width = pixels.width;
        canvas.height = pixels.height;
        (_a = canvas.getContext("2d")) === null || _a === void 0 ? void 0 : _a.drawImage(image, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height);
        return canvas.toDataURL("image/png");
    };
    const begin = (kind) => {
        cleanup === null || cleanup === void 0 ? void 0 : cleanup();
        const pane = document.getElementById(`pro-${kind}-pane`);
        const body = pane === null || pane === void 0 ? void 0 : pane.querySelector(".pro-pane-body");
        if (!body)
            return;
        const overlay = document.createElement("div");
        overlay.className = "pro-capture-overlay";
        overlay.tabIndex = 0;
        overlay.innerHTML = '<div class="pro-capture-hint">Drag to select · Esc to cancel</div>';
        body.appendChild(overlay);
        overlay.focus();
        let start = null;
        let rect = null;
        let box = null;
        const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); if (cleanup === close)
            cleanup = null; };
        const onKey = (event) => { if (event.key === "Escape")
            close(); };
        document.addEventListener("keydown", onKey);
        cleanup = close;
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target.closest(".pro-capture-menu, .pro-capture-confirm"))
                return;
            const bounds = overlay.getBoundingClientRect();
            start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
            box === null || box === void 0 ? void 0 : box.remove();
            box = document.createElement("div");
            box.className = "pro-capture-selection";
            overlay.appendChild(box);
            overlay.setPointerCapture(event.pointerId);
        });
        overlay.addEventListener("pointermove", (event) => {
            if (!start || !box)
                return;
            const bounds = overlay.getBoundingClientRect();
            rect = normalizeCaptureRect(start.x, start.y, event.clientX - bounds.left, event.clientY - bounds.top);
            Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        });
        overlay.addEventListener("pointerup", (event) => {
            var _a;
            if (!start || !rect || rect.width < 4 || rect.height < 4) {
                start = null;
                return;
            }
            start = null;
            overlay.releasePointerCapture(event.pointerId);
            const menu = document.createElement("div");
            menu.className = "pro-capture-menu";
            menu.innerHTML = `<button data-action="tex">TeX化</button><span class="pro-capture-translate"><select aria-label="Translation language"><option>Japanese</option><option>English</option><option value="custom">Other…</option></select><input hidden placeholder="Language" /></span><button data-action="translate">翻訳して挿入</button><label><input type="checkbox" data-figure /> figure</label><button data-action="image">画像化して挿入</button><button data-action="stash">スタッシュへ</button><button data-action="copy">コピー(PNG)</button><span class="pro-capture-status"></span>`;
            Object.assign(menu.style, { left: `${Math.min(rect.x, Math.max(4, overlay.clientWidth - 300))}px`, top: `${Math.min(rect.y + rect.height + 6, Math.max(4, overlay.clientHeight - 120))}px` });
            (_a = overlay.querySelector(".pro-capture-menu")) === null || _a === void 0 ? void 0 : _a.remove();
            overlay.appendChild(menu);
            const select = menu.querySelector("select");
            const custom = menu.querySelector("input[placeholder=Language]");
            select.addEventListener("change", () => { custom.hidden = select.value !== "custom"; if (!custom.hidden)
                custom.focus(); });
            const status = menu.querySelector(".pro-capture-status");
            const getPng = async () => {
                const viewer = document.getElementById(`pro-${kind}-viewer`);
                const bodyRect = body.getBoundingClientRect();
                if ((viewer === null || viewer === void 0 ? void 0 : viewer.dataset.view) === "image")
                    return captureImage(document.getElementById(`pro-${kind}-image`), rect, bodyRect);
                if ((viewer === null || viewer === void 0 ? void 0 : viewer.dataset.view) === "pdf") {
                    const iframe = document.getElementById(`pro-${kind}-pdf`);
                    const iframeRect = iframe.getBoundingClientRect();
                    return capturePdf(iframe, { x: rect.x - (iframeRect.left - bodyRect.left), y: rect.y - (iframeRect.top - bodyRect.top), width: rect.width, height: rect.height });
                }
                throw new Error("Open an image or PDF before selecting a region.");
            };
            const showTex = (tex) => {
                menu.remove();
                const confirm = document.createElement("div");
                confirm.className = "pro-capture-confirm";
                const textarea = document.createElement("textarea");
                textarea.value = tex;
                textarea.rows = 7;
                const insert = document.createElement("button");
                insert.textContent = "カーソル位置に挿入";
                insert.addEventListener("click", () => { try {
                    insertText(textarea.value);
                    close();
                }
                catch (error) {
                    confirm.dataset.error = error instanceof Error ? error.message : String(error);
                } });
                const stash = document.createElement("button");
                stash.textContent = "スタッシュへ";
                stash.addEventListener("click", () => { window.dispatchEvent(new CustomEvent("tex64:pro-stash-add", { detail: { kind: "text", content: textarea.value } })); close(); });
                confirm.append(textarea, insert, stash);
                overlay.appendChild(confirm);
                Object.assign(confirm.style, { left: menu.style.left, top: menu.style.top });
            };
            menu.addEventListener("click", async (click) => {
                var _a, _b, _c;
                const action = (_a = click.target.closest("button")) === null || _a === void 0 ? void 0 : _a.dataset.action;
                if (!action)
                    return;
                try {
                    status.classList.add("is-loading");
                    status.textContent = "処理中…";
                    const png = await getPng();
                    if (action === "copy") {
                        const blob = await (await fetch(png)).blob();
                        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                        status.textContent = "コピーしました";
                        return;
                    }
                    if (action === "stash") {
                        window.dispatchEvent(new CustomEvent("tex64:pro-stash-add", { detail: { kind: "image", content: png } }));
                        close();
                        return;
                    }
                    if (action === "image") {
                        const api = (_b = bridgeWindow.tex64Files) === null || _b === void 0 ? void 0 : _b.writeBase64;
                        if (!api)
                            throw new Error("File writing is not available.");
                        const dir = chooseCaptureDirectory(deps.getWorkspaceFiles());
                        const path = `${dir}/${timestampName()}`;
                        const result = await api({ path, data: dataUrlBase64(png) });
                        if (!result.ok)
                            throw new Error(result.error || "The image could not be saved.");
                        insertText(buildIncludeGraphicsSnippet(path, menu.querySelector("[data-figure]").checked));
                        close();
                        return;
                    }
                    const snippet = (_c = bridgeWindow.tex64Texize) === null || _c === void 0 ? void 0 : _c.snippet;
                    if (!snippet)
                        throw new Error("texize is not available.");
                    const translate = action === "translate" ? (select.value === "custom" ? custom.value.trim() : select.value) : undefined;
                    if (action === "translate" && !translate)
                        throw new Error("Enter a translation language.");
                    const result = await snippet({ imageBase64: dataUrlBase64(png), ...(translate ? { translate } : {}) });
                    if (!result.ok)
                        throw new Error(result.error || "texize failed.");
                    showTex(result.tex || "");
                }
                catch (error) {
                    status.textContent = error instanceof Error ? error.message : String(error);
                    status.classList.add("is-error");
                }
                finally {
                    status.classList.remove("is-loading");
                }
            });
        });
    };
    document.querySelectorAll("[data-pro-capture]").forEach((button) => button.addEventListener("click", () => begin(button.dataset.proCapture)));
    return { cancel: () => cleanup === null || cleanup === void 0 ? void 0 : cleanup() };
};
