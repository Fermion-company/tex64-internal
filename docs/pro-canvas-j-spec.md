# Pro Canvas J: Illustrator 式ペン（曲線モード）+ desmos 式グラフ挿入

ユーザー要望 2 点:
1. 「曲線配置できないのは渋い。曲線モードは必要。Adobe 系パクっていい」
2. 「グラフはいきなり 2 次関数を置くんじゃなく、desmos みたいに関数形を書いて範囲を指定して、その形を写し入れる形にしたい」

対象: `web-src/app/pro-canvas/canvas-ui.ts`（+必要なら scene.ts/tikz-generate.ts/sty-export.ts）+ `Resources/web/theme.css` + tests。electron/ 不変。

制約（毎回同じ・厳守）: plain tsc / 新規 npm 依存なし / eval・new Function 禁止 / 生成 `Resources/web/app/**/*.js` 手編集禁止（theme.css は編集可）/ 既存の高密度 1 行スタイルに合わせる / 動的 title・placeholder に `data-no-i18n` / ドラッグ由来のシーン変更はメイン pointermove の分岐内 / 完了条件 `npx tsc -p web-src/tsconfig.json` 0 エラー + `node --test tests/*.test.cjs tests/*.test.mjs` 全 pass + 新規テスト。

## A. ペンを Illustrator の状態機械に（曲線が主役）

現状の問題: ドラッグは「今置いたセグメントの c2 だけ」を反転で作る。c1 は常に前アンカーに退化（出ハンドル無し）なので、すべてのセグメントが「直線で出て曲がって入る」半端な曲線になる。最初の点ではドラッグが無意味。ハンドルも描画されない。

Illustrator 標準の挙動に置き換える（scene モデルは不変。cubic セグメントに落とし込む）:

```ts
// 描画中状態を拡張
let pen: { path; lastOut: Vec|null } | null   // lastOut = 直前アンカーの出ハンドル（ベクトル）
let penDrag: { anchor: Vec; handle: Vec|null } | null  // 今引き出し中のハンドル
```

- **pointerdown**（pen ツール、開始点クリックでの close 判定は現状維持）: アンカー位置 `p` を確定し `penDrag={anchor:p,handle:null}`。**セグメントはまだ作らない**。
- **pointermove（ボタン押下中）**: `handle = cursor - anchor`（4px 閾値未満は null のまま）。スナップは anchor には効かせ、handle には効かせない（滑らかさ優先）。
- **pointerup**:
  - パス未作成なら `start=anchor` でパス作成、`lastOut=handle`。
  - 既存パスなら前アンカー `prev` からセグメントを push:
    - `lastOut` も `handle` も null → `{type:"line",to:anchor}`
    - どちらかあり → `{type:"cubic", c1: prev+(lastOut??0ベクトル), c2: anchor-(handle??0ベクトル), to:anchor}`
  - `lastOut=handle` に更新。
- **クリック（ドラッグなし）= コーナー点**。ドラッグ = スムーズ点（ハンドル対称）。
- **描画中の視覚**（SVG、screen-constant のヘアライン）:
  - ドラッグ中: アンカーを通る両方向のハンドル線（accent 色）+ 両端に r=3/scale の丸。
  - 非ドラッグ時のゴーストセグメント（現状の直線ゴースト）を **cubic 対応**に: `c1=prev+lastOut, c2=cursor, to=cursor` の曲線でプレビュー（lastOut が null なら直線のまま）。
- **close**: 開始点クリックで閉じる（現状どおり）。閉じセグメントも lastOut を c1 に使う。
- Enter/Esc の確定・破棄、1 点破棄ガードは現状維持（`pen.segments.length` 判定は新しい状態遷移でも成立させる）。
- ヒントバー（pen）: `クリックで角の点　ドラッグで曲線（ハンドルを引き出す）　Enter で確定`
- ツールチップ: `ペン (P)` → `ペン・曲線 (P)`。ラベルは「ペン」のまま。

テスト（headless で成立する範囲）: 状態遷移を関数に切り出せる場合は unit（`penSegmentFor(prev,lastOut,anchor,handle)` 純関数化を推奨: line/cubic の 4 通り）。

## B. グラフ挿入を desmos 式に（関数が先、図形は後）

現状: プロットツールはクリック即 `x^2` 入りのグラフを置く。→ **プレースホルダ関数を勝手に置かない**。

- 配置時の series を `{kind:"fn", expr:"", domain:null, samples:100, color:PLOT_PALETTE[0], thick:true, legend:"", visible:true}` に変更（`expr:""`）。
- **空の expr は「エラー」ではなく「未入力」**:
  - プレビュー: 軸・グリッドだけ描く。`式エラー` バッジを出さない（expr が空文字のときのみ。パース失敗は従来どおりエラー）。
  - previewSeries/plotPreviewCache が空 expr で例外を出さないこと。y 自動レンジは空 series を無視（全 series 空なら従来の既定レンジ）。
  - TikZ / .sty 出力: expr が空の fn series は**黙ってスキップ**（コメントも出さない。raw パススルーに空文字を渡さない）。全 series が空なら axis 環境だけ出す。
- カード（既存のインプレースカード）:
  - math-field の placeholder を `例: sin(x)`（テキストモードは `例: sin(deg(x))`）。既に focusIndex=0 でフォーカス＋全選択が入っているので、空なら単にフォーカス。
  - x 範囲行は現状カードにある。**式の直下に移動**し、ラベルを `x 範囲` にする（desmos の「範囲を指定して写し入れる」を一等地に）。y 自動はその隣（現状どおり）。
  - 空のまま **Esc / ✕ / カード外クリックで閉じたら、そのプロットオブジェクトを削除**（全 series の expr/points が空のときのみ）。undo スタックに空プロット配置の残骸を残さない（配置時の undo entry を pop するか、削除までを 1 手にまとめる）。
- 空状態ボタン「関数を描く」も同じフロー（クリック配置 → 空カード）。
- コーチ/ヒント: プロット選択時のヒントバー文言は現状維持。カードを開いた直後のヒントバーに `式を入力すると描画されます`（expr が全部空のときのみ。入力があれば従来の `式の入力中に / で分数…`）。
- validateScene: `expr:""` は既に string として通るはず。通らなければ受理する。

テスト: 空 expr series が TikZ / .sty 両方でスキップされ、axis 環境は出る / 空でない series は従来どおり / `sceneHasPlot` は空 series でも true（axis を出すので pgfplots は必要）。

## 実装順

B → A（B が小さく独立。A は pen の pointerdown/move/up の書き換えで衝突しやすいので後）。各段 tsc。

## 検証（Claude 側で実施）

- driver: ペンで「クリック・ドラッグ・クリック・ドラッグ」した path の segments が line/cubic 混在で、cubic の c1 が前アンカーからハンドル分離れている（=出ハンドルが効いている）/ ドラッグ中にハンドル線が見える / 1 点で Esc → 破棄。
- driver: プロット配置直後は軸のみ + エラーバッジなし → `sin(x)` 入力で曲線 / 空のまま Esc → オブジェクト 0 個 + undo 一発で何も残らない。
- 実コンパイル: 空 series 込みシーンの TikZ が pdflatex を通る。
