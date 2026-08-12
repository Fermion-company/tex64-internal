# Pro 作図キャンバス C2 実装仕様 — fermion 実コンパイル差し替え

C1（pro-canvas-c1-spec.md）の続き。キャンバスの近似 SVG 表示を、アイドル時に
fermion-tex-engine で実コンパイルした本物のレンダリングへ差し替える。

方針: **操作中（ドラッグ/描画中）は近似 SVG、手が止まったら実コンパイル PDF を
ビットマップとしてアートボードに重ねる**。エンジンが無い/失敗時は近似のまま劣化運転。

## main プロセス

### `electron/services/fermion-engine.cjs`

- 追加ヘルパー `requestBuffer(url, {timeoutMs})` — `requestJson` と同型だが生の Buffer を返す
  （`/pdf` 用。status 200 以外は reject）。
- `FermionEngineService` にメソッド追加:

```js
async renderPdf({ source }) {
  // push() と同じく start → /doc → /edit 全文置換。その後 GET /pdf。
  // 戻り値: { ok: true, report, pdfBase64 }（pdfBase64 は Buffer.toString("base64")）
  // /edit の report はそのまま返す（エラー情報は renderer 側で表示に使う）
}
```

- 既存 `push` と重複するロジック（/doc → /edit）は小さな private メソッドに括り出して共用
  してよい（挙動は変えない）。

### `electron/main.cjs`

- ライブプレビュー用の既存 `fermionEngineService` とは**別に**、キャンバス専用の
  第2インスタンス `canvasFermionEngineService` と factory `getCanvasFermionEngineService()`
  を追加（同じ `FermionEngineService`、ポートは自動割当なので衝突しない）。
  ライブプレビューの文書を canvas のコンパイルで壊さないための分離。
- `registerFermionEngineHandlers` へ factory を渡す（シグネチャ拡張）。
- アプリ終了時の shutdown 処理に第2インスタンスも含める（既存の fermion shutdown 箇所に倣う）。

### `electron/handlers/fermion-engine.cjs` + `electron/preload.cjs`

- IPC `tex64:fermion:canvas-render`（payload `{ source }`）→
  `getCanvasFermionEngineService().renderPdf(payload)`。
- preload の `fermionApi` に `canvasRender: (payload) => invoke("tex64:fermion:canvas-render", payload)`
  を追加（`tex64Fermion.canvasRender`）。

## renderer

### 新規 `web-src/app/pro-canvas/standalone.ts`（純関数・DOM 非依存・テスト対象）

```ts
export const buildStandaloneDoc = (scene: Scene): string
```

- `generateTikz(scene)` を呼び、以下の形の完全な LuaLaTeX 文書を返す:

```
\documentclass[margin=0pt]{standalone}
\usepackage{tikz}
\usetikzlibrary{arrows.meta}        ← requires にあるもののみ（空なら行ごと省略）
\begin{document}
<generateTikz の code。ただし \begin{tikzpicture}[...] 行の直後に
  \useasboundingbox (0,0) rectangle (W,H); を挿入>
\end{document}
```

- `% requires` コメント行は文書には**含めない**（\usetikzlibrary に変換済みのため、
  code から該当行を取り除く）。
- `\useasboundingbox` により PDF ページ = アートボード（0,0)-(W,H) に固定される。
  W/H は scene.width/height（座標は picture オプションの単位系のまま素の数値）。

### `web-src/app/pro-canvas/canvas-ui.ts` の拡張

- ツールバーに **Live トグル**（`data-action="live"`、表示は `Live`）。既定 ON。
  ON/OFF は `localStorage["tex64.proCanvas.live"]` に永続化。
- コンパイルのトリガ: シーンが変わる操作の確定時（snapshot を積む操作、undo/redo、
  ドラッグの pointerup）に 600ms デバウンスで:
  1. `window.tex64Fermion?.canvasRender({ source: buildStandaloneDoc(scene) })`
  2. 成功したら pdfBase64 を pdfjs（`../pdfjs/pdf.min.mjs` を lazy import —
     `ai-chat-attachments.ts` の loadPdfjs と同じパターン。worker/cmaps/fonts の URL 設定も同様）
     でページ 1 を **アートボードの実ピクセル解像度 ×2** 程度でレンダリングし、
     dataURL にする。
  3. SVG 内のアートボード位置（scene 座標 (0,0)-(W,H)、y 反転に注意 — text ノードと
     同じ `transform="scale(1,-1)"` 方式で貼る）に `<image>` として表示。
- 表示合成の規則:
  - コンパイル画像が **最新シーンに対応している**とき: `<image>` を表示し、オブジェクト
    描画レイヤは `opacity 0`（ただし hit-test は生かす。グループ `<g>` に
    `pointer-events="all"` 相当の挙動を維持）。選択枠・ハンドルは画像より上に描く。
  - ドラッグ/描画操作の開始で画像を隠し（stale 扱い）、近似レイヤ opacity を 1 に戻す。
  - シーケンス番号で stale ガード（応答が古いリクエストのものなら捨てる）。
- report にエラーがある場合（report の中身は握らず、`report.errors`/`report.log` 等
  それらしきフィールドがあれば先頭 1 行、なければ「コンパイルエラー」）をステータス領域に
  表示し、近似表示のまま。
- `tex64Fermion` が無い環境（テスト/劣化時）は Live ボタンを disabled にし近似のみ。

## テスト

- `tests/pro-canvas-standalone.test.mjs`（新規）:
  - 矢印ありシーン → `\usetikzlibrary{arrows.meta}` 行があり、`% requires` 行が無い
  - 矢印なし → `\usetikzlibrary` 行が無い
  - `\useasboundingbox (0,0) rectangle (100,100);` が `\begin{tikzpicture}` の直後の行にある
  - `\documentclass[margin=0pt]{standalone}` で始まり `\end{document}` で終わる
- `tests/fermion-engine-service.test.cjs`（既存）に renderPdf のケースを追加:
  既存テストのやり方に合わせてローカル HTTP スタブ（/doc, /edit, /pdf）を立て、
  renderPdf が pdfBase64 と report を返すことを確認。既存ケースは変更しない。

## 制約（C1 と同じ + 追記)

- 依存追加なし。pdfjs は vendored のものを lazy import。
- 既存のライブプレビュー（`pro-live-preview.ts` / 第1インスタンス）の挙動を一切変えない。
- CSP: renderer から fermion へ直接 fetch しない（すべて IPC 経由）。`connect-src` を変えない。
- main の `.cjs` を変更するので Electron 再起動が必要（報告に明記）。
