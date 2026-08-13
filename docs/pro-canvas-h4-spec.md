# Pro Canvas H4: グラフの数式 WYSIWYG 入力・系列種別・凡例・ナイス吸着

H3 の mathcha 型カードを土台に、監査で挙がった残ギャップ 4 点を実装する。

対象: `web-src/app/pro-canvas/`（plot-math.ts, 新規 plot-latex.ts, scene.ts, canvas-ui.ts, tikz-generate.ts, sty-export.ts）+ `Resources/web/theme.css` + tests。electron/ 不変。

制約（毎回同じ・厳守）: plain tsc / 新規 npm 依存なし / eval・new Function 禁止 / 生成 `Resources/web/**/*.js` 手編集禁止（theme.css は直接編集可）/ 既存の高密度 1 行スタイルに合わせる / 完了条件は `npx tsc -p web-src/tsconfig.json` 0 エラー + `node --test tests/*.test.cjs tests/*.test.mjs` 全 pass + 新規テスト。

H3 で確立したガードを壊さない: 動的 placeholder 入力の `data-no-i18n` / カード淡色化は `is-muted` / ドラッグ由来のシーン変更はメイン pointermove の分岐内 / ライブ編集 undo は初回 input で push + `flushWheelUndo`。

## A. plot-math の AST 化（前提リファクタ）

`compileExpr` を「AST を作る `parseExpr` + AST 評価」の 2 段に分解する（文法・度単位セマンティクスは現状維持、既存テストがそのまま通ること）。

```ts
export type ExprNode =
  | { k:"num"; v:number } | { k:"var" }            // var = その式の変数（x/t/θ を问わず1変数）
  | { k:"const"; name:"pi"|"e" }
  | { k:"bin"; op:"+"|"-"|"*"|"/"|"^"; a:ExprNode; b:ExprNode }
  | { k:"neg"; a:ExprNode }
  | { k:"call"; name:string; args:ExprNode[] };    // name は既存 functions のキー
export const parseExpr=(src:string):ExprNode|null;
export const compileAst=(ast:ExprNode):(x:number)=>number;   // 既存セマンティクス（trig は度）
export const compileExpr=(src:string)=>{const a=parseExpr(src);return a?compileAst(a):null;};  // 署名不変
export const astToPgf=(ast:ExprNode,varName:string):string;  // pgfplots 式へ直列化（変数名を差し替え可能に）
```

`astToPgf` は最小括弧で読みやすく（優先順位に応じて括弧、`^` 右結合、関数は `name(...)`）。

## B. LaTeX ↔ pgfplots 変換（新規 `plot-latex.ts`）

MathLive の LaTeX と pgfplots 式のサブセット双方向変換。**変換できないものは null を返して諦める**（その系列はテキストモードに固定されるだけで、機能は失われない）。

```ts
export const latexToExpr=(latex:string, varName?:string):string|null;  // 既定 varName="x"
export const exprToLatex=(expr:string, varName?:string):string|null;
```

- `latexToExpr` が受ける LaTeX サブセット: 数値 / 変数（varName と同名の 1 文字。`t` `x` など）/ `\pi` `e` / `+ - \cdot \times * /` / `^{...}` / `\frac{a}{b}` → `(a)/(b)` / `\sqrt{a}` → `sqrt(a)`、`\sqrt[n]{a}` → `(a)^(1/(n))` / `\left(...\right)` `(...)` / `\left|a\right|`・`|a|` → `abs(a)` / 関数 `\sin \cos \tan \arcsin \arccos \arctan \exp \ln \log`（`\log`→`log10`）/ **暗黙の乗算**（`2x`, `x\sin x`, `2\pi` に `*` を挿入）。
- **三角の単位規約**: LaTeX 側はラジアン意味論、pgfplots 側は度。`\sin(u)` → `sin(deg(u))`。逆三角は `\arcsin(u)` → `rad(asin(u))`。
- `exprToLatex` は逆写像: `sin(deg(u))` → `\sin\left(u\right)`、`rad(asin(u))` → `\arcsin\left(u\right)`、`(a)/(b)` 構造（AST の `/`）→ `\frac{a}{b}`、`^` → `^{...}`、`pi` → `\pi`、`sqrt(a)` → `\sqrt{a}`、`abs(a)` → `\left|a\right|`。**deg/rad の慣用形にならない裸の `sin(v)` 等は null**（テキストモード維持）。
- 実装は A の `parseExpr`/AST を使う（正規表現の文字列いじりで変換しない）。LaTeX 側パーサも再帰下降で書く（eval 禁止、`{}` 深さ管理）。

## C. 系列種別（scene.ts / canvas-ui.ts / 出力）

series を拡張（後方互換: `kind` 欠落 = `"fn"`）:

```ts
series: Array<{ kind?: "fn"|"parametric"|"polar"|"points";
  expr: string;            // fn: f(x) / parametric: x(t) / polar: r(θ)（変数は t として入力）
  expr2?: string;          // parametric の y(t)
  points?: string;         // points: "x y" or "x,y" per line
  domain: {min,max}|null;  // fn: x 範囲（null=xmin..xmax）/ parametric・polar: t 範囲（null=0..2π）
  ... 既存フィールド }>
```

- validateScene: kind は列挙のいずれかまたは undefined。parametric は expr2 必須（string）。points は points 必須。
- **プレビュー**: plot-math に `sampleParametric(fx,fy,min,max,samples):Vec[][]`（どちらか非有限で分割）。polar は `x=r(t)*cos(t), y=r(t)*sin(t)`（t ラジアン。プレビュー評価は AST を直接評価するので deg 慣用は不要 — r の式は fn と同じ度セマンティクスの pgf 式として `compileExpr` で評価し、t を代入）。points はパースして点列（マーカー円 r=2/scale、線は結ばない）。
- **TikZ / .sty 出力**（両エミッタ）:
  - fn: 現状どおり `\addplot[...] {expr};`
  - parametric: `\addplot[domain=<t範囲>, samples=n, <色>...] ({<astToPgf(expr,"x")>},{<astToPgf(expr2,"x")>});`（pgfplots の媒介変数は x が担う）
  - polar: parametric に展開 `({(<R>)*cos(deg(x))},{(<R>)*sin(deg(x))});` ここで `<R>=astToPgf(expr,"x")` を括弧で包む。domain 既定 0:6.28319。
  - points: `\addplot[only marks, mark=*, mark size=1.6pt, <色>] coordinates {(x,y) (x,y) ...};`（points パース失敗行は無視。0 点なら series 自体をスキップ）
  - parse 不能な expr の系列は**出力から除外**（コメント `% skipped invalid series` を 1 行）。
- **カード UI**: 系列行の ⋯ 詳細に「種類」select（関数 y=f(x) / 媒介変数 / 極座標 r(θ) / 点列）。
  - parametric: メイン行の式入力を `x(t)` `y(t)` の 2 段に（ラベル付き）。
  - polar: 1 入力、ラベル `r(θ)`（変数は t で入力させる。placeholder `例: 1+cos(deg(t))`）。
  - points: textarea（等幅、1 行 1 点）。凡例・色・太線は共通。samples は points では隠す。
  - 種類変更時は snapshot + カード再構築（`plotCardSignature=""`）。

## D. 式入力の MathLive WYSIWYG 化（canvas-ui.ts）

- `(window as any).MathLive?.MathfieldElement` があれば `customElements.define("math-field", ...)`（未定義時のみ、try で握る）。**サウンドは blocks/mathlive.ts の configureMathLiveAudio と同様に無効化**（soundsDirectory=null 等。既に他所で設定済みなら再設定しても無害）。
- 系列の式入力（fn の f(x) / parametric の x(t),y(t) / polar の r(θ)）は、`exprToLatex` が成功する場合 **math-field を既定表示**にする:
  - `mf.value = exprToLatex(expr)`、`input` イベントで `latexToExpr(mf.getValue("latex"), 変数名)` → 成功なら series 更新 + ライブ反映（liveField と同じ undo 規律: 初回 input で flushWheelUndo + push。液体化のため liveField を input 要素依存から `attachLive(target, getBefore→...)` に一般化してよい）。失敗なら赤枠 + 「式を解釈できません」でシーンは触らない。
  - 行に小さな `⌨` トグルボタン: math-field ⇄ 生テキスト input を切替（title「テキストで編集」/「数式で編集」）。`exprToLatex` が null の式は自動的にテキストモード固定（トグルは disabled + title で理由表示）。
  - MathLive が無い環境は現状のテキスト入力のまま（フォールバック）。
  - CSS: `.pro-canvas-plot-card math-field { width:100%; min-height:30px; font-size:14px; background:var(--panel); border:1px solid var(--panel-border); border-radius:5px; }`。仮想キーボードトグルは非表示（`math-virtual-keyboard-policy="manual"` を属性で設定）。
- Esc: math-field 内の Esc もカードを閉じる（カードの keydown 捕捉が math-field からのイベントでも効くこと。効かなければ mf に keydown リスナー追加）。

## E. 凡例プレビュー（canvas-ui.ts の plot 描画）

- legend 非空の系列が 1 つ以上あれば、プロット右上内側に凡例ボックスを描く: 白 rect（fill #ffffff, fill-opacity .85, ヘアライン枠 neutral）、各行 = 色線サンプル（長さ 10/scale、系列色・太さ反映、points 系列は線でなく丸マーカー）+ legend テキスト（9/scale、左寄せ、`fill:#334155`）。
- 行高 12/scale、パディング 4/scale。ボックス幅はテキスト長の概算（`legend.length*5.5/scale+22/scale`）。プロット矩形の clip はかけない（はみ出すほど長い場合はそのまま）。
- 出力側は従来どおり `\addlegendentry`（変更なし）。

## F. 範囲のナイスナンバー吸着（plot-math.ts + canvas-ui.ts）

```ts
export const snapRangeToNice=(min:number,max:number):{min:number,max:number};
```
- niceTicks と同じ 1/2/2.5/5×10^k 系列から目盛りステップ s を求め、`s/5` の格子に丸める。ただし**丸め量が窓幅の 2% を超える端は丸めない**（大ジャンプ防止）。
- 適用タイミングは**ホイールバースト終了時のみ**（wheelUndoTimer の発火時に xmin/xmax、y 手動なら ymin/ymax にも適用 → render）。ドラッグパン終了時と数値入力には適用しない。
- テスト: `snapRangeToNice(-3.10666,-0.737385)` が端数を吸着し幅がほぼ不変 / 既にナイスな範囲は不変 / 2% 制限が効くケース。

## テスト（`tests/pro-canvas-plot.test.mjs` 追記 or 新 `pro-canvas-plot-latex.test.mjs`）

- AST: `parseExpr("2*x^2")` → astToPgf 恒等（"2*x^2"）、`astToPgf(parseExpr("sin(deg(t))"),"x")==="sin(deg(x))"`（変数差替え）。
- latexToExpr: `\frac{1}{2}x^{2}` → `(1)/(2)*x^2` 相当（評価値で検証: compileExpr(結果)(2)===2）、`\sin\left(x\right)` → `sin(deg(x))`、`2\pi` → `2*pi`、`\log(x)` → `log10(x)`、未対応 `\int` → null。
- exprToLatex: `sin(deg(x))` → `\sin\left(x\right)`、`(x)^(2)`→`x^{2}` 形、`rad(asin(x))` → `\arcsin`、裸の `sin(x)` → null。**ラウンドトリップ**: expr→latex→expr が評価的に一致（x=0.7 で誤差 1e-9）。
- parametric/polar/points の generateTikz: `({...},{...})` 形式、polar の展開形、`coordinates {`、invalid 系列の除外。
- sampleParametric の分割。snapRangeToNice の 3 ケース。
- validateScene: kind/expr2/points の受理・拒否。

## 実装順の指定

A → B → C → F → E → D の順で、各段で tsc を通すこと。D（MathLive）は最後: 失敗しても A〜C/E/F が独立に成立する構成にする。
