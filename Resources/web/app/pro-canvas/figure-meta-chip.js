// 図ブロックの先頭行（`%% tex64-figure v2 h=… <base64>`）はキャンバスで再編集する
// ためのシーン実体で、消せない。長い 1 行を inline decoration で display:none に
// しても Monaco の折り返しレイアウトは行の高さを確保してしまうため、モデルはそのまま
// hidden area に入れ、同じ場所に 1 行分だけの view zone を表示する。
import { onUiLocaleChange, uiText } from "../i18n.js";
import { decodeFigureBlockAt, isFigureHeaderLine } from "./figure-codec.js";
const hoverText = () => uiText("The figure's canvas data. Delete it and the figure can no longer be edited on the canvas.", "キャンバスで編集するためのデータです。消すと再編集できなくなります。");
const chipLabel = () => uiText("▤ Edit on canvas", "▤ キャンバスで編集");
export const figureMetaLineNumbers = (lines) => lines
    .map((line, index) => isFigureHeaderLine(line) ? index + 1 : 0)
    .filter((lineNumber) => lineNumber > 0);
export const installFigureMetaChips = (editor) => {
    var _a, _b, _c;
    const Range = (_a = window.monaco) === null || _a === void 0 ? void 0 : _a.Range;
    if (!Range || !(editor === null || editor === void 0 ? void 0 : editor.setHiddenAreas) || !editor.changeViewZones)
        return;
    const source = "tex64-figure-meta";
    let zoneIds = [];
    const refresh = () => {
        var _a, _b, _c, _d, _e;
        const lines = (_c = (_b = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.getLinesContent) === null || _c === void 0 ? void 0 : _c.call(_b);
        const lineNumbers = lines ? figureMetaLineNumbers(lines) : [];
        const ranges = lineNumbers.map((lineNumber) => { var _a; return new Range(lineNumber, 1, lineNumber, (((_a = lines === null || lines === void 0 ? void 0 : lines[lineNumber - 1]) === null || _a === void 0 ? void 0 : _a.length) || 0) + 1); });
        (_d = editor.setHiddenAreas) === null || _d === void 0 ? void 0 : _d.call(editor, ranges, source, true);
        (_e = editor.changeViewZones) === null || _e === void 0 ? void 0 : _e.call(editor, (accessor) => {
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
                    var _a, _b, _c;
                    const decoded = lines ? decodeFigureBlockAt(lines, lineNumber - 1) : null;
                    if ((decoded === null || decoded === void 0 ? void 0 : decoded.detached) && !window.confirm(uiText("Discard manual edits and update from the canvas?", "手編集を破棄してキャンバスで更新しますか？")))
                        return;
                    if (decoded) {
                        window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open", { detail: {
                                scene: decoded.scene,
                                replaceRange: { startLine: decoded.startLine + 1, endLine: decoded.endLine + 1 },
                            } }));
                        return;
                    }
                    const target = Math.min(lineNumber + 1, (lines === null || lines === void 0 ? void 0 : lines.length) || lineNumber + 1);
                    (_a = editor.setPosition) === null || _a === void 0 ? void 0 : _a.call(editor, { lineNumber: target, column: 1 });
                    (_b = editor.revealLineInCenterIfOutsideViewport) === null || _b === void 0 ? void 0 : _b.call(editor, target);
                    (_c = editor.focus) === null || _c === void 0 ? void 0 : _c.call(editor);
                };
                zone.append(button);
                return accessor.addZone({ afterLineNumber: lineNumber, heightInPx: 22, showInHiddenAreas: true, domNode: zone });
            });
        });
    };
    let timer = null;
    const schedule = () => {
        if (timer !== null)
            window.clearTimeout(timer);
        timer = window.setTimeout(() => { timer = null; refresh(); }, 120);
    };
    (_b = editor.onDidChangeModelContent) === null || _b === void 0 ? void 0 : _b.call(editor, schedule);
    (_c = editor.onDidChangeModel) === null || _c === void 0 ? void 0 : _c.call(editor, refresh);
    onUiLocaleChange(refresh);
    refresh();
};
