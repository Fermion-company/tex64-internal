import type { BlockAutoDetectApi } from "./auto-detect.js";
import type { BlockMode } from "../types.js";

type EditorLike = {
  focus?: () => void;
  getPosition?: () => { lineNumber: number; column: number } | null;
};

type BlockEditSessionDeps = {
  getActiveGroup: () => { editor?: EditorLike | null; currentFilePath?: string | null };
  autoDetect: Pick<
    BlockAutoDetectApi,
    "syncDetectedBlockAtPosition" | "activateDetectedBlock" | "clearDetectedBlockState"
  >;
  clearMathInput: () => void;
  setBlockModeUi: (mode: BlockMode) => void;
};

export type BlockEditSessionApi = {
  setMode: (mode: BlockMode) => void;
  getMode: () => BlockMode;
  exitEditMode: () => void;
  handleCursorPositionChange: (position: { lineNumber: number; column: number }) => void;
  refreshDetectedBlock: (allowTabSwitch?: boolean) => void;
};

type DetectedKeySource = {
  type: string;
  start: number;
  end: number;
  fullMatch?: string;
};

export const initBlockEditSession = (deps: BlockEditSessionDeps): BlockEditSessionApi => {
  let mode: BlockMode = "insert";
  let lastDetectedKey: string | null = null;

  const buildDetectedKey = (detected: DetectedKeySource) =>
    `${detected.type}:${detected.start}:${detected.end}:${detected.fullMatch ?? ""}`;

  const canEdit = () => {
    const group = deps.getActiveGroup();
    const editor = group.editor;
    if (!editor || !group.currentFilePath?.endsWith(".tex")) {
      return false;
    }
    return true;
  };

  const clearDetected = (clearActive: boolean) => {
    deps.autoDetect.clearDetectedBlockState({ force: true, clearActive });
    lastDetectedKey = null;
  };

  const syncDetectedAtPosition = (
    position: { lineNumber: number; column: number },
    options?: { force?: boolean; allowTabSwitch?: boolean }
  ) => {
    if (!canEdit()) {
      return;
    }
    const detected = deps.autoDetect.syncDetectedBlockAtPosition(position, {
      force: options?.force ?? false,
      allowTabSwitch: options?.allowTabSwitch ?? false,
      ignoreSelection: true,
    });
    if (!detected) {
      clearDetected(true);
      deps.clearMathInput();
      return;
    }
    const nextKey = buildDetectedKey(detected);
    if (nextKey !== lastDetectedKey) {
      deps.autoDetect.activateDetectedBlock();
      lastDetectedKey = nextKey;
    }
  };

  const enterEditMode = () => {
    if (!canEdit()) {
      mode = "insert";
      deps.setBlockModeUi(mode);
      return;
    }
    lastDetectedKey = null;
    const editor = deps.getActiveGroup().editor;
    editor?.focus?.();
    const position = editor?.getPosition?.();
    if (position) {
      syncDetectedAtPosition(position, { force: true, allowTabSwitch: true });
    }
  };

  const leaveEditMode = () => {
    clearDetected(true);
  };

  const setMode = (nextMode: BlockMode) => {
    if (nextMode === "edit" && !canEdit()) {
      mode = "insert";
      deps.setBlockModeUi(mode);
      return;
    }
    if (mode === nextMode) {
      deps.setBlockModeUi(mode);
      return;
    }
    mode = nextMode;
    deps.setBlockModeUi(mode);
    if (mode === "edit") {
      enterEditMode();
    } else {
      leaveEditMode();
    }
  };

  const handleCursorPositionChange = (position: { lineNumber: number; column: number }) => {
    if (mode !== "edit") {
      return;
    }
    syncDetectedAtPosition(position, { force: false, allowTabSwitch: false });
  };

  const refreshDetectedBlock = (allowTabSwitch = false) => {
    if (mode !== "edit") {
      return;
    }
    const editor = deps.getActiveGroup().editor;
    const position = editor?.getPosition?.();
    if (!position) {
      return;
    }
    syncDetectedAtPosition(position, { force: true, allowTabSwitch });
  };

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (mode !== "edit") {
      return;
    }
    setMode("insert");
  });

  deps.setBlockModeUi(mode);

  return {
    setMode,
    getMode: () => mode,
    exitEditMode: () => setMode("insert"),
    handleCursorPositionChange,
    refreshDetectedBlock,
  };
};
