# Pro Canvas H6: スタイリング UX — 塗り/編みかけ/グラデ/色決め・矢印第一級化・選択メニュー消失の修正

ユーザー指摘 3 点への対応:
1. 「数学/物理の作図は直線に矢印を付けて描くのが主。今の UI ではそれがわかりにくい」
2. 「オブジェクトを選択してもメニューが消えるバグ」（実測で確定: **複数選択**でスタイルセクションが `hidden`、**グループ選択**で "Group geometry" の一行のみ）
3. 「編みかけ・塗りつぶし・グラデーション・色決めくらいは超簡単にできないと」

対象: `web-src/app/pro-canvas/`（scene.ts, canvas-ui.ts, tikz-generate.ts, sty-export.ts）+ `Resources/web/theme.css` + tests。electron/ 不変。

制約（毎回同じ・厳守）: plain tsc / 新規 npm 依存なし / eval・new Function 禁止 / 生成 `Resources/web/**/*.js` 手編集禁止（theme.css は直接編集可）/ 既存の高密度 1 行スタイルに合わせる / 完了条件は `npx tsc -p web-src/tsconfig.json` 0 エラー + `node --test tests/*.test.cjs tests/*.test.mjs` 全 pass + 新規テスト。

既存ガードを壊さない: 動的 placeholder/title 入力には `data-no-i18n` / ドラッグ由来のシーン変更はメイン pointermove の分岐内 / ライブ編集 undo は初回 input で push + `flushWheelUndo` / TikZ エミッタは `tikz-generate.ts` と `sty-export.ts` の**両方**を必ず同時に更新（重複実装が現存する）。

## A. scene.ts — モデル拡張

```ts
export type PatternName = "horizontal lines"|"vertical lines"|"north east lines"|"north west lines"|"grid"|"crosshatch"|"dots"|"crosshatch dots";
export type StyleProps = { ...既存,
  pattern?: { name: PatternName; color?: string } | null;     // 編みかけ
  shading?: { kind: "axis"; top: string; bottom: string; angle?: number }  // グラデ（線形）
          | { kind: "radial"; inner: string; outer: string } | null;
};
```

- `DEFAULT_STYLE` に `pattern: null, shading: null` を追加（`Required<StyleProps>` を満たす）。
- validateScene: pattern.name は列挙のみ、color は string 任意。shading は kind 判別で必須キー検査、angle は有限数のみ。不正は reject。
- 意味論: `shading` があれば塗りはグラデ（fill は無視）。なければ `pattern`（`fill` と併用可 = 下地色の上にパターン）。どちらも無ければ従来どおり `fill`。

## B. TikZ 出力（tikz-generate.ts と sty-export.ts の両方）

`styleKeys` に追記:

- pattern: `pattern=<name>`、color があれば `pattern color=<colorName(color)>`。使ったら `patternsUsed=true` → `requires` に `patterns` ライブラリ（arrows.meta と同じ機構で `\usetikzlibrary{patterns}` / .sty 側は `\usetikzlibrary` 相当箇所）。fill 併用時は fill も従来どおり出す（fill が先）。
- shading axis: `shade, top color=<top>, bottom color=<bottom>` + angle 指定時 `shading angle=<angle>`（0 は省略）。radial: `shade, inner color=<inner>, outer color=<outer>`。shading 時は fill を出さない。`command()` の filldraw 判定: shading/pattern がある場合も「塗りあり」として扱う（`draw` と併存 OK: `\draw[shade, top color=...]`… ではなく従来どおり fill/filldraw/draw 選択のうえ options に shade を足す。`fill` コマンド + `shade` は不可なので、**shading 時のコマンドは draw が null なら `\shade`、draw ありなら `\draw[shade,...]`** とする）。
- round-trip: codec は scene JSON を埋めるだけなので追加作業なし（既存テストが通ること）。

## C. canvas-ui.ts — SVG プレビュー

1. **矢印マーカー**: `path` オブジェクトで `arrowStart/arrowEnd` が非空なら、端点に多角形を直接描く（`<marker>` は使わない — ズーム変換と非等方 scale で壊れやすい）。
   - 端の接線: line セグメントは方向ベクトル、cubic は端点の導関数（`to - c2` / `c1 - start`）。ゼロベクトルなら隣の点で代替。
   - 形状（線幅 lw から算出、TikZ 近似で十分）: Stealth = 凹み付き三角（長さ 4.5*lw+1.5、幅 3*lw+1、凹み 30%）、Latex = 三角（長さ 4*lw+1.2、幅 3.6*lw+1.2）、Bar = 線に垂直な線分（長さ 3*lw+1、stroke=lw）。fill は線色。
   - プレビューは重ね描きのみで線の短縮はしない（コンパイル結果が真）。
2. **パターン塗り**: `<defs>` に per-render で必要なぶんだけ `<pattern>` を生成（id は `pcpat-<name>-<color6桁>` で重複回避、patternUnits="userSpaceOnUse"、タイル 1.6 scene 単位、線幅 0.15、45°系は patternTransform="rotate(±45)"）。dots は r=0.18 の円。fill 併用時は fill の rect の上にパターンの rect を重ねるのではなく、**fill 属性にパターン URL を使う要素をもう 1 枚重ねる**（path/rect/ellipse 共通の描画関数内で分岐）。
3. **グラデ塗り**: `<linearGradient>`（axis、gradientTransform で angle 回転。TikZ の shading angle=0 は「上→下」なので SVG は y 軸向きに合わせる）/ `<radialGradient>`（radial）。id 規約は pattern と同様。
4. plot 以外の全 stylable（path/rect/ellipse/instance/repeat）で機能すること。

## D. canvas-ui.ts — インスペクタ全面改修（メニュー消失の修正込み）

### D1. 表示条件のバグ修正

- `style-section` の表示条件を `styleObjects.length > 0` に変更（複数選択でも出す）。グループ単体選択時は**グループの stylable 子孫**（再帰収集、code/plot を除く）を編集対象にする。
- 編集対象リスト `targets: SceneObject[]`（stylable のみ）。表示値は先頭 target の effective style。**変更はすべての targets の `style.props` に適用**（1 スナップショットで一括、その後 render + scheduleCompile）。
- 複数選択時はセクション見出し横に `${targets.length} 個に適用` の小さいバッジを出す。
- plot 単体選択は現状どおりヒント（グラフはカードで編集）。code 単体も現状どおり。

### D2. 新しいスタイルパネル構成（上から順）

1. **線** 行: カラーウェル（後述）+ 線幅 number(step 0.2, min 0) + 破線セグメント [実線|破線|点線]（アイコンは 16x16 SVG の線サンプル）。
2. **矢印** 行（targets に path が 1 つでも含まれる時のみ表示）: セグメント 4 択 `[—][→][←][↔]`（アイコンも線+矢頭の SVG）+ 矢頭形状 select（Stealth/Latex/Bar、既定 Stealth）。
   - `—` = start/end 両方 "", `→` = end のみ, `←` = start のみ, `↔` = 両方。適用時の矢頭は形状 select の現在値。
   - 現在状態の判定は先頭 path target の arrowStart/arrowEnd。
3. **塗り** セグメント `[なし][単色][編みかけ][グラデ]` + 直下にコンテキスト UI:
   - 単色: カラーウェル。
   - 編みかけ: **8 パターンの視覚グリッド**（各ボタン 34x26px、SVG でそのパターンの実描画サンプル、title=名称、選択中は accent 枠）+ パターン色のカラーウェル + 「下地色」カラーウェル（なしチェック付き、= fill 併用）。
   - グラデ: 種別トグル [線形|放射] + カラーウェル 2 個（上/下 or 内/外）+ 線形のみ角度セグメント [0°|45°|90°|135°]。
   - セグメント切替時: なし→ fill=null,pattern=null,shading=null / 単色→ shading=null,pattern=null, fill が null なら "#dbeafe" / 編みかけ→ shading=null, pattern が null なら {name:"north east lines"} / グラデ→ pattern=null, shading が null なら {kind:"axis",top:"#93c5fd",bottom:"#1d4ed8"}。
4. **詳細** `<details>`: 不透明度 / 角丸 / 二重罫 / cap / join / 始点・終点矢印の個別 select（従来のフル制御）。

既存の「線色/塗り色 + フィールド列挙」UI は撤去（機能は上記に全部吸収されること）。

### D3. カラーウェル（共通部品・色決めを超簡単に）

```ts
const colorWell=(label:string,get:()=>string|null,set:(v:string|null)=>void,allowNone:boolean):HTMLElement
```

- 見た目: 22x22 の丸スウォッチボタン（現在色。null は赤斜線の白）。クリックでポップオーバー（position: fixed、ボタン直下、外側クリック/Esc で閉じる。plot カードと同様に card 側で pointerdown stopPropagation）。
- ポップオーバー内容: **プリセット 16 色**のグリッド（黒 #000000, 白 #ffffff, グレー #6b7280, 赤 #dc2626, 橙 #ea580c, 黄 #eab308, 緑 #16a34a, 青 #2563eb, 藍 #4f46e5, 紫 #9333ea, 桃 #ec4899, 茶 #92400e, 水 #0891b2, 黄緑 #65a30d, 灰青 #64748b, 紺 #1e3a8a）+ **最近使った色**（localStorage `tex64.proCanvas.recentColors.v1`、最大 8、選択時に先頭へ）+ `<input type="color">`（ネイティブピッカー、Chromium はスポイト内蔵）+ allowNone 時「なし」ボタン。
- 選択即適用（snapshot 1 回 + render + scheduleCompile）、ポップオーバーは閉じない（連続試行できる）。ポップオーバーは overlay 直下に 1 個だけ（開き直しで前のを閉じる）。

### D4. i18n / スタイル

- 動的 title/placeholder には全て `data-no-i18n`。
- theme.css: `.pro-canvas-color-well` `.pro-canvas-color-pop` `.pro-canvas-pattern-grid` `.pro-canvas-fill-seg` 等。ダーク前提の既存 pro-canvas パレットに合わせ、ポップオーバーは `.pro-canvas-plot-card` と同系の不透明背景 + border + shadow。セグメントは既存 `.pro-canvas-segments` を再利用。

## E. テスト（tests/pro-canvas-style.test.mjs 新規）

- validateScene: pattern/shading の受理・拒否（不正 name、angle=Infinity、radial に top を混ぜる等）。
- generateTikz: pattern → `pattern=north east lines` + `\usetikzlibrary{...patterns...}` が出る / pattern color / fill 併用で fill が先 / shading axis → `\draw[...shade, top color=..., bottom color=..., shading angle=45...]` / draw=null + shading → `\shade[...]` / radial → inner/outer。sty-export も同равные ассерト（両エミッタ）。
- 矢印: 既存挙動の回帰（`{Stealth}-` 形式）が壊れないこと。

## 実装順

A → B（+テスト E）→ C → D の順で、各段 tsc を通す。D はサブ節ごとに小さく（D1 のバグ修正だけでも独立で成立する）。

## 検証（Claude 側で実施）

- driver: 複数選択でスタイルセクションが出る / 矢印セグメント → SVG に矢頭 polygon が現れ TikZ に `-{Stealth}` / パターングリッド選択 → defs に pattern / カラーウェルポップオーバーの開閉。
- 実コンパイル: pattern と shade を含むシーンが latexmk を通ること。
