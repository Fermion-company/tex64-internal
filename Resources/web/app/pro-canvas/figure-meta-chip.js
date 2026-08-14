// 図ブロックの先頭行（`%% tex64-figure v2 h=… <base64>`）はキャンバスで再編集する
// ためのシーン実体で、消せない。ただし数百文字あって本文の邪魔になるので、
// エディタ上だけ短いチップに畳んで見せる（ファイルの中身は変えない）。
//
// 実装は Monaco のデコレーション 2 枚:
//   inlineClassName        … base64 本体を display:none で隠す
//   beforeContentClassName … その手前にチップを 1 個だけ描く（CSS の content）
import { isFigureHeaderLine } from "./figure-codec.js";
const HOVER = "この図のデータです（キャンバスで編集するのに必要）。消すと「図をキャンバスで編集」が使えなくなります。";
export const installFigureMetaChips = (editor) => {
    var _a, _b, _c;
    const Range = (_a = window.monaco) === null || _a === void 0 ? void 0 : _a.Range;
    if (!Range || !(editor === null || editor === void 0 ? void 0 : editor.createDecorationsCollection))
        return;
    const collection = editor.createDecorationsCollection([]);
    const refresh = () => {
        var _a, _b, _c;
        const lines = (_c = (_b = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor)) === null || _b === void 0 ? void 0 : _b.getLinesContent) === null || _c === void 0 ? void 0 : _c.call(_b);
        if (!lines) {
            collection.set([]);
            return;
        }
        const decorations = [];
        lines.forEach((line, index) => {
            if (!isFigureHeaderLine(line))
                return;
            decorations.push({
                range: new Range(index + 1, 1, index + 1, line.length + 1),
                options: {
                    inlineClassName: "tex64-figure-meta",
                    beforeContentClassName: "tex64-figure-meta-chip",
                    hoverMessage: { value: HOVER },
                    stickiness: 1, // NeverGrowsWhenTypingAtEdges
                },
            });
        });
        collection.set(decorations);
    };
    let timer = null;
    const schedule = () => {
        if (timer !== null)
            window.clearTimeout(timer);
        timer = window.setTimeout(() => { timer = null; refresh(); }, 120);
    };
    (_b = editor.onDidChangeModelContent) === null || _b === void 0 ? void 0 : _b.call(editor, schedule);
    (_c = editor.onDidChangeModel) === null || _c === void 0 ? void 0 : _c.call(editor, refresh);
    refresh();
};
