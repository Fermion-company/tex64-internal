import type { AppContext } from "./context.js";
import type { IssuesStatus, IssueItem } from "./types.js";
import type { MathCaptureUiApi, MathCaptureWindowSource } from "./math-capture-ui.js";

type MathCaptureDeps = {
  captureUi: MathCaptureUiApi;
  onCaptureImage: (imageDataUrl: string) => void;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  getCurrentIssues?: () => IssueItem[];
  setStatus?: (message: string) => void;
};

export type MathCaptureApi = {
  openCapture: () => void;
};

type CaptureSourceWithSize = MathCaptureWindowSource & {
  width?: number;
  height?: number;
};

export const initMathCapture = (
  context: AppContext,
  deps: MathCaptureDeps
): MathCaptureApi => {
  const {
    mathCaptureCropCanvas,
    mathCaptureCropSelection,
    mathCaptureCropGuide,
    mathCaptureCropImage,
    mathCaptureCropSize,
  } = context.dom;

  const getCaptureApi = () =>
    (context.bridgeWindow as {
      tex64Capture?: {
        listSources?: (options?: {
          thumbnailSize?: { width: number; height: number };
        }) => Promise<CaptureSourceWithSize[]>;
      };
    }).tex64Capture ?? null;

  let sources: CaptureSourceWithSize[] = [];
  let selectedSource: CaptureSourceWithSize | null = null;
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };
  let selection = { x: 0, y: 0, width: 0, height: 0 };

  const captureIssueMessages = new Set([
    "画面キャプチャが利用できません。",
    "画面キャプチャが利用できません。画面収録の許可を確認してください。",
    "ウィンドウ一覧の取得に失敗しました。",
    "ウィンドウ一覧の取得に失敗しました。画面収録の許可を確認してください。",
    "取り込み可能なウィンドウがありません。画面収録の許可を確認してください。",
    "切り取りに失敗しました。",
  ]);

  const clearCaptureIssues = () => {
    if (!deps.getCurrentIssues) return;
    const current = deps.getCurrentIssues();
    if (current.length === 0) return;
    const isCaptureOnly = current.every((issue) => captureIssueMessages.has(issue.message));
    if (!isCaptureOnly) return;
    deps.updateIssues(0, "", "info", []);
  };

  const setStatus = (message: string) => {
    deps.setStatus?.(message);
  };

  const resolveImageGeometry = () => {
    if (!(mathCaptureCropCanvas instanceof HTMLElement)) return null;
    if (!(mathCaptureCropImage instanceof HTMLImageElement)) return null;
    const rect = mathCaptureCropCanvas.getBoundingClientRect();
    const naturalWidth = mathCaptureCropImage.naturalWidth || 1;
    const naturalHeight = mathCaptureCropImage.naturalHeight || 1;
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
    } else {
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

  const clampSelection = (next: typeof selection) => {
    const geometry = resolveImageGeometry();
    if (!geometry) return next;
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
    if (!(mathCaptureCropSelection instanceof HTMLElement)) return;
    if (!(mathCaptureCropGuide instanceof HTMLElement)) return;
    
    if (selection.width < 2 || selection.height < 2) {
      mathCaptureCropSelection.style.display = "none";
      mathCaptureCropGuide.style.display = "none";
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
    if (!geometry || !(mathCaptureCropSize instanceof HTMLElement)) return;
    const { offsetX, offsetY, displayWidth, displayHeight, naturalWidth, naturalHeight } =
      geometry;
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
    if (!(mathCaptureCropImage instanceof HTMLImageElement)) return null;
    const geometry = resolveImageGeometry();
    if (!geometry) return null;
    const { offsetX, offsetY, displayWidth, displayHeight, naturalWidth, naturalHeight } =
      geometry;
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
    if (!(mathCaptureCropImage instanceof HTMLImageElement)) return null;
    const crop = toImageCrop();
    if (!crop) return null;
    const canvas = document.createElement("canvas");
    const width = crop.width || crop.naturalWidth;
    const height = crop.height || crop.naturalHeight;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(
      mathCaptureCropImage,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      width,
      height
    );
    return canvas.toDataURL("image/png");
  };

  const openCapture = async () => {
    clearCaptureIssues();
    const captureApi = getCaptureApi();
    if (!captureApi?.listSources) {
      setStatus("画面キャプチャが利用できません。画面収録の許可を確認してください。");
      return;
    }
    try {
      sources = await captureApi.listSources({
        thumbnailSize: { width: 3840, height: 2160 },
      });
    } catch (error) {
      setStatus("ウィンドウ一覧の取得に失敗しました。画面収録の許可を確認してください。");
      return;
    }
    if (sources.length === 0) {
      setStatus("取り込み可能なウィンドウがありません。画面収録の許可を確認してください。");
      return;
    }
    deps.captureUi.openWindowPicker(sources, selectedSource?.id ?? null);
  };

  deps.captureUi.setHandlers({
    onWindowSelect: (id) => {
      selectedSource = sources.find((source) => source.id === id) ?? null;
      if (!selectedSource) return;
      deps.captureUi.closeWindowPicker();
      deps.captureUi.openCropper({
        imageUrl: selectedSource.thumbnailUrl,
        sizeLabel: selectedSource.width && selectedSource.height
          ? `${selectedSource.width} × ${selectedSource.height}`
          : "選択中",
      });
      if (mathCaptureCropImage instanceof HTMLImageElement) {
        mathCaptureCropImage.onload = () => {
          resetSelection();
        };
      }
      resetSelection();
    },
    onWindowCancel: () => {
      selectedSource = null;
    },
    onCropRetry: () => {
      // User requested: "Back" closes entire flow, not return to picker
      deps.captureUi.closeCropper();
    },
    onCropCancel: () => {
      // User requested: "Esc cancels current crop, but screen shouldn't close"
      if (selection.width > 0 || selection.height > 0) {
        resetSelection();
      }
    },
    onCropApply: () => {
      const dataUrl = cropToDataUrl();
      if (!dataUrl) {
        setStatus("切り取りに失敗しました。");
        return;
      }
      deps.onCaptureImage(dataUrl);
      deps.captureUi.closeCropper();
    },
  });

  let interactionMode: "idle" | "create" | "move" | "resize" = "idle";
  let resizeHandle = "";
  let startSelection = { x: 0, y: 0, width: 0, height: 0 };

  if (mathCaptureCropCanvas instanceof HTMLElement) {
    mathCaptureCropCanvas.addEventListener("pointerdown", (event) => {
      const geometry = resolveImageGeometry();
      if (!geometry) return;
      
      const target = event.target as HTMLElement;
      const rect = mathCaptureCropCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      dragStart = { x, y };
      startSelection = { ...selection };
      mathCaptureCropCanvas.setPointerCapture(event.pointerId);

      // Check handle resize
      if (target.classList.contains("capture-crop-handle")) {
        interactionMode = "resize";
        if (target.classList.contains("tl")) resizeHandle = "tl";
        else if (target.classList.contains("tr")) resizeHandle = "tr";
        else if (target.classList.contains("bl")) resizeHandle = "bl";
        else if (target.classList.contains("br")) resizeHandle = "br";
        return;
      }

      // Check moving (if clicking strictly inside selection)
      // We use a small buffer or check if target is selection/guide
      if (
        (target === mathCaptureCropSelection || mathCaptureCropSelection?.contains(target)) &&
        !target.classList.contains("capture-crop-handle")
      ) {
        interactionMode = "move";
        return;
      }

      // Otherwise create new selection
      interactionMode = "create";
      selection = clampSelection({ x, y, width: 0, height: 0 });
      updateSelectionUi();
    });

    mathCaptureCropCanvas.addEventListener("pointermove", (event) => {
      const rect = mathCaptureCropCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Update cursor when idle
      if (interactionMode === "idle") {
        const target = event.target as HTMLElement;
        if (target.classList.contains("capture-crop-handle")) {
          // let CSS handle it
        } else if (
          target === mathCaptureCropSelection ||
          (mathCaptureCropSelection?.contains(target) &&
            !target.classList.contains("capture-crop-handle"))
        ) {
          mathCaptureCropCanvas.style.cursor = "move";
        } else {
          mathCaptureCropCanvas.style.cursor = "crosshair";
        }
        return;
      }

      const dx = x - dragStart.x;
      const dy = y - dragStart.y;
      const geometry = resolveImageGeometry();
      if (!geometry) return;
      const { offsetX, offsetY, displayWidth, displayHeight } = geometry;

      if (interactionMode === "move") {
        let nextX = startSelection.x + dx;
        let nextY = startSelection.y + dy;
        
        // Constrain to image bounds
        nextX = Math.max(offsetX, Math.min(nextX, offsetX + displayWidth - startSelection.width));
        nextY = Math.max(offsetY, Math.min(nextY, offsetY + displayHeight - startSelection.height));

        selection = { ...startSelection, x: nextX, y: nextY };
        updateSelectionUi();
        return;
      }

      if (interactionMode === "resize") {
        let next = { ...startSelection };

        if (resizeHandle.includes("l")) {
          next.x = Math.min(
            startSelection.x + startSelection.width,
            Math.max(offsetX, startSelection.x + dx)
          );
          next.width = startSelection.width + (startSelection.x - next.x);
        }
        if (resizeHandle.includes("r")) {
          next.width = Math.min(
            offsetX + displayWidth - startSelection.x,
            Math.max(0, startSelection.width + dx)
          );
        }
        if (resizeHandle.includes("t")) {
          next.y = Math.min(
            startSelection.y + startSelection.height,
            Math.max(offsetY, startSelection.y + dy)
          );
          next.height = startSelection.height + (startSelection.y - next.y);
        }
        if (resizeHandle.includes("b")) {
          next.height = Math.min(
            offsetY + displayHeight - startSelection.y,
            Math.max(0, startSelection.height + dy)
          );
        }

        // Handle negative flip (optional, for now simple clamping)
        selection = {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height
        };
        updateSelectionUi();
        return;
      }

      if (interactionMode === "create") {
         const next = {
          x: Math.min(dragStart.x, x),
          y: Math.min(dragStart.y, y),
          width: Math.abs(x - dragStart.x),
          height: Math.abs(y - dragStart.y),
        };
        selection = clampSelection(next);
        updateSelectionUi();
      }
    });

    mathCaptureCropCanvas.addEventListener("pointerup", (event) => {
      if (interactionMode === "idle") return;
      interactionMode = "idle";
      mathCaptureCropCanvas.releasePointerCapture(event.pointerId);
      updateSelectionUi();
    });
  }

  return { openCapture };
};
