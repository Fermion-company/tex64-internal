// 図ブロックの先頭行（`%% tex64-figure v2 h=… <base64>`）はキャンバスで再編集する
// ためのシーン実体で、消せない。長い 1 行を inline decoration で display:none に
// しても Monaco の折り返しレイアウトは行の高さを確保してしまうため、モデルはそのまま
// hidden area に入れ、同じ場所に 1 行分だけの view zone を表示する。

import { onUiLocaleChange, uiText } from "../i18n.js";
import { decodeFigureBlockAt, isFigureHeaderLine } from "./figure-codec.js";

type ViewZoneAccessor = {
  addZone: (zone: { afterLineNumber: number; heightInPx: number; showInHiddenAreas?: boolean; domNode: HTMLElement }) => string;
  removeZone: (id: string) => void;
};
type ChipEditor = {
  getModel?: () => { getLinesContent?: () => string[] } | null;
  setHiddenAreas?: (ranges: unknown[], source?: string, forceUpdate?: boolean) => void;
  changeViewZones?: (change: (accessor: ViewZoneAccessor) => void) => void;
  setPosition?: (position: { lineNumber: number; column: number }) => void;
  revealLineInCenterIfOutsideViewport?: (lineNumber: number) => void;
  focus?: () => void;
  onDidChangeModelContent?: (listener: () => void) => unknown;
  onDidChangeModel?: (listener: () => void) => unknown;
};

const hoverText = () => uiText("This is the figure's data, needed to edit it on the canvas. Deleting it means the figure can no longer be reopened there.", "この図のデータです（キャンバスで編集するのに必要）。消すと「図をキャンバスで編集」が使えなくなります。");
const chipLabel = () => uiText("▤ figure data (edit on canvas)", "▤ 図データ（キャンバスで編集）");

export const figureMetaLineNumbers = (lines: string[]): number[] => lines
  .map((line, index) => isFigureHeaderLine(line) ? index + 1 : 0)
  .filter((lineNumber) => lineNumber > 0);

export const installFigureMetaChips = (editor: ChipEditor): void => {
  const Range = (window as any).monaco?.Range;
  if (!Range || !editor?.setHiddenAreas || !editor.changeViewZones) return;
  const source = "tex64-figure-meta";
  let zoneIds: string[] = [];

  const refresh = () => {
    const lines = editor.getModel?.()?.getLinesContent?.();
    const lineNumbers = lines ? figureMetaLineNumbers(lines) : [];
    const ranges = lineNumbers.map((lineNumber) => new Range(lineNumber, 1, lineNumber, (lines?.[lineNumber - 1]?.length || 0) + 1));
    editor.setHiddenAreas?.(ranges, source, true);
    editor.changeViewZones?.((accessor) => {
      zoneIds.forEach((id) => accessor.removeZone(id));
      zoneIds = lineNumbers.map((lineNumber) => {
        const zone = document.createElement("div");
        zone.className = "tex64-figure-meta-zone";
        zone.title = hoverText();
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = chipLabel();
        button.title = hoverText();
        button.onclick = () => {
          const decoded = lines ? decodeFigureBlockAt(lines, lineNumber - 1) : null;
          if (decoded?.detached && !window.confirm(uiText("This figure's code has been edited by hand. Updating it from the canvas will discard those edits. Continue?", "この図のコードは手編集されています。キャンバスで更新すると手編集分は失われます。続けますか？"))) return;
          if (decoded) {
            window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open", { detail: {
              scene: decoded.scene,
              replaceRange: { startLine: decoded.startLine + 1, endLine: decoded.endLine + 1 },
            } }));
            return;
          }
          const target = Math.min(lineNumber + 1, lines?.length || lineNumber + 1);
          editor.setPosition?.({ lineNumber: target, column: 1 });
          editor.revealLineInCenterIfOutsideViewport?.(target);
          editor.focus?.();
        };
        zone.append(button);
        return accessor.addZone({ afterLineNumber: lineNumber, heightInPx: 22, showInHiddenAreas: true, domNode: zone });
      });
    });
  };

  let timer: number | null = null;
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; refresh(); }, 120);
  };
  editor.onDidChangeModelContent?.(schedule);
  editor.onDidChangeModel?.(refresh);
  onUiLocaleChange(refresh);
  refresh();
};
