import type { AppContext } from "./context.js";
import type { IssuesStatus, IssueItem } from "./types.js";
import type { CaptureUiApi, CaptureWindowSource } from "./capture-ui.js";
import type { PasteAlchemyApi } from "./paste-alchemy.js";

type MagicCaptureDeps = {
  captureUi: CaptureUiApi;
  pasteAlchemy: PasteAlchemyApi;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
};

export type MagicCaptureApi = {
  openCapture: () => void;
};

type CaptureSourceWithSize = CaptureWindowSource & {
  width?: number;
  height?: number;
};

export const initMagicCapture = (
  context: AppContext,
  deps: MagicCaptureDeps
): MagicCaptureApi => {
  const {
    captureCropCanvas,
    captureCropSelection,
    captureCropGuide,
    captureCropImage,
    captureCropSize,
  } = context.dom;

  const captureApi =
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

  const resolveImageGeometry = () => {
    if (!(captureCropCanvas instanceof HTMLElement)) return null;
    if (!(captureCropImage instanceof HTMLImageElement)) return null;
    const rect = captureCropCanvas.getBoundingClientRect();
    const naturalWidth = captureCropImage.naturalWidth || 1;
    const naturalHeight = captureCropImage.naturalHeight || 1;
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
    if (!(captureCropSelection instanceof HTMLElement)) return;
    if (!(captureCropGuide instanceof HTMLElement)) return;
    captureCropSelection.style.left = `${selection.x}px`;
    captureCropSelection.style.top = `${selection.y}px`;
    captureCropSelection.style.width = `${selection.width}px`;
    captureCropSelection.style.height = `${selection.height}px`;
    captureCropGuide.style.left = `${selection.x}px`;
    captureCropGuide.style.top = `${selection.y}px`;
    captureCropGuide.style.width = `${selection.width}px`;
    captureCropGuide.style.height = `${selection.height}px`;
    const geometry = resolveImageGeometry();
    if (!geometry || !(captureCropSize instanceof HTMLElement)) return;
    const { offsetX, offsetY, displayWidth, displayHeight, naturalWidth, naturalHeight } =
      geometry;
    const scaleX = naturalWidth / displayWidth;
    const scaleY = naturalHeight / displayHeight;
    const cropWidth = Math.max(0, Math.round(selection.width * scaleX));
    const cropHeight = Math.max(0, Math.round(selection.height * scaleY));
    captureCropSize.textContent = `${cropWidth} × ${cropHeight}`;
  };

  const resetSelection = () => {
    const geometry = resolveImageGeometry();
    if (!geometry) return;
    const { offsetX, offsetY, displayWidth, displayHeight } = geometry;
    const width = displayWidth * 0.6;
    const height = displayHeight * 0.6;
    selection = {
      x: offsetX + (displayWidth - width) / 2,
      y: offsetY + (displayHeight - height) / 2,
      width,
      height,
    };
    updateSelectionUi();
  };

  const toImageCrop = () => {
    if (!(captureCropImage instanceof HTMLImageElement)) return null;
    const geometry = resolveImageGeometry();
    if (!geometry) return null;
    const { offsetX, offsetY, displayWidth, displayHeight, naturalWidth, naturalHeight } =
      geometry;
    const scaleX = naturalWidth / displayWidth;
    const scaleY = naturalHeight / displayHeight;
    const x = Math.max(0, Math.round((selection.x - offsetX) * scaleX));
    const y = Math.max(0, Math.round((selection.y - offsetY) * scaleY));
    const width = Math.max(1, Math.round(selection.width * scaleX));
    const height = Math.max(1, Math.round(selection.height * scaleY));
    return { x, y, width, height, naturalWidth, naturalHeight };
  };

  const cropToDataUrl = () => {
    if (!(captureCropImage instanceof HTMLImageElement)) return null;
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
      captureCropImage,
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
    if (!captureApi?.listSources) {
      deps.updateIssues(1, "画面キャプチャが利用できません。", "error", [
        { severity: "error", message: "画面キャプチャが利用できません。" },
      ]);
      return;
    }
    try {
      sources = await captureApi.listSources({
        thumbnailSize: { width: 1600, height: 900 },
      });
    } catch (error) {
      deps.updateIssues(1, "ウィンドウ一覧の取得に失敗しました。", "error", [
        { severity: "error", message: "ウィンドウ一覧の取得に失敗しました。" },
      ]);
      return;
    }
    if (sources.length === 0) {
      deps.updateIssues(0, "取り込み可能なウィンドウがありません。", "info", []);
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
      if (captureCropImage instanceof HTMLImageElement) {
        captureCropImage.onload = () => {
          resetSelection();
        };
      }
      resetSelection();
    },
    onWindowCancel: () => {
      selectedSource = null;
    },
    onCropRetry: () => {
      deps.captureUi.closeCropper();
      void openCapture();
    },
    onCropCancel: () => {
      deps.captureUi.closeCropper();
    },
    onCropApply: () => {
      const dataUrl = cropToDataUrl();
      if (!dataUrl) {
        deps.updateIssues(1, "切り取りに失敗しました。", "error", [
          { severity: "error", message: "切り取りに失敗しました。" },
        ]);
        return;
      }
      deps.pasteAlchemy.handleCaptureImage(dataUrl, "キャプチャ");
      deps.captureUi.closeCropper();
    },
  });

  if (captureCropCanvas instanceof HTMLElement) {
    captureCropCanvas.addEventListener("pointerdown", (event) => {
      const geometry = resolveImageGeometry();
      if (!geometry) return;
      const rect = captureCropCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      isDragging = true;
      dragStart = { x, y };
      selection = clampSelection({ x, y, width: 0, height: 0 });
      updateSelectionUi();
      captureCropCanvas.setPointerCapture(event.pointerId);
    });
    captureCropCanvas.addEventListener("pointermove", (event) => {
      if (!isDragging) return;
      const rect = captureCropCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const next = {
        x: Math.min(dragStart.x, x),
        y: Math.min(dragStart.y, y),
        width: Math.abs(x - dragStart.x),
        height: Math.abs(y - dragStart.y),
      };
      selection = clampSelection(next);
      updateSelectionUi();
    });
    captureCropCanvas.addEventListener("pointerup", (event) => {
      if (!isDragging) return;
      isDragging = false;
      captureCropCanvas.releasePointerCapture(event.pointerId);
      updateSelectionUi();
    });
  }

  return { openCapture };
};
