const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const selectionAutoScrollVelocity = (pointerY, bounds, lineHeight) => {
    if (!Number.isFinite(pointerY) ||
        !Number.isFinite(bounds.top) ||
        !Number.isFinite(bounds.bottom) ||
        bounds.bottom <= bounds.top ||
        !Number.isFinite(lineHeight) ||
        lineHeight <= 0) {
        return 0;
    }
    // Chromium cannot place the pointer below a maximized window. Start inside
    // the final line-and-a-half so selection still advances at the screen edge.
    const edge = clamp(lineHeight * 1.5, 24, 48);
    const topEdge = bounds.top + edge;
    const bottomEdge = bounds.bottom - edge;
    let direction = 0;
    let intensity = 0;
    if (pointerY < topEdge) {
        direction = -1;
        intensity = clamp((topEdge - pointerY) / edge, 0, 1);
    }
    else if (pointerY > bottomEdge) {
        direction = 1;
        intensity = clamp((pointerY - bottomEdge) / edge, 0, 1);
    }
    if (!direction || intensity <= 0) {
        return 0;
    }
    const linesPerSecond = 3 + 12 * intensity * intensity;
    return direction * lineHeight * linesPerSecond;
};
export const selectionAutoScrollDelta = (velocity, elapsedMs) => {
    if (!Number.isFinite(velocity) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
        return 0;
    }
    return velocity * clamp(elapsedMs, 0, 50) / 1000;
};
export const attachSelectionDragAutoScroll = (monaco, editor, host) => {
    var _a;
    let active = false;
    let pointerX = 0;
    let pointerY = 0;
    let frame = null;
    let previousFrameTime = 0;
    const stopFrame = () => {
        if (frame !== null) {
            window.cancelAnimationFrame(frame);
            frame = null;
        }
        previousFrameTime = 0;
    };
    const stop = () => {
        active = false;
        stopFrame();
    };
    const updateSelectionEnd = () => {
        var _a, _b, _c, _d, _e;
        const domNode = (_a = editor.getDomNode) === null || _a === void 0 ? void 0 : _a.call(editor);
        const selection = (_b = editor.getSelection) === null || _b === void 0 ? void 0 : _b.call(editor);
        if (!domNode || !selection || !editor.getTargetAtClientPoint || !(monaco === null || monaco === void 0 ? void 0 : monaco.Selection)) {
            return;
        }
        const rect = domNode.getBoundingClientRect();
        const layout = (_d = (_c = editor.getLayoutInfo) === null || _c === void 0 ? void 0 : _c.call(editor)) !== null && _d !== void 0 ? _d : {};
        const horizontalScrollbarHeight = Number(layout.horizontalScrollbarHeight) || 0;
        const contentLeft = rect.left + (Number(layout.contentLeft) || 0);
        const contentRight = contentLeft + (Number(layout.contentWidth) || rect.width);
        const target = editor.getTargetAtClientPoint(clamp(pointerX, contentLeft + 1, Math.max(contentLeft + 1, contentRight - 1)), clamp(pointerY, rect.top + 2, Math.max(rect.top + 2, rect.bottom - horizontalScrollbarHeight - 2)));
        const position = target === null || target === void 0 ? void 0 : target.position;
        if (!position) {
            return;
        }
        if (selection.positionLineNumber === position.lineNumber &&
            selection.positionColumn === position.column) {
            return;
        }
        (_e = editor.setSelection) === null || _e === void 0 ? void 0 : _e.call(editor, new monaco.Selection(selection.selectionStartLineNumber, selection.selectionStartColumn, position.lineNumber, position.column));
    };
    const tick = (time) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        frame = null;
        if (!active) {
            return;
        }
        const domNode = (_a = editor.getDomNode) === null || _a === void 0 ? void 0 : _a.call(editor);
        if (!domNode) {
            stop();
            return;
        }
        const rect = domNode.getBoundingClientRect();
        const lineHeight = Number((_b = editor.getOption) === null || _b === void 0 ? void 0 : _b.call(editor, (_d = (_c = monaco === null || monaco === void 0 ? void 0 : monaco.editor) === null || _c === void 0 ? void 0 : _c.EditorOption) === null || _d === void 0 ? void 0 : _d.lineHeight)) || 20;
        const velocity = selectionAutoScrollVelocity(pointerY, rect, lineHeight);
        if (velocity === 0) {
            previousFrameTime = 0;
            return;
        }
        const elapsed = previousFrameTime > 0 ? time - previousFrameTime : 1000 / 60;
        previousFrameTime = time;
        const scrollTop = Number((_e = editor.getScrollTop) === null || _e === void 0 ? void 0 : _e.call(editor)) || 0;
        (_f = editor.setScrollTop) === null || _f === void 0 ? void 0 : _f.call(editor, scrollTop + selectionAutoScrollDelta(velocity, elapsed), (_h = (_g = monaco === null || monaco === void 0 ? void 0 : monaco.editor) === null || _g === void 0 ? void 0 : _g.ScrollType) === null || _h === void 0 ? void 0 : _h.Immediate);
        updateSelectionEnd();
        frame = window.requestAnimationFrame(tick);
    };
    const ensureFrame = () => {
        if (active && frame === null) {
            frame = window.requestAnimationFrame(tick);
        }
    };
    const onMouseDown = (event) => {
        if (event.button !== 0) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (!(target === null || target === void 0 ? void 0 : target.closest(".view-lines"))) {
            return;
        }
        active = true;
        pointerX = event.clientX;
        pointerY = event.clientY;
        previousFrameTime = 0;
    };
    const onMouseMove = (event) => {
        if (!active) {
            return;
        }
        if (event.buttons === 0) {
            stop();
            return;
        }
        pointerX = event.clientX;
        pointerY = event.clientY;
        ensureFrame();
    };
    host.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", stop, true);
    window.addEventListener("blur", stop);
    const dispose = () => {
        stop();
        host.removeEventListener("mousedown", onMouseDown, true);
        window.removeEventListener("mousemove", onMouseMove, true);
        window.removeEventListener("mouseup", stop, true);
        window.removeEventListener("blur", stop);
    };
    (_a = editor.onDidDispose) === null || _a === void 0 ? void 0 : _a.call(editor, dispose);
    return dispose;
};
