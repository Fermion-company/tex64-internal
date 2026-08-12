# Pro 作図キャンバス E 実装仕様 — 対称オーナメント配置 / 図ギャラリー

C/D の続き。Codex 協議済み（2026-08-13）。要点: 鏡映は `tx=W, sx=-1`（シンボル座標は
絶対座標で焼かれているため）、四隅はシンボルの絶対 bounds から導出、fermion キャンバス
エンジンは**サービス内で全 renderPdf を直列化**、ギャラリーは新モジュール + 既存 modal 規約。

## E0: fermion renderPdf の直列化（前提修正）

`electron/services/fermion-engine.cjs`: `renderPdf` の全トランザクション
（replaceDocument → /pdf）を Promise チェーンのキューで直列化する
（`this.renderQueue = this.renderQueue.then(run, run)` パターン。エラーでもチェーンを
切らない）。Live コンパイルとギャラリーのサムネイル生成が同一シングルトンを共有するため。
`push()` は対象外（別インスタンス）。既存テストは無改変で green、直列化の単体テストを
`tests/fermion-engine-service.test.cjs` に 1 ケース追加（2 並列 renderPdf が順に処理される）。

## E1: 対称オーナメント配置

### 純関数（`canvas-math.ts` に追加・テスト対象）

```ts
export const mirrorInstanceTransform = (artboardWidth: number): Transform
// => { tx: artboardWidth, ty: 0, rotate: 0, sx: -1, sy: 1 }
// （絶対座標焼き込みのため x' = W - x になる）

export const cornerInstanceTransforms = (
  bounds: Bounds,           // シンボルの絶対 bounds（identity インスタンスで計測）
  artboardWidth: number, artboardHeight: number, inset: number,
): [Transform, Transform, Transform, Transform]
// 左下(そのまま), 右下(sx=-1), 左上(sy=-1), 右上(sx=sy=-1) の順。
// 左下: tx = inset - bounds.minX,            ty = inset - bounds.minY
// 右下: tx = artboardWidth - inset + bounds.minX, ty = 左下と同じ
// 左上: tx = 左下と同じ,                      ty = artboardHeight - inset + bounds.minY
// 右上: tx = 右下の tx,                       ty = 左上の ty
// （各コーナーで symbol bounds の最寄り 2 辺が inset の位置に来る）
```

Transform 型は scene.js から import（canvas-math は既に scene の型を import 済み）。

### UI（`canvas-ui.ts`）

- Symbols セクションに:
  - **「選択を対称シンボル化」**: 既存「選択をシンボル化」と同じ流れでシンボル化した後、
    identity インスタンスに加えて `mirrorInstanceTransform(scene.width)` の第2インスタンスを
    追加（左右対称ペア）。
  - シンボル行に **「四隅に配置」**: `prompt("inset", "5")` → シンボルの bounds
    （`objectBounds` を identity の一時 instance で計測。シンボルは `scene.symbols` に
    存在済み）→ `cornerInstanceTransforms` で 4 インスタンスを追加し、4 つを 1 グループに
    まとめて選択状態に。
- どちらも snapshot → render → scheduleCompile の既存パターン。

## E2: 図ギャラリー

### 純関数（`figure-codec.ts` に追加・テスト対象）

```ts
export const listFigureBlocks = (lines: string[]): Array<{ scene: Scene; startLine: number; endLine: number; detached: boolean }>
// `/^%% tex64-figure v1\b/` に一致する行だけ decodeFigureBlockAt を呼び、
// 成功したら endLine+1 から走査を続ける線形スキャン。失敗ヘッダは読み飛ばす。
```

### 新規モジュール `web-src/app/pro-canvas/gallery-ui.ts`

`export const initProCanvasGallery = (deps: { getActiveGroup: () => { editor: unknown | null } })`

- トリガ: `Resources/web/index.html` の `#pro-canvas-open` の隣に
  `<button id="pro-canvas-gallery" type="button" title="Figure gallery" hidden>⊞ Figures</button>`。
  表示制御は `pro-mode-ui.ts` の `pro-canvas-open` と同じ箇所に 1 行追加。
- クリックで modal を開く（**既存規約**: `.modal` / `.modal-card` / `.modal-title` /
  `.modal-actions` + `is-open` / aria-hidden / Esc・背景クリックで閉じる/フォーカス復帰。
  動的 modal の実例は `web-src/app/code-comments.ts`）。
- 内容: アクティブエディタのテキスト
  （`deps.getActiveGroup().editor.getModel()?.getValue()` — monaco-setup の
  `tex64.pro-canvas-edit` と同じ取り方）を `listFigureBlocks` でスキャンし、
  1 行 = 1 図: 「図 N（行 L、オブジェクト数 M）」+ detached バッジ + 「編集」ボタン + サムネイル枠。
- 「編集」: `tex64:pro-canvas-open` を `{ scene, replaceRange: { startLine: startLine+1, endLine: endLine+1 } }`
  で dispatch し modal を閉じる（1-indexed 変換は monaco-setup の既存アクションと同じ）。
- **サムネイル**: modal 表示後に**逐次**（並列禁止 — E0 の直列化があるとはいえ 1 つずつ）
  `tex64Fermion.canvasRender({ source: buildStandaloneDoc(scene) })` → pdfjs で小さく
  （幅 ~160px）描画して `<img>` に。canvas-ui の loadPdfjs/renderPdf と同等の処理だが、
  モジュール独立のため gallery-ui 内に軽量版を実装してよい（pdfjs ローダは
  canvas-ui から export して共用するのが望ましい）。失敗した図は「⚠」表示で続行。
  modal を閉じたら残りのサムネイル生成は中断（世代カウンタ）。
- `tex64Fermion` が無い場合はサムネイル枠を出さない（一覧と編集は動く）。

### 配線

- `web-src/main-init.ts`: `initProCanvasUi` の隣で `initProCanvasGallery({ getActiveGroup })`。
- `Resources/web/theme.css`: `pro-canvas-gallery-` プレフィックスで最小限の追加
  （行レイアウト・サムネイル 160px 枠・detached バッジ）。

## テスト

- `tests/pro-canvas-symmetry.test.mjs`（新規）: mirrorInstanceTransform / 
  cornerInstanceTransforms（正方形 bounds・inset 5 で 4 隅の tx/ty を検証、
  鏡映側の bounds が inset 位置に来ることを allPoints 相当の手計算で確認）
- `tests/pro-canvas-codec.test.mjs` に追記: listFigureBlocks — 2 ブロック + 間に通常テキスト /
  壊れたヘッダのスキップ / detached 検出（既存ケース無改変）
- `tests/fermion-engine-service.test.cjs` に直列化 1 ケース追加

## 制約

- C/D の規約踏襲。scene スキーマ変更なし。既存テスト無改変で green。
- gallery は canvas-ui.ts に足さず新モジュール。
- main `.cjs` 変更（E0）→ Electron 再起動が必要。
