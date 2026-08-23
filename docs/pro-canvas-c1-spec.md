# Pro 作図キャンバス C1 実装仕様

pro-mode-design.md の「機能 6」C1 フェーズの実装仕様。実装は 2 ランに分割する。

- **Run 1（純ロジック）**: シーンモデル + TikZ 生成器 + round-trip codec + node:test
- **Run 2（UI + 配線）**: キャンバスエディタ UI、挿入/再編集/PNG エクスポート、index.html/theme.css/main-init/monaco 配線

共通規約: renderer は `web-src/`（plain tsc、ES modules、バンドラなし）。`Resources/web/**/*.js`
は生成物で手編集禁止。`Resources/web/index.html` と `Resources/web/theme.css` は手編集対象。
テストは `node --test tests/` で、コンパイル済み `../Resources/web/app/pro-canvas/*.js` を import
する（既存 `tests/image-insert-utils.test.mjs` と同じ方式）。型チェックは
`tsc -p web-src/tsconfig.json`。

---

## Run 1: 純ロジック層

新規ディレクトリ `web-src/app/pro-canvas/` に 3 モジュール。**DOM に依存しない**（node:test で
そのまま実行できること）。

### 1. `scene.ts` — シーンモデル

```ts
export type Vec = { x: number; y: number };
// 座標系は y 上向き（TikZ ネイティブ）。UI 側で画面座標に変換する。

export type Transform = { tx: number; ty: number; rotate: number; sx: number; sy: number };
// rotate は度。identity = {tx:0,ty:0,rotate:0,sx:1,sy:1}

export type StyleProps = {
  draw?: string | null;        // 線色。hex "#rrggbb" or null（線なし）
  fill?: string | null;        // 塗り色。同上
  lineWidthPt?: number;        // 既定 0.4
  dash?: "solid" | "dashed" | "dotted";
  opacity?: number;            // 0..1、既定 1
  arrowStart?: "" | "Stealth" | "Latex" | "Bar";
  arrowEnd?: "" | "Stealth" | "Latex" | "Bar";
  cap?: "butt" | "round" | "rect";
  join?: "miter" | "round" | "bevel";
  roundedCornersPt?: number;   // rect/path 用。0 = なし
};

export type ObjStyle = { ref?: string; props?: StyleProps };
// ref = 名前付きスタイル参照。props は個別上書き。

export type PathSeg =
  | { type: "line"; to: Vec }
  | { type: "cubic"; c1: Vec; c2: Vec; to: Vec };

export type NodeAnchor = "center" | "north" | "south" | "east" | "west"
  | "north east" | "north west" | "south east" | "south west";

export type SceneObject =
  | { id: string; type: "path"; start: Vec; segments: PathSeg[]; closed: boolean; style: ObjStyle }
  | { id: string; type: "rect"; from: Vec; to: Vec; style: ObjStyle }
  | { id: string; type: "ellipse"; center: Vec; rx: number; ry: number; style: ObjStyle }
  | { id: string; type: "node"; at: Vec; latex: string; anchor: NodeAnchor; style: ObjStyle }
  | { id: string; type: "group"; children: SceneObject[]; transform: Transform };

export type Scene = {
  v: 1;
  unit: "mm" | "cm" | "pt";
  width: number;   // 論理キャンバスサイズ（unit 単位）
  height: number;
  grid: { size: number; snap: boolean };
  styles: Array<{ name: string; props: StyleProps }>;  // name は TikZ 識別子（英字のみ）
  objects: SceneObject[];
};
```

エクスポートする関数:

- `createEmptyScene(): Scene` — 既定: unit "mm", 100×100, grid {size:5, snap:true}, styles [], objects []
- `newObjectId(): string` — 短い一意 id（例 base36 カウンタ + ランダム）
- `cloneScene(scene: Scene): Scene` — 深い複製（undo スナップショット用）
- `resolveStyle(scene: Scene, style: ObjStyle): StyleProps` — ref を解決し props で上書きした実効スタイル
- `validateScene(value: unknown): Scene | null` — decode 用の防御的検証（v!==1 や不正型は null）

### 2. `tikz-generate.ts` — シーン → TikZ

`export const generateTikz = (scene: Scene): { code: string; requires: string[] }`

`code` は `\begin{tikzpicture}...\end{tikzpicture}` の完全な断片（埋め込みコメントは含まない。
それは codec の仕事）。`requires` は必要な TikZ ライブラリ名（例 `["arrows.meta"]`。矢印を
使ったときのみ）。

生成規則（**「プロが手書きしたのと同じ」コードを保つ。ここがこの機能の品質バー**）:

1. **座標**: 小数 3 桁に丸め、末尾ゼロと不要な小数点は削る（`3.000` → `3`、`1.250` → `1.25`）。
2. **単位**: unit が cm なら素の座標（TikZ 既定）。mm / pt なら picture オプションに
   `x=1mm,y=1mm`（pt も同様）を入れ、座標は素の数値。
3. **色**: 黒 `#000000`・白 `#ffffff`・純色（red/green/blue 等 xcolor 基本色に一致する hex）は
   その名前を使う。それ以外の hex は `\definecolor{t64RRGGBB}{HTML}{RRGGBB}` を tikzpicture の
   **直前**にまとめて出し（重複なし・出現順）、名前で参照する。
4. **名前付きスタイル**: `\begin{tikzpicture}[mystyle/.style={...}, ...]` と picture オプションで
   定義。オブジェクトは `\draw[mystyle]` / `\draw[mystyle, 上書きキー]` で参照。
5. **スタイル → TikZ キーのマップ**:
   - draw 色 → `draw=色`（\draw では線がある場合のみ明示不要なら省略。ただし named style 内では明示）
   - fill → `fill=色`
   - lineWidthPt → `line width=Xpt`（0.4 = 既定のときは省略）
   - dash → `dashed` / `dotted`（solid は省略）
   - opacity < 1 → `opacity=X`
   - 矢印 → `-{Stealth}` / `{Stealth}-` / `{Stealth}-{Latex}` 形式（arrows.meta 記法）。
     両方空なら省略。使ったら requires に `arrows.meta`。
   - cap/join → `line cap=round` 等（既定 butt/miter は省略）
   - roundedCornersPt > 0 → `rounded corners=Xpt`
6. **コマンド選択**: fill のみ → `\fill[...]`、draw のみ → `\draw[...]`、両方 → `\filldraw[...]`。
   node は `\node[anchor=..., 色等] at (x,y) {latex};`（anchor=center は省略）。
7. **図形**:
   - rect → `\draw (x1,y1) rectangle (x2,y2);`
   - ellipse → rx===ry なら `circle [radius=r]`、それ以外 `ellipse [x radius=rx, y radius=ry]`
   - path → `(start) -- (p1) .. controls (c1) and (c2) .. (p2) ...`、closed なら末尾 ` -- cycle`
     （最終セグメントが cubic で closed の場合も ` -- cycle`）。長いパスは 1 行 100 桁を目安に
     `  ` インデント付きで折り返す。
8. **group** → `\begin{scope}[shift={(tx,ty)}, rotate=R, xscale=Sx, yscale=Sy]`。identity 成分は
   キーごと省略（すべて identity なら scope 自体は出すがオプションなし…ではなく、**すべて
   identity なら scope を出さず子をそのまま並べる**）。scale が sx===sy なら `scale=S` 1 キー。
9. インデントは 2 スペース。1 オブジェクト 1 文（`;` 終わり）。
10. requires が空でないとき、code の先頭（\begin の前の行）に
    `% requires \usetikzlibrary{arrows.meta}` の形の**通常コメント 1 行**を付ける
    （プリアンブルには介入しない。ユーザーへの注意書き）。

### 3. `figure-codec.ts` — round-trip codec

図ブロックのフォーマット（ドキュメント内での完全な形）:

```
%% tex64-figure v1 h=<hash>
%% tex64-figure+ <base64 チャンク>
%% tex64-figure+ <base64 チャンク>
% requires \usetikzlibrary{arrows.meta}   ← requires があるときのみ
\begin{tikzpicture}[...]
  ...
\end{tikzpicture}
```

- base64 は `JSON.stringify(scene)` の UTF-8 バイト列を base64 化し **100 文字ごと**に
  `%% tex64-figure+ ` 行へ分割。
- `<hash>` は **本体**（最後の `%% tex64-figure+` チャンク行の直後、つまり `\definecolor` /
  `% requires` / `\begin{tikzpicture}` の最初の行から `\end{tikzpicture}` まで、末尾改行込みの
  文字列）の FNV-1a 32bit ハッシュを 8 桁 hex で。
  crypto 依存なしの純関数として実装・export する（`fnv1a32(text: string): string`）。

エクスポート:

- `encodeFigureBlock(scene: Scene): string` — generateTikz を呼び、上記フォーマットの
  ブロック全文（末尾改行あり）を返す。
- `decodeFigureBlockAt(lines: string[], cursorLine: number): { scene: Scene; startLine: number; endLine: number; detached: boolean } | null`
  - `lines` はドキュメント全行（0-indexed）、`cursorLine` はカーソル行（0-indexed）。
  - カーソルを含む（または カーソル行が範囲内にある）図ブロックを探す: カーソル位置から上に
    `%% tex64-figure v1` を探し、そこから `\end{tikzpicture}` までをブロックとする。カーソルが
    ブロック範囲外（`\end` より下、次のヘッダより上）なら null。
  - base64 を復元 → JSON.parse → `validateScene`。失敗は null。
  - 現在の本体のハッシュを再計算し、ヘッダの h= と不一致なら `detached: true`。
- `base64EncodeUtf8(text: string): string` / `base64DecodeUtf8(b64: string): string` —
  Node と ブラウザ両対応（`typeof Buffer !== "undefined"` 分岐、ブラウザ側は
  `TextEncoder` + `btoa`）。DOM API には依存しないこと（`btoa` はグローバル関数で可）。

### Run 1 テスト（新規、node:test / .mjs）

- `tests/pro-canvas-tikz.test.mjs`:
  - 空シーン → `\begin{tikzpicture}` と `\end{tikzpicture}` のみ（mm なので x=1mm,y=1mm）
  - rect + named style → `/.style=` が picture オプションに出る、`\draw[stylename]` 参照
  - 数値丸め（1.23456 → 1.235、2.0 → 2）
  - 色: #000000 → black 参照、#3a7bd5 → `\definecolor{t643A7BD5}` が前置され 1 回だけ
  - 矢印 → `-{Stealth}` と requires `["arrows.meta"]` と `% requires` 行
  - closed path → `-- cycle`
  - group transform → `\begin{scope}[shift={(10,5)}, rotate=45]`、identity group は scope なし
  - fill のみ → `\fill`、両方 → `\filldraw`
- `tests/pro-canvas-codec.test.mjs`:
  - encode → decode round-trip でシーンが deep-equal
  - decode 後に本体 1 行を改変 → `detached: true`
  - ブロック外のカーソル → null、壊れた base64 → null
  - fnv1a32 の既知値 1 つ（例 `fnv1a32("")` === `"811c9dc5"`）

---

## Run 2: キャンバス UI + 配線

### 新規 `web-src/app/pro-canvas/canvas-ui.ts`

`export const initProCanvasUi = (deps: { getActiveGroup: () => { editor: unknown | null }; getWorkspaceFiles: () => string[] })`

full-window オーバーレイ（`position:fixed; inset:0; z-index` は既存モーダルより上）を開閉する
エディタ。**開くたびに DOM を生成し、閉じたら破棄**（常駐しない）。構成:

- 上部ツールバー: ツール（選択 / ペン / 直線 / 矩形 / 楕円 / ノード）、グリッド snap トグル、
  ズーム −/100%/+、Undo/Redo。
- 右インスペクタ: 選択オブジェクトの StyleProps（線色・塗り色・線幅・破線・不透明度・矢印・
  角丸）と、名前付きスタイル（一覧・新規作成・選択オブジェクトへ適用）。色は
  `<input type="color">` + 「なし」チェックボックス。
- 中央: SVG キャンバス。シーン座標は y 上向きなので、ルート `<g transform="scale(1,-1)">` 等で
  変換し、テキストは個別に打ち消す。グリッド線（scene.grid.size 間隔・薄色）、キャンバス境界
  矩形を描く。ズームは viewBox、パンは Space+ドラッグ。
- 下部バー: 「TikZ を挿入」「画像として挿入 (PNG)」/（再編集時は「更新」）「キャンセル」。

ツール挙動（C1 の最小限。凝らない）:

- **選択**: クリックで選択（ヒットは SVG 要素の data-id で）、ドラッグで移動、8 ハンドルで
  リサイズ、Shift+ドラッグ or 回転ハンドルで回転（rect/ellipse/path は座標を直接変換して
  焼き込む。group のみ Transform を持つ）。Delete で削除。Cmd/Ctrl+G でグループ化、
  Shift+Cmd/Ctrl+G で解除。
- **ペン**: クリックで line セグメント追加、ドラッグでハンドルを引き出して cubic。始点クリック
  or Enter でクローズ/確定、Esc で確定（オープンパス）。
- **直線/矩形/楕円**: ドラッグで作成。snap 有効時はグリッドに吸着。
- **ノード**: クリック位置に配置し、小さな入力ポップオーバーで LaTeX 文字列を編集
  （`$...$` を含む生 LaTeX。SVG 上は `<text>` にそのまま表示する近似で良い。
  MathLive 統合は C2 以降）。
- **Undo/Redo**: 操作確定ごとに `cloneScene` スナップショットを積む。Cmd/Ctrl+Z、
  Shift+Cmd/Ctrl+Z。オーバーレイ表示中はキーイベントを stopPropagation してエディタに
  漏らさない。

挿入・再編集・エクスポート:

- **TikZ 挿入**: `encodeFigureBlock(scene)` を `insertAtEditorCursor`
  （`./pro-editor-insert.js`）でカーソル位置へ。
- **再編集**: `initProCanvasUi` は `window` の CustomEvent `tex64:pro-canvas-open` を listen。
  detail = `{ scene?: Scene; replaceRange?: {startLine; endLine} }`。replaceRange 付きで開いた
  場合、「更新」はその範囲（1-indexed の monaco Range に変換）を `executeEdits` で
  新ブロックに置換する。
- **monaco アクション**: `web-src/app/monaco-setup.ts` のエディタコンテキストメニューに
  `tex64.pro-canvas-edit`（label:
  "Edit figure in canvas / 図をキャンバスで編集"）を追加。カーソル位置で
  `decodeFigureBlockAt` を試し、ヒットすれば scene + replaceRange 付きで、なければ
  新規シーンで `tex64:pro-canvas-open` を dispatch。`detached: true` のときは confirm ダイアログ
  「この図のコードは手編集されています。キャンバスで更新すると手編集分は失われます。続けますか？」
  を出してから開く。
- **PNG エクスポート**: SVG を `XMLSerializer` → `Image` → `<canvas>`（scene 1unit を
  mm→3.78px / cm→37.8px / pt→1.333px として **2 倍**スケールで描画）→ dataURL。保存は
  `tex64Files.writeBase64` + `chooseImageDirectory` + `buildIncludeGraphicsSnippet`
  （共通の `image-insert-utils.js` から import して再利用）。
  ファイル名 `figure-<timestamp>.png`。

### 配線

- `Resources/web/index.html`: `.pro-mode-controls` 内に
  `<button id="pro-canvas-open" type="button" title="Draw figure" hidden>✎ Draw</button>`。
  Code が有効な間だけ表示（`pro-mode-ui.ts` が Code/AI 切替時に hidden を切り替える）。
  クリックで新規シーンの `tex64:pro-canvas-open` を dispatch。
- `web-src/main-init.ts`: Code ワークスペース初期化時に `initProCanvasUi` を呼ぶ。
- `Resources/web/theme.css`: `pro-canvas-` プレフィックスのクラスでスタイル追加。既存の
  `--panel-*` / `--accent` / `--text-*` CSS 変数を使い、ライト/ダーク両テーマで破綻しないこと。

### Run 2 テスト

UI 本体の見た目テストは不要（プロジェクト方針）。ただし純関数は切り出してテストする:

- `tests/pro-canvas-ui-math.test.mjs`: 画面座標⇔シーン座標変換、グリッドスナップ、
  リサイズハンドルの座標計算など、canvas-ui.ts から export した純関数のテスト。

### 禁止事項（プロジェクト規約）

- バンドラ前提の npm ライブラリを持ち込まない（依存追加なし。素の DOM + SVG で書く）。
- `Resources/web/**/*.js` を手編集しない。
- ビルド用キーボードショートカットを追加しない。Cmd+B / Cmd+I / Cmd+R の既存割当を変えない。
- 既存のエディタ / live preview の挙動を変えない。
