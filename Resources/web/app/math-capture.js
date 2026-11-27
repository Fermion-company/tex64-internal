export const initMathCapture = (context, deps) => {
    const { mathCaptureCropCanvas, mathCaptureCropSelection, mathCaptureCropGuide, mathCaptureCropImage, mathCaptureCropSize, } = context.dom;
    const getCaptureApi = () => {
        var _a, _b;
        const bridgeWindow = context.bridgeWindow;
        return (_b = (_a = bridgeWindow.__tex64TestCaptureApi) !== null && _a !== void 0 ? _a : bridgeWindow.tex64Capture) !== null && _b !== void 0 ? _b : null;
    };
    let sources = [];
    let selectedSource = null;
    let captureVersion = 0;
    let recognition = null;
    const cancelRecognition = () => {
        if (!recognition)
            return;
        recognition.abort();
        recognition = null;
        deps.captureUi.setCropBusy(false);
    };
    let dragStart = { x: 0, y: 0 };
    let selection = { x: 0, y: 0, width: 0, height: 0 };
    const captureIssueMessages = new Set([
        "Screen capture is not available.",
        "Screen capture is not available. Please confirm permission for screen recording.",
        "Failed to get window list.",
        "Failed to get window list. Please confirm permission for screen recording.",
        "There are no retrievable windows. Please confirm permission for screen recording.",
        "Failed to obtain thumbnail of selected screen. Please select another screen.",
        "Cutting failed.",
    ]);
    const clearCaptureIssues = () => {
        if (!deps.getCurrentIssues)
            return;
        const current = deps.getCurrentIssues();
        if (current.length === 0)
            return;
        const isCaptureOnly = current.every((issue) => captureIssueMessages.has(issue.message));
        if (!isCaptureOnly)
            return;
        deps.updateIssues(0, "", "info", []);
    };
    const setStatus = (message) => {
        var _a;
        (_a = deps.setStatus) === null || _a === void 0 ? void 0 : _a.call(deps, message);
    };
    const resolveImageGeometry = () => {
        if (!(mathCaptureCropCanvas instanceof HTMLElement))
            return null;
        if (!(mathCaptureCropImage instanceof HTMLImageElement))
            return null;
        const rect = mathCaptureCropCanvas.getBoundingClientRect();
        const { naturalWidth, naturalHeight } = mathCaptureCropImage;
        if (!rect.width || !rect.height || !naturalWidth || !naturalHeight)
            return null;
        const canvasWidth = rect.width;
        const canvasHeight = rect.height;
        const imageAspect = naturalWidth / naturalHeight;
        const canvasAspect = canvasWidth / canvasHeight;
        let displayWidth = canvasWidth;
        let displayHeight = canvasHeight;
        let offsetX = 0;
        let offsetY = 0;
        if (imageAspect > canvasAspect) {
            displayWidth = canvasWidth;
            displayHeight = canvasWidth / imageAspect;
            offsetY = (canvasHeight - displayHeight) / 2;
        }
        else {
            displayHeight = canvasHeight;
            displayWidth = canvasHeight * imageAspect;
            offsetX = (canvasWidth - displayWidth) / 2;
        }
        return {
            rect,
            offsetX,
            offsetY,
            displayWidth,
            displayHeight,
            naturalWidth,
            naturalHeight,
        };
    };
    const clampSelection = (next) => {
        const geometry = resolveImageGeometry();
        if (!geometry)
            return next;
        const { offsetX, offsetY, displayWidth, displayHeight } = geometry;
        const x = Math.max(offsetX, Math.min(next.x, offsetX + displayWidth));
        const y = Math.max(offsetY, Math.min(next.y, offsetY + displayHeight));
        const maxWidth = offsetX + displayWidth - x;
        const maxHeight = offsetY + displayHeight - y;
        return {
            x,
            y,
            width: Math.max(0, Math.min(next.width, maxWidth)),
            height: Math.max(0, Math.min(next.height, maxHeight)),
        };
    };
    const updateSelectionUi = () => {
        if (!(mathCaptureCropSelection instanceof HTMLElement))
            return;
        if (!(mathCaptureCropGuide instanceof HTMLElement))
            return;
        if (selection.width < 2 || selection.height < 2) {
            mathCaptureCropSelection.style.display = "none";
            mathCaptureCropGuide.style.display = "none";
            if (mathCaptureCropSize && mathCaptureCropImage instanceof HTMLImageElement && mathCaptureCropImage.complete && mathCaptureCropImage.naturalWidth) {
                mathCaptureCropSize.textContent = `${mathCaptureCropImage.naturalWidth} × ${mathCaptureCropImage.naturalHeight}`;
            }
            return;
        }
        mathCaptureCropSelection.style.display = "block";
        mathCaptureCropGuide.style.display = "block";
        mathCaptureCropSelection.style.left = `${selection.x}px`;
        mathCaptureCropSelection.style.top = `${selection.y}px`;
        mathCaptureCropSelection.style.width = `${selection.width}px`;
        mathCaptureCropSelection.style.height = `${selection.height}px`;
        mathCaptureCropGuide.style.left = `${selection.x}px`;
        mathCaptureCropGuide.style.top = `${selection.y}px`;
        mathCaptureCropGuide.style.width = `${selection.width}px`;
        mathCaptureCropGuide.style.height = `${selection.height}px`;
        const geometry = resolveImageGeometry();
        if (!geometry || !(mathCaptureCropSize instanceof HTMLElement))
            return;
        const { displayWidth, displayHeight, naturalWidth, naturalHeight } = geometry;
        const scaleX = naturalWidth / displayWidth;
        const scaleY = naturalHeight / displayHeight;
        const cropWidth = Math.max(0, Math.round(selection.width * scaleX));
        const cropHeight = Math.max(0, Math.round(selection.height * scaleY));
        mathCaptureCropSize.textContent = `${cropWidth} × ${cropHeight}`;
    };
    const resetSelection = () => {
        // Start with no selection as requested by user
        selection = { x: 0, y: 0, width: 0, height: 0 };
        updateSelectionUi();
    };
    const toImageCrop = () => {
        if (!(mathCaptureCropImage instanceof HTMLImageElement))
            return null;
        const geometry = resolveImageGeometry();
        if (!geometry)
            return null;
        const { offsetX, offsetY, displayWidth, displayHeight, naturalWidth, naturalHeight } = geometry;
        if (selection.width < 2 || selection.height < 2) {
            return { x: 0, y: 0, width: naturalWidth, height: naturalHeight, naturalWidth, naturalHeight };
        }
        const scaleX = naturalWidth / displayWidth;
        const scaleY = naturalHeight / displayHeight;
        const x = Math.max(0, Math.round((selection.x - offsetX) * scaleX));
        const y = Math.max(0, Math.round((selection.y - offsetY) * scaleY));
        const width = Math.max(1, Math.round(selection.width * scaleX));
        const height = Math.max(1, Math.round(selection.height * scaleY));
        return { x, y, width, height, naturalWidth, naturalHeight };
    };
    const cropToDataUrl = () => {
        if (!(mathCaptureCropImage instanceof HTMLImageElement))
            return null;
        const crop = toImageCrop();
        if (!crop)
            return null;
        const canvas = document.createElement("canvas");
        const width = crop.width || crop.naturalWidth;
        const height = crop.height || crop.naturalHeight;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return null;
        ctx.drawImage(mathCaptureCropImage, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
        return canvas.toDataURL("image/png");
    };
    const isPermissionDenied = (status) => status === "denied" || status === "restricted";
    const showPermissionGuideIfNeeded = async (version) => {
        const captureApi = getCaptureApi();
        if (!(captureApi === null || captureApi === void 0 ? void 0 : captureApi.checkPermission)) {
            // No permission API available (non-macOS or older Electron) — skip
            return false;
        }
        const status = await captureApi.checkPermission().catch(() => "unknown");
        if (version !== captureVersion)
            return true;
        if (isPermissionDenied(status)) {
            deps.captureUi.showPermissionGuide();
            return true;
        }
        return false;
    };
    const fetchSources = async (version) => {
        const captureApi = getCaptureApi();
        if (!(captureApi === null || captureApi === void 0 ? void 0 : captureApi.listSources)) {
            setStatus("Screen capture is not available. Please confirm permission for screen recording.");
            return false;
        }
        try {
            const listed = await captureApi.listSources({
                thumbnailSize: { width: 480, height: 270 },
            });
            if (version !== captureVersion)
                return false;
            sources = listed;
        }
        catch {
            // List failed — check if it's a permission issue
            const guided = await showPermissionGuideIfNeeded(version);
            if (!guided && version === captureVersion) {
                setStatus("Failed to get window list. Please confirm permission for screen recording.");
            }
            return false;
        }
        if (sources.length === 0) {
            // Empty sources — likely permission denied (macOS returns [] when denied)
            const guided = await showPermissionGuideIfNeeded(version);
            if (!guided && version === captureVersion) {
                setStatus("There are no retrievable windows. Please confirm permission for screen recording.");
            }
            return false;
        }
        return true;
    };
    const openCapture = async () => {
        var _a;
        cancelRecognition();
        const version = ++captureVersion;
        clearCaptureIssues();
        // Pre-check permission before attempting to list sources
        const permissionBlocked = await showPermissionGuideIfNeeded(version);
        if (permissionBlocked || version !== captureVersion) {
            return;
        }
        const ok = await fetchSources(version);
        if (!ok || version !== captureVersion) {
            return;
        }
        deps.captureUi.openWindowPicker(sources, (_a = selectedSource === null || selectedSource === void 0 ? void 0 : selectedSource.id) !== null && _a !== void 0 ? _a : null);
    };
    deps.captureUi.setHandlers({
        onPermissionOpenSettings: () => {
            var _a;
            const captureApi = getCaptureApi();
            (_a = captureApi === null || captureApi === void 0 ? void 0 : captureApi.openPermissionSettings) === null || _a === void 0 ? void 0 : _a.call(captureApi);
        },
        onPermissionRetry: () => {
            // Re-attempt the capture flow after user grants permission
            openCapture();
        },
        onWindowSelect: async (id) => {
            var _a, _b;
            const version = ++captureVersion;
            selectedSource = (_a = sources.find((source) => source.id === id)) !== null && _a !== void 0 ? _a : null;
            if (!selectedSource)
                return;
            const captureApi = getCaptureApi();
            const hasPreview = Boolean(selectedSource.thumbnailUrl);
            if (!hasPreview) {
                // An enumerated window can have no list thumbnail and still be capturable.
                const image = await ((_b = captureApi === null || captureApi === void 0 ? void 0 : captureApi.captureHighRes) === null || _b === void 0 ? void 0 : _b.call(captureApi, id).catch(() => null));
                if (captureVersion !== version)
                    return;
                if (!(image === null || image === void 0 ? void 0 : image.thumbnailUrl)) {
                    setStatus("Failed to obtain thumbnail of selected screen. Please select another screen.");
                    return;
                }
                selectedSource = { ...selectedSource, ...image };
            }
            deps.captureUi.closeWindowPicker();
            // Show cropper immediately with picker thumbnail, then upgrade to high-res
            const { thumbnailUrl: imageUrl, width: sizeWidth, height: sizeHeight } = selectedSource;
            cachedGeometry = null;
            deps.captureUi.openCropper({
                imageUrl,
                sizeLabel: sizeWidth && sizeHeight
                    ? `${sizeWidth} × ${sizeHeight}`
                    : "Selected",
            });
            if (mathCaptureCropImage instanceof HTMLImageElement) {
                mathCaptureCropImage.onload = () => {
                    cacheGeometry();
                    resetSelection();
                };
            }
            resetSelection();
            // Upgrade to high-res capture in background
            if (hasPreview && (captureApi === null || captureApi === void 0 ? void 0 : captureApi.captureHighRes)) {
                try {
                    const hiRes = await captureApi.captureHighRes(id);
                    if (captureVersion !== version)
                        return;
                    if ((hiRes === null || hiRes === void 0 ? void 0 : hiRes.thumbnailUrl) && mathCaptureCropImage instanceof HTMLImageElement) {
                        mathCaptureCropImage.onload = () => {
                            cacheGeometry();
                            // Preserve existing selection after image swap
                            updateSelectionUi();
                        };
                        mathCaptureCropImage.src = hiRes.thumbnailUrl;
                        if (selectedSource) {
                            selectedSource.width = hiRes.width;
                            selectedSource.height = hiRes.height;
                        }
                    }
                }
                catch {
                    // High-res failed — keep using picker thumbnail, which is fine
                }
            }
        },
        onWindowCancel: () => {
            captureVersion++;
            selectedSource = null;
        },
        onCropRetry: () => {
            var _a;
            cancelRecognition();
            captureVersion++;
            deps.captureUi.openWindowPicker(sources, (_a = selectedSource === null || selectedSource === void 0 ? void 0 : selectedSource.id) !== null && _a !== void 0 ? _a : null);
        },
        onCropCancel: () => {
            cancelRecognition();
            // User requested: "Esc cancels current crop, but screen shouldn't close"
            if (selection.width > 0 || selection.height > 0) {
                resetSelection();
            }
        },
        onCropApply: async () => {
            var _a;
            if (recognition)
                return;
            const dataUrl = cropToDataUrl();
            if (!dataUrl) {
                setStatus("Cutting failed.");
                return;
            }
            const request = new AbortController();
            recognition = request;
            deps.captureUi.setCropBusy(true, "Recognizing…");
            try {
                const result = await deps.onCaptureImage(dataUrl, (current, total) => {
                    if (!request.signal.aborted)
                        deps.captureUi.setCropBusy(true, `Recognizing… (${current}/${total})`);
                }, request.signal);
                if (request.signal.aborted)
                    return;
                if (result.ok) {
                    captureVersion++;
                    deps.captureUi.closeCropper();
                }
                else {
                    // Show error, let user retry with adjusted selection
                    deps.captureUi.setCropError((_a = result.error) !== null && _a !== void 0 ? _a : "Recognition failed");
                }
            }
            catch {
                if (!request.signal.aborted)
                    deps.captureUi.setCropError("Recognition failed");
            }
            finally {
                if (recognition === request) {
                    recognition = null;
                    deps.captureUi.setCropBusy(false);
                }
            }
        },
    });
    let interactionMode = "idle";
    let resizeHandle = "";
    let startSelection = { x: 0, y: 0, width: 0, height: 0 };
    let cachedGeometry = null;
    let rafPending = false;
    const cacheGeometry = () => {
        const next = resolveImageGeometry();
        if (!next)
            return;
        const old = cachedGeometry;
        cachedGeometry = next;
        if (!old || (old.displayWidth === next.displayWidth && old.displayHeight === next.displayHeight
            && old.offsetX === next.offsetX && old.offsetY === next.offsetY))
            return;
        // Keep the selected pixels when the window or preview changes size.
        const scaleX = next.displayWidth / old.displayWidth;
        const scaleY = next.displayHeight / old.displayHeight;
        const position = (point) => ({
            x: next.offsetX + (point.x - old.offsetX) * scaleX,
            y: next.offsetY + (point.y - old.offsetY) * scaleY,
        });
        const rectangle = (area) => ({
            ...position(area), width: area.width * scaleX, height: area.height * scaleY,
        });
        selection = rectangle(selection);
        if (interactionMode !== "idle") {
            startSelection = rectangle(startSelection);
            dragStart = position(dragStart);
        }
    };
    const stopInteraction = (pointerId) => {
        if (!(mathCaptureCropCanvas instanceof HTMLElement)) {
            return;
        }
        interactionMode = "idle";
        resizeHandle = "";
        mathCaptureCropCanvas.style.cursor = "crosshair";
        if (Number.isFinite(pointerId) &&
            mathCaptureCropCanvas.hasPointerCapture(pointerId)) {
            try {
                mathCaptureCropCanvas.releasePointerCapture(pointerId);
            }
            catch {
                // ignore release failures on canceled pointers
            }
        }
        updateSelectionUi();
    };
    if (mathCaptureCropCanvas instanceof HTMLElement) {
        new ResizeObserver(() => {
            var _a;
            if (!((_a = context.dom.mathCaptureCropModal) === null || _a === void 0 ? void 0 : _a.classList.contains("is-open")))
                return;
            cacheGeometry();
            updateSelectionUi();
        }).observe(mathCaptureCropCanvas);
        mathCaptureCropCanvas.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) {
                return;
            }
            cacheGeometry();
            if (!cachedGeometry)
                return;
            const target = event.target;
            const rect = cachedGeometry.rect;
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            dragStart = { x, y };
            startSelection = { ...selection };
            try {
                mathCaptureCropCanvas.setPointerCapture(event.pointerId);
            }
            catch {
                // ignore capture failures for unsupported pointer sequences
            }
            // Check handle resize
            if (target.classList.contains("capture-crop-handle")) {
                interactionMode = "resize";
                if (target.classList.contains("tl"))
                    resizeHandle = "tl";
                else if (target.classList.contains("tr"))
                    resizeHandle = "tr";
                else if (target.classList.contains("bl"))
                    resizeHandle = "bl";
                else if (target.classList.contains("br"))
                    resizeHandle = "br";
                return;
            }
            // Check moving (if clicking strictly inside selection)
            // We use a small buffer or check if target is selection/guide
            if ((target === mathCaptureCropSelection || (mathCaptureCropSelection === null || mathCaptureCropSelection === void 0 ? void 0 : mathCaptureCropSelection.contains(target))) &&
                !target.classList.contains("capture-crop-handle")) {
                interactionMode = "move";
                return;
            }
            // Otherwise create new selection
            interactionMode = "create";
            selection = clampSelection({ x, y, width: 0, height: 0 });
            updateSelectionUi();
        });
        mathCaptureCropCanvas.addEventListener("pointermove", (event) => {
            if (!cachedGeometry)
                return;
            const rect = cachedGeometry.rect;
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            // Update cursor when idle (no RAF needed)
            if (interactionMode === "idle") {
                const target = event.target;
                if (target.classList.contains("capture-crop-handle")) {
                    // let CSS handle it
                }
                else if (target === mathCaptureCropSelection ||
                    ((mathCaptureCropSelection === null || mathCaptureCropSelection === void 0 ? void 0 : mathCaptureCropSelection.contains(target)) &&
                        !target.classList.contains("capture-crop-handle"))) {
                    mathCaptureCropCanvas.style.cursor = "move";
                }
                else {
                    mathCaptureCropCanvas.style.cursor = "crosshair";
                }
                return;
            }
            const dx = x - dragStart.x;
            const dy = y - dragStart.y;
            const { offsetX, offsetY, displayWidth, displayHeight } = cachedGeometry;
            if (interactionMode === "move") {
                let nextX = startSelection.x + dx;
                let nextY = startSelection.y + dy;
                nextX = Math.max(offsetX, Math.min(nextX, offsetX + displayWidth - startSelection.width));
                nextY = Math.max(offsetY, Math.min(nextY, offsetY + displayHeight - startSelection.height));
                selection = { ...startSelection, x: nextX, y: nextY };
            }
            else if (interactionMode === "resize") {
                const next = { ...startSelection };
                if (resizeHandle.includes("l")) {
                    next.x = Math.min(startSelection.x + startSelection.width, Math.max(offsetX, startSelection.x + dx));
                    next.width = startSelection.width + (startSelection.x - next.x);
                }
                if (resizeHandle.includes("r")) {
                    next.width = Math.min(offsetX + displayWidth - startSelection.x, Math.max(0, startSelection.width + dx));
                }
                if (resizeHandle.includes("t")) {
                    next.y = Math.min(startSelection.y + startSelection.height, Math.max(offsetY, startSelection.y + dy));
                    next.height = startSelection.height + (startSelection.y - next.y);
                }
                if (resizeHandle.includes("b")) {
                    next.height = Math.min(offsetY + displayHeight - startSelection.y, Math.max(0, startSelection.height + dy));
                }
                selection = { x: next.x, y: next.y, width: next.width, height: next.height };
            }
            else if (interactionMode === "create") {
                selection = clampSelection({
                    x: Math.min(dragStart.x, x),
                    y: Math.min(dragStart.y, y),
                    width: Math.abs(x - dragStart.x),
                    height: Math.abs(y - dragStart.y),
                });
            }
            // Batch DOM writes with requestAnimationFrame
            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    updateSelectionUi();
                });
            }
        });
        mathCaptureCropCanvas.addEventListener("pointerup", (event) => {
            if (interactionMode === "idle")
                return;
            stopInteraction(event.pointerId);
        });
        mathCaptureCropCanvas.addEventListener("pointercancel", (event) => {
            stopInteraction(event.pointerId);
        });
        mathCaptureCropCanvas.addEventListener("lostpointercapture", (event) => {
            const pointerEvent = event instanceof PointerEvent
                ? event
                : null;
            stopInteraction(pointerEvent === null || pointerEvent === void 0 ? void 0 : pointerEvent.pointerId);
        });
    }
    return { openCapture };
};
