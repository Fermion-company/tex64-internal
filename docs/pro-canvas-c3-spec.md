# Pro 作図キャンバス C3 実装仕様 — シンボル / リピート / .sty エクスポート

C1/C2 の続き。ブックデザイナー向けの中核: オーナメントを 1 回定義して変換インスタンスで
使い回し、生成 TikZ を `\pic` + scope 変換のイディオマティックな形に保つ。

## 1. シーンモデル拡張（`scene.ts` — 後方互換で拡張）

```ts
export type SymbolDef = { id: string; name: string; objects: SceneObject[] };
// name は TikZ 識別子（/^[A-Za-z][A-Za-z0-9]*$/）。\pic 名になる。

export type SceneObject =
  | ...既存 5 種...
  | { id: string; type: "instance"; symbol: string /* SymbolDef.id */; transform: Transform; style: ObjStyle }
  | { id: string; type: "repeat"; symbol: string; path: { start: Vec; segments: PathSeg[] };
      count: number; align: boolean; style: ObjStyle };
// instance: シンボルの配置。repeat: パスに沿って count 個を等間隔配置（align=true で接線方向に回転）。

export type Scene = { ...既存...; symbols?: SymbolDef[] };  // 省略時 [] 扱い
```

- `validateScene` を拡張（symbols 省略可・instance/repeat の防御的検証。symbol 参照先が
  無い場合も **valid とし、生成時に skip**（壊れたデータで全体を落とさない））。
- v は 1 のまま（後方互換: 旧 JSON は symbols なしで通る）。
- ヘルパー追加: `findSymbol(scene, id)`、`symbolBounds` は UI 側（canvas-ui / canvas-math）
  の既存 bounds ロジックを流用してよい。

## 2. TikZ 生成（`tikz-generate.ts` 拡張）

- **シンボル定義** → picture オプションに pic 定義を出す:

```
\begin{tikzpicture}[x=1mm,y=1mm,
  mystyle/.style={...},
  ornamentA/.pic={
    \draw ... ;
    \draw ... ;
  }]
```

  - pic 本体は該当 SymbolDef.objects を通常のオブジェクト出力（インデント +1）で並べたもの。
  - **使われている**シンボルだけ定義を出す（instance/repeat から参照されるもの。未使用は省略）。
- **instance** → `\pic[<スタイルキー>, <変換キー>] at (0,0) {ornamentA};` ではなく、
  TikZ の慣用に合わせ **変換はオプションで**:
  `\pic[shift={(x,y)}, rotate=R, xscale=Sx, yscale=Sy] {ornamentA};`
  （identity 成分は省略。sx===sy なら scale=S。スタイル ref/props は group と同様に前置）。
  鏡映は xscale=-1 で表現される（UI の左右/上下反転ボタンの結果がこれ）。
- **repeat** → `\foreach` で出力。パスに沿った等間隔配置は **折れ線近似**で計算せず、
  TikZ 側の `decorate`/`markings` は使わず、**生成時に JS で各配置点と接線角を計算して
  展開せずに** 座標リストを `\foreach \p/\a in {(x1,y1)/a1, (x2,y2)/a2, ...}` 形式で出す:

```
\foreach \p/\a in {(0,0)/0, (10,2.5)/14.04, ...}
  \pic[shift={(\p)}, rotate=\a] {ornamentA};
```

  - align=false のときは角度を常に 0 とし `\foreach \p in {...} \pic[shift={(\p)}] {ornamentA};`。
  - 配置点計算は新規純関数 `samplePathPoints(path, count): Array<{point: Vec; angleDeg: number}>`
    を `canvas-math.ts` に追加（cubic は 32 分割の弧長近似で等間隔化。line はそのまま）。
    tikz-generate から import する（canvas-math は DOM 非依存なので可）。
- スタイルキー順序・数値丸め等は C1 規則のまま。

## 3. キャンバス UI（`canvas-ui.ts` 拡張）

- インスペクタに **Symbols セクション**:
  - 「選択をシンボル化」ボタン: 選択オブジェクトを SymbolDef に移し、その場を instance で置換
    （名前は prompt、識別子検証）。
  - シンボル一覧: 各行に「配置」（アートボード中央に instance 追加）「編集」「削除」
    （参照 instance/repeat がある場合は削除拒否してステータスに理由表示）。
  - **編集モード**: シンボルの中身をキャンバスで開く（オブジェクト一覧をシーンの代わりに
    編集し、「シンボル編集終了」で戻る簡易実装で良い。ネスト編集は不可）。
- instance の描画: `<g transform="translate rotate scale">` で SymbolDef.objects を描画
  （`<use>` は使わず単純再帰描画で良い。symbols はネスト参照不可 — instance/repeat を
  SymbolDef.objects 内に入れることは UI 上できない、validateScene でも拒否）。
- instance の操作: 移動 = transform.tx/ty、回転 = C1 の `rotateTransformAround`、
  リサイズ = sx/sy 更新。**反転ボタン**（インスペクタ: 左右反転/上下反転 = sx*=-1 / sy*=-1）。
- repeat の作成: シンボル一覧の「パスに沿って配置」→ 次に描くパス（ペン/直線ツールで確定）
  が repeat オブジェクトになる、は複雑なので **既存パス選択中に「選択パスに沿って配置」**
  ボタン（対象シンボルを select で選ぶ）。count は number input、align は checkbox
  （インスペクタで repeat 選択時に編集可）。パス自体は repeat にコピーして保持
  （元パスは残す。消したければユーザーが消す）。
- repeat の描画: samplePathPoints で各点に SymbolDef.objects を描画。

## 4. .sty エクスポート

- 下部バーに「**.sty へ書き出し**」ボタン。モーダルではなく prompt でファイル名
  （既定 `figures.sty`、拡張子強制）。
- 新規純関数 `web-src/app/pro-canvas/sty-export.ts`:

```ts
export const buildStyFile = (scene: Scene, packageName: string): string
```

```
\NeedsTeXFormat{LaTeX2e}
\ProvidesPackage{<packageName>}[2026/08/13 TeX64 figure symbols]
\RequirePackage{tikz}
\usetikzlibrary{arrows.meta}     ← 必要時のみ
<definecolor 群（シンボル内で使う色）>
\tikzset{
  ornamentA/.pic={ ... },
  ...
}
\endinput
```

  - 全シンボル（未使用含む）を出す。名前付きスタイル（scene.styles）も `\tikzset` に含める。
- 保存は `tex64Files.writeBase64`（テキストを base64 化）でワークスペース直下
  `<name>.sty`。成功したらステータスに「\usepackage{<name>} で使えます」。

## 5. テスト

- `tests/pro-canvas-symbols.test.mjs`（新規）:
  - instance あり → picture オプションに `/.pic=` 定義、`\pic[shift={(...)}] {name};` 出力、
    未使用シンボルの定義が出ない
  - xscale=-1 の instance → `xscale=-1` がオプションに出る
  - repeat(align=true) → `\foreach \p/\a in {...}` 形式、count 個の座標、角度が単調
  - repeat(align=false) → `\foreach \p in {...}` 形式
  - validateScene: symbols 付き JSON が通る / SymbolDef.objects 内の instance は invalid /
    symbols 省略の旧 JSON が通る（後方互換）
  - samplePathPoints: 直線 (0,0)→(10,0) count=3 → x=0,5,10 / angle=0
- `tests/pro-canvas-sty.test.mjs`（新規）: buildStyFile が ProvidesPackage /
  tikzset pic 定義 / endinput を含む。矢印使用時のみ usetikzlibrary。
- round-trip: 既存 codec テストに symbols 付きシーンの encode→decode ケースを 1 つ追加。

## 制約

- C1/C2 の規約を踏襲（依存追加なし、生成物手編集禁止、既存 API 変更は validateScene /
  SceneObject 型の拡張のみ）。
- 旧シーン JSON（symbols なし）の decode・TikZ 生成が 1 バイトも変わらないこと
  （既存テストが保証）。
