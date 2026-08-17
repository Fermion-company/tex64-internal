// 図ブロックの先頭行（`%% tex64-figure v2 h=… <base64>`）はキャンバスで再編集する
// ためのシーン実体で、消せない。ただし数百文字あって本文の邪魔になるので、
// エディタ上だけ短いチップに畳んで見せる（ファイルの中身は変えない）。
//
// 実装は Monaco のデコレーション 2 枚:
//   inlineClassName        … base64 本体を display:none で隠す
//   beforeContentClassName … その手前にチップを 1 個だけ描く（CSS の content）

import { onUiLocaleChange, uiText } from "../i18n.js";
import { isFigureHeaderLine } from "./figure-codec.js";

type DecorationCollection = { set: (decorations: unknown[]) => void };
type ChipEditor = {
  getModel?: () => { getLinesContent?: () => string[] } | null;
  createDecorationsCollection?: (decorations: unknown[]) => DecorationCollection;
  onDidChangeModelContent?: (listener: () => void) => unknown;
  onDidChangeModel?: (listener: () => void) => unknown;
};

const hoverText = () => uiText("This is the figure's data, needed to edit it on the canvas. Deleting it means the figure can no longer be reopened there.", "この図のデータです（キャンバスで編集するのに必要）。消すと「図をキャンバスで編集」が使えなくなります。");

// The chip itself is drawn by CSS `content`, which no translation pass can
// reach. Publish the label as a custom property instead, and refresh it when
// the locale changes.
const chipLabel = () => uiText("▤ figure data (edit on canvas)", "▤ 図データ（キャンバスで編集）");
const publishChipLabel = () =>
  document.documentElement.style.setProperty("--tex64-figure-meta-chip", JSON.stringify(chipLabel()));
let localeHooked = false;

export const installFigureMetaChips = (editor: ChipEditor): void => {
  const Range = (window as any).monaco?.Range;
  if (!Range || !editor?.createDecorationsCollection) return;
  publishChipLabel();
  if (!localeHooked) { localeHooked = true; onUiLocaleChange(publishChipLabel); }
  const collection = editor.createDecorationsCollection([]);
  const refresh = () => {
    const lines = editor.getModel?.()?.getLinesContent?.();
    if (!lines) { collection.set([]); return; }
    const decorations: unknown[] = [];
    lines.forEach((line, index) => {
      if (!isFigureHeaderLine(line)) return;
      decorations.push({
        range: new Range(index + 1, 1, index + 1, line.length + 1),
        options: {
          inlineClassName: "tex64-figure-meta",
          beforeContentClassName: "tex64-figure-meta-chip",
          hoverMessage: { value: hoverText() },
          stickiness: 1, // NeverGrowsWhenTypingAtEdges
        },
      });
    });
    collection.set(decorations);
  };
  let timer: number | null = null;
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; refresh(); }, 120);
  };
  editor.onDidChangeModelContent?.(schedule);
  editor.onDidChangeModel?.(refresh);
  refresh();
};
