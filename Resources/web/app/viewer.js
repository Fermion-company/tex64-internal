import { IMAGE_MIME_TYPES, getFileExtension } from "./files.js";
export const createViewer = (deps) => {
    let viewerBlobUrl = null;
    let viewerMode = "hidden";
    const clearViewerUrl = () => {
        if (viewerBlobUrl) {
            URL.revokeObjectURL(viewerBlobUrl);
            viewerBlobUrl = null;
        }
    };
    const setViewerMode = (mode) => {
        viewerMode = mode;
        if (deps.editorViewer instanceof HTMLElement) {
            deps.editorViewer.dataset.view = mode;
            const isVisible = mode !== "hidden";
            deps.editorViewer.classList.toggle("is-visible", isVisible);
            deps.editorViewer.setAttribute("aria-hidden", isVisible ? "false" : "true");
        }
        if (deps.editorHost instanceof HTMLElement) {
            deps.editorHost.classList.toggle("is-hidden", mode !== "hidden");
        }
    };
    const blurActiveElement = () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
            active.blur();
        }
    };
    const buildViewerBlobUrl = (data, mimeType) => {
        clearViewerUrl();
        const binary = window.atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });
        viewerBlobUrl = URL.createObjectURL(blob);
        return viewerBlobUrl;
    };
    const hideViewer = () => {
        clearViewerUrl();
        if (deps.editorViewerImage instanceof HTMLImageElement) {
            deps.editorViewerImage.removeAttribute("src");
        }
        if (deps.editorViewerPdf instanceof HTMLIFrameElement) {
            deps.editorViewerPdf.removeAttribute("src");
        }
        setViewerMode("hidden");
    };
    const showUnsupportedViewer = () => {
        clearViewerUrl();
        if (deps.editorViewerImage instanceof HTMLImageElement) {
            deps.editorViewerImage.removeAttribute("src");
        }
        if (deps.editorViewerPdf instanceof HTMLIFrameElement) {
            deps.editorViewerPdf.removeAttribute("src");
        }
        setViewerMode("unsupported");
        blurActiveElement();
    };
    const showImageViewer = (path, data, mimeType) => {
        var _a;
        if (!data || !(deps.editorViewerImage instanceof HTMLImageElement)) {
            showUnsupportedViewer();
            return;
        }
        const resolvedMime = (_a = mimeType !== null && mimeType !== void 0 ? mimeType : IMAGE_MIME_TYPES.get(getFileExtension(path))) !== null && _a !== void 0 ? _a : "image/*";
        try {
            const url = buildViewerBlobUrl(data, resolvedMime);
            deps.editorViewerImage.src = url;
            setViewerMode("image");
            blurActiveElement();
        }
        catch {
            showUnsupportedViewer();
        }
    };
    const showPdfViewer = (data, mimeType) => {
        if (!data || !(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            showUnsupportedViewer();
            return;
        }
        try {
            const url = buildViewerBlobUrl(data, mimeType !== null && mimeType !== void 0 ? mimeType : "application/pdf");
            deps.editorViewerPdf.src = url;
            setViewerMode("pdf");
            blurActiveElement();
        }
        catch {
            showUnsupportedViewer();
        }
    };
    return {
        hideViewer,
        showImageViewer,
        showPdfViewer,
        showUnsupportedViewer,
        setViewerMode,
        getViewerMode: () => viewerMode,
    };
};
