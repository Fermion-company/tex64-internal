# Pro Canvas H: chrome 修正 + 直線選択 + pgfplots グラフツール

対象ブランチ: `pro-canvas-ux`。renderer のみ（`web-src/app/pro-canvas/` + `Resources/web/theme.css`）。electron/ は触らない。

制約（毎回同じ・厳守）:
- プレーン `tsc` 構成。バンドラ・新規 npm 依存を追加しない。`eval` / `new Function` 禁止。
- `Resources/web/**/*.js` は生成物なので手編集しない（CSS は `Resources/web/theme.css` を直接編集してよい）。
- 既存ファイルのコードスタイル（高密度・1行複文）に合わせる。
- 完了条件: `npx tsc -p web-src/tsconfig.json` がエラー 0、`node --test tests/` が全 pass、新規テストを追加していること。

---

## H1a: macOS トラフィックライトとの被り修正

現象: `.pro-canvas-overlay` が `position:fixed; inset:0` の全画面で、topbar 左端の「図キャンバス」タイトルが macOS の信号機ボタン（`titleBarStyle:"hiddenInset"`, `trafficLightPosition {x:12,y:8}`）と重なる。

修正（`Resources/web/theme.css`）:
- `.pro-canvas-topbar { padding-left: 84px; }`（信号機は x=12 起点で幅 ~54px。84px で安全にクリア）
- topbar をウィンドウドラッグ領域にする: `.pro-canvas-topbar { -webkit-app-region: drag; }` と `.pro-canvas-topbar button { -webkit-app-region: no-drag; }`（`.pro-canvas-zoom` / `.pro-canvas-segments` 内のボタンも no-drag が効くこと）。

## H1b: パス選択の見た目（斜め線が長方形になる問題）

現象: 選択枠が常に axis-aligned bbox の `rect`。斜めの直線を選択すると中身が空の大きな長方形が出て意味不明。

修正（`web-src/app/pro-canvas/canvas-ui.ts`）:
1. anchorEdit 分岐（render 内 ~L244）にインラインで書かれている path の `d` 文字列生成を helper `pathOutlineD(item)` に抽出。
2. 選択オブジェクトが `type==="path"` のとき、anchorEdit 中でなくても選択アウトラインは bbox rect ではなく `pathOutlineD` によるパス形状（class `pro-canvas-selection-outline`, fill:none）で描く。path 以外は従来どおり bbox rect。
3. ホバー表示（~L243、`pro-canvas-hover`）も path はパス形状で描く。他は bbox のまま。
4. **直線**（`type==="path" && !closed && segments.length===1 && segments[0].type==="line"`）が単独選択されたとき:
   - 8 個のリサイズハンドルと回転ステム/ハンドルを出さない。
   - 代わりに両端点に端点ハンドル（rect、既存 `.pro-canvas-anchor` 相当の見た目。class `pro-canvas-anchor` 再利用でよい）を出す。`dataset.anchorIndex = "0" / "1"` に加えて `dataset.pathId = item.id` を付ける。
   - pointerdown（select ツール分岐 ~L264）: `target.dataset.anchorIndex` があり、`anchorEdit` が無くても `target.dataset.pathId` があればそのパスに対して既存の `kind:"anchor"` ドラッグを開始する（既存のアンカードラッグ機構・グリッドスナップをそのまま再利用）。
   - 直線以外のパス（複数セグメント/閉パス/曲線）は従来どおり bbox ハンドル + 回転（アウトラインだけパス形状になる）。

## H2: グラフツール（pgfplots axis オブジェクト）

ユーザー決定: **pgfplots 方式**。axis 環境を 1 オブジェクトとしてキャンバスに配置し、キャンバス上は JS による近似描画、書き出しは書籍品質の pgfplots コード。

### Scene モデル（`scene.ts`）

`SceneObject` union に追加:

```ts
| { id: string; type: "plot"; at: Vec; width: number; height: number;
    axis: { xmin: number; xmax: number; ymin: number | null; ymax: number | null;
            axisLines: "box" | "middle" | "left"; grid: "none" | "major" | "both";
            xlabel: string; ylabel: string; title: string };
    series: Array<{ expr: string; domain: { min: number; max: number } | null;
                    samples: number; color: string; thick: boolean; legend: string }>;
    style: ObjStyle }
```

- `at` = 南西（左下）コーナー、scene 単位。`ymin/ymax` の `null` = 自動（サンプル値から算出）。`domain` の `null` = xmin..xmax。
- `validateScene` に plot の検査を追加（at が Vec、width/height が正の有限数、series が配列で各 expr が string 等）。
- 新規作成デフォルト: `axis: { xmin:-5, xmax:5, ymin:null, ymax:null, axisLines:"middle", grid:"none", xlabel:"", ylabel:"", title:"" }`, `series: [{ expr:"x^2", domain:null, samples:100, color:"#000000", thick:true, legend:"" }]`, `style:{}`。
- `sceneHasPlot(scene): boolean` を export（symbols 内・group 再帰込み）。

### 式評価モジュール（新規 `web-src/app/pro-canvas/plot-math.ts`）

pgfplots (pgf math) 互換サブセットの再帰下降パーサ。**eval 禁止**。

- `compileExpr(src: string): ((x: number) => number) | null` — パース失敗は null。
  - 文法: `expr := term (('+'|'-') term)*` / `term := factor (('*'|'/') factor)*` / `factor := unary ('^' factor)?`（右結合）/ `unary := '-' unary | primary` / `primary := number | 'x' | 'pi' | 'e' | ident '(' expr (',' expr)* ')' | '(' expr ')'`。
  - 関数: `sin cos tan`（**引数は度**。pgfplots 準拠、`sin(deg(x))` イディオムが正しく動くこと）、`asin acos atan`（**度を返す**）、`sqrt abs exp ln log10 log2 floor ceil round deg rad min max mod`（min/max/mod は 2 引数）。定数 `pi`, `e`。
  - 暗黙の乗算はサポートしない（pgfplots 同様 `2*x` と書かせる）。未知識別子・構文エラーは null。
- `samplePlot(fn, min, max, samples): Vec[][]` — 等間隔サンプル。`!isFinite(y) || Math.abs(y) > 1e6` で折れ線を分割（`1/x` が縦線にならないこと）。
- `niceTicks(min, max, target = 5): number[]` — 1/2/2.5/5×10^k の nice step。
- `autoRange(ys: number[]): { min: number; max: number }` — 5% パディング、空/退化時は `{min:-1,max:1}`。

### キャンバス近似描画（`canvas-ui.ts` renderObject）

`<g data-id=...>` 内に描画（既存 rect/node と同じ座標規約に従うこと。SVG 側の y 反転の扱いは既存コードを踏襲）:
- 軸: `axisLines` に応じて box（枠 rect）/ middle（x=0, y=0 を通る軸線。範囲内にクランプ）/ left（左辺+下辺）。線は細いニュートラル色。
- `grid !== "none"` のとき `niceTicks` 位置に薄いグリッド線。目盛りマークと数値ラベル（小さい text）を x/y に描く。
- 各 series: `compileExpr` → `samplePlot` → データ座標 `[xmin..xmax]×[ymin..ymax]`（auto は全 series のサンプルから `autoRange`）をプロット矩形 `at..at+width/height` へ線形写像した polyline。`clipPath` でプロット矩形にクリップ。色は series.color、`thick` は線幅増。
- expr パース失敗時: 枠 + 赤字で `式エラー` を表示（クラッシュしない）。
- 全面に透明のヒット用 rect（既存の hit-stroke パターンに倣う）を置き、クリック選択・移動を可能に。

### ツール（`canvas-ui.ts`）

- `Tool` union に `"plot"` 追加。レールに `['plot','グラフ','G']` を追加、`onToolKey` に `g` を追加。アイコンは 16×16 で軸+曲線（例: `<path d="M3 2v11h11"/><path d="M4 12c2.5-7 5 1 9-7"/>`）。
- ドラッグで rect と同様に配置（drag.kind "draw"）。pointerup で幅/高さを正規化し最小 5×5 units にクランプ。作成後は選択状態に。
- 移動/リサイズ: `allPoints`/`moveObject` は `at` を動かす。`resizeObject` は bounds 写像で `at`/`width`/`height` を更新。`objectBounds` は `at .. at+width/height`。回転は非対応（rotate ハンドルを plot 単独選択時は出さない。group 化した場合は既存挙動のまま）。

### インスペクタ（`canvas-ui.ts`）

`object.type==="plot"` のとき、スタイル欄の通常フィールド（線色/塗り等）の代わりに専用 UI:
- 軸セクション: xmin / xmax（number）、ymin / ymax（number、**空欄 = 自動**。空文字で null に戻せること）、軸線 select（box/middle/left 表示は「枠/中央/左下」）、グリッド select（なし/主/主+副）、xlabel / ylabel / title（text、LaTeX そのまま）。
- 系列セクション: series ごとに 1 行 — expr（text）、色（color input）、samples（number）、legend（text）、削除ボタン。下に「＋系列を追加」。domain はデフォルト null のままで UI は expr 行の隣に min/max 2 つの小 number 入力（空欄 = 自動）。
- 全編集は既存パターン踏襲: `snapshot()` → 変更 → `render()`（compile 無効化/再スケジュールは既存のスタイル編集と同じ経路に乗せる）。

### TikZ 生成（`tikz-generate.ts` / `sty-export.ts`）

plot オブジェクトのエミット（両ファイル。既存の色 helper — xcolor 基本色名 or `\definecolor{t64RRGGBB}` — と `num()` 丸めを再利用）:

```
\begin{axis}[at={(<x>,<y>)}, anchor=south west, width=<width><unit>, height=<height><unit>,
  xmin=..., xmax=...(, ymin=..., ymax=... は non-null 時のみ)
  (, axis lines=middle|left は box 以外のとき), (, grid=major|both は none 以外のとき)
  (, xlabel={...}, ylabel={...}, title={...} は非空のとき)]
\addplot[domain=<min>:<max>, samples=<n>, <色>, (thick)] {<expr>};
(\addlegendentry{<legend>} は legend 非空のとき)
\end{axis}
```

- `<unit>` は `scene.unit`（mm/cm/pt）。`at` は tikzpicture 座標なので単位なし数値ペア。
- expr / ラベル / legend は verbatim パススルー（エスケープしない。ユーザーは LaTeX を書く）。
- `sceneHasPlot(scene)` が真のとき:
  - `generateTikz` 出力の先頭コメントに `% requires: \usepackage{pgfplots} \pgfplotsset{compat=1.18}` を 1 行追加。
  - `buildStandaloneDoc`（`standalone.ts`）のプリアンブルに `\usepackage{pgfplots}` + `\pgfplotsset{compat=1.18}` を追加（plot が無いシーンでは追加しない。options.preamble に既に `pgfplots` が含まれる場合は重複させない）。

### テスト（新規 `tests/pro-canvas-plot.test.mjs`）

既存テスト同様 `Resources/web/app/pro-canvas/*.js`（tsc 生成物）から import:
- `compileExpr("x^2")(3) === 9`、`compileExpr("sin(90)")(0) ≈ 1`（度）、`compileExpr("sin(deg(x))")(Math.PI/2) ≈ 1`、`-x^2` が `-(x^2)`、`2^3^2 === 512`（右結合）、`compileExpr("x++")` と `compileExpr("foo(x)")` が null。
- `samplePlot` : `1/x` を [-1,1] でサンプルすると 2 ピース以上に分割される。
- `niceTicks(-5,5)` が 0 を含み step が nice 値。
- plot 入り scene の `generateTikz`: `\begin{axis}[` / `domain=-5:5` / `samples=100` / `{x^2};` / `\end{axis}` / requires コメントを含む。ymin/ymax null なら `ymin=` を含まない。legend 指定時 `\addlegendentry` を含む。
- `buildStandaloneDoc`: plot ありで `\usepackage{pgfplots}` を含み、plot なしで含まない。
- `validateScene`: 正常な plot を通し、`width:-1` や `series` 非配列を弾く。
