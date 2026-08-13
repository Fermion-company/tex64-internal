# Pro Canvas H3: グラフ UX の mathcha 型全面改修

H2 で入れた plot オブジェクトの**編集体験を作り直す**。現状の問題（ユーザーフィードバック「マジで使いにくい」）:

- インスペクタの系列行が無ラベル入力 7 個の羅列で、どれが式でどれが domain か判別不能。
- 範囲変更が xmin/xmax の数値打ち込みのみ。直接操作（ホイール/ドラッグ）が無い。
- onchange 頼みでライブ感が無い。
- デフォルト（黒一色・グリッドなし）が地味。目盛りの 0 が二重に出る。

目標は mathcha の Plot 2D: **プロットの上で直接操作**し、**関数リストはその場に浮かぶカード**で編集、**打鍵ごとに即時反映**。

対象: `web-src/app/pro-canvas/`（canvas-ui.ts, plot-math.ts, scene.ts, tikz-generate.ts, sty-export.ts）+ `Resources/web/theme.css` + tests。electron/ 不変。制約は毎回同じ: plain tsc・新規依存なし・eval 禁止・生成 .js を手編集しない・`npx tsc -p web-src/tsconfig.json` 0 エラー・`node --test tests/*.test.cjs tests/*.test.mjs` 全 pass。

## 1. Scene モデル（小変更のみ）

- series に `visible: boolean` を追加（既存データは undefined → true 扱い。validateScene は boolean または undefined を許容）。
- 非表示 series は **TikZ/.sty 出力から除外**（tikz-generate.ts / sty-export.ts）。全 series 非表示でも axis 環境自体は出す。
- 新規プロットのデフォルトを見栄え重視に変更: `grid:"major"`, series 1 本目 `{expr:"x^2", color:PALETTE[0], thick:true, visible:true, ...}`。

## 2. 配色パレット（plot-math.ts）

```ts
export const PLOT_PALETTE = ["#2563eb","#dc2626","#059669","#9333ea","#ea580c","#0891b2"];
```
「＋関数を追加」は `PLOT_PALETTE[series.length % PLOT_PALETTE.length]` を自動割当（黒固定をやめる）。

## 3. 範囲直接操作のヘルパー（plot-math.ts、純関数 + テスト）

```ts
export const zoomRange = (min:number, max:number, focusT:number, factor:number): {min:number,max:number}
// focusT∈[0,1]（窓内の焦点位置）。焦点のデータ座標を固定して幅を factor 倍。
// 結果の幅は [1e-6, 1e9] にクランプ。
export const panRange = (min:number, max:number, deltaT:number): {min:number,max:number}
// deltaT = 移動量/窓幅。min/max を同量シフト。
```

## 4. プロット編集モード（canvas-ui.ts）

状態 `plotEdit: { id: string } | null` を追加。

**入る**: select ツールでプロットを**ダブルクリック**（既存の pointerup ベース dblclick 検出 `activateForEdit` に plot 分岐を追加）。
**出る**: `Esc`（anchorEdit と同様、最優先で処理しキャンバスは閉じない）／プロットとカードの外側をクリック／キャンバス閉鎖。抜けたら `scheduleCompile()`。

編集モード中:
- プロット枠を強調表示（アクセント色の枠線）。
- **ホイール（プロット矩形上）**: 数学窓のズーム。`zoomRange(xmin,xmax, cursorTx, exp(deltaY*.002))` を x に適用。ymin/ymax が手動（非 null）のときは y にも `cursorTy` で適用。**キャンバスのズーム/パンより優先**（既存 wheel リスナーの先頭で plotEdit && カーソルがプロット矩形内なら横取り）。y 自動のときは x のみ。
- **ドラッグ（プロット矩形内）**: 数学窓のパン（`panRange`、x は常時、y は手動時のみ）。オブジェクト移動は発火させない（プロット矩形外のドラッグ＝通常挙動のまま。リサイズハンドルも通常どおり効く）。
- ライブ反映: 操作中は `render()` のみ、pointerup/ホイール静止 400ms で `scheduleCompile()`。
- undo: ホイール連続操作は 600ms 途切れで 1 スナップショット、ドラッグは pointerdown 時に 1 スナップショット。

## 5. 関数カード（インプレース編集 UI）

plotEdit 中、overlay 直下に `div.pro-canvas-plot-card`（nodeEditor と同じ絶対配置パターン）を表示。位置はプロットのスクリーン bbox 右横（右に 260px 入らなければ左、それも無理なら下）。render 時に再配置。カード内クリックは選択解除に波及させない。

構成（上から）:
1. **関数リスト** — 1 series = 1 行:
   - 色チップ（丸）: クリックで `<input type="color">` を開く（chip が label で input は視覚的に隠す）。
   - 式入力: 幅広・等幅フォント・`placeholder="例: sin(deg(x))"`。**input イベントで即時反映**（下記 7）。`compileExpr` が null のとき行の下に赤字 1 行「式を解釈できません」＋入力枠を赤に。
   - 目のトグル（visible）: SVG アイコン、off で行を淡色化。
   - `⋯` ボタン: 行下に詳細（domain min/max・samples・legend・太線チェック。**各入力に text ラベル付き**）を開閉。
   - `×` 削除（series 1 本なら disabled）。
2. **「＋ 関数を追加」** — パレット次色で追加、追加後すぐ式入力にフォーカス。
3. **範囲行** — `x: [xmin] 〜 [xmax]`、`y: [ymin] 〜 [ymax] [自動✓]`。自動チェック ON で ymin/ymax null + 入力 disabled（表示は現在の自動値をプレースホルダで見せる）。ヒント文 1 行:「プロット上: スクロールでズーム / ドラッグで移動」。
4. **表示行** — 軸線セグメント（枠/中央/左下）・グリッドセグメント（なし/主/主+副）を既存 `.pro-canvas-segments` 風の小型セグメントで。
5. **詳細（開閉）** — xlabel / ylabel / title（text、ラベル付き）。

**インスペクタ側**: object.type==="plot" の現行 UI（軸/系列の羅列）は**全部撤去**し、「ダブルクリックでグラフを編集」のヒント 1 行だけにする（配置 X/Y/W/H・整列・重なり順は汎用部なのでそのまま残る）。

CSS: `.pro-canvas-plot-card`（幅 ~260px、`z-index` は nodeEditor と同層、パネル色背景・角丸・影）。行レイアウトは flex。**全入力にラベルまたは title を付け、無ラベル入力を残さない**。

## 6. 目盛り・描画の磨き（canvas-ui.ts の plot 描画）

- `axisLines:"middle"` のとき値 0 の目盛りラベルを x/y とも**スキップ**（0 の二重表示をやめる）。原点には小さく 1 個だけ `0` をオフセット表示（axisX-1, axisY-1.6 付近、anchor end）。
- middle の軸線に**矢印の先端**（小さな polygon、pgfplots の `axis lines=middle` は実出力も矢印付き）。
- x 目盛りラベルは軸線の下側、y はラベル右端を軸から 0.8 離す（現状の被り解消）。box/left モードではラベルを枠の外側に。
- ラベル文字は `Number(value.toPrecision(4))` 表記（`0.30000000000000004` を出さない）。
- 非表示 series は近似描画もスキップ。
- 式エラー時の赤字「式エラー」表示は維持。

## 7. ライブ編集の undo 規律（カード内全入力共通）

- `focus` 時に `before = cloneScene(scene)` を保持。
- `input` で対象値を直接 mutate → `render()`（compile は 400ms デバウンスで `scheduleCompile()`）。
- `change`（または blur）で最初の値から変わっていれば `undo.push(before); redo=[];`（既存 snapshot() は使わず、この 3 段パターンを小 helper `liveField(...)` にまとめて全入力に適用）。

## 8. テスト（tests/pro-canvas-plot.test.mjs に追記 or 新ファイル）

- `zoomRange(0,10,0.5,0.5)` → {2.5,7.5}／`zoomRange(0,10,0,2)` → {0,20}（焦点固定）／幅クランプ。
- `panRange(0,10,0.1)` → {1,11}。
- `PLOT_PALETTE` が 6 色。
- `visible:false` の series が generateTikz / buildStyFile 出力に現れない（axis 環境は残る）。
- validateScene: `visible:undefined` と `visible:true` を許容、`visible:"yes"` を拒否。

## 実装メモ

- カードは render() 内で作り直さず**保持**して値だけ同期（input のフォーカスを失わせない。nodeEditor と同じ理由）。系列の増減時のみ再構築。
- 既存の「dblclick は native でなく pointerup 検出」の理由（render() が DOM を差し替える）はカードにも当てはまる。カード再配置は `requestAnimationFrame`。
- wheel 横取りは `{passive:false}` 必須（既存リスナーが該当）。
