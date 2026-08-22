# Pro 作図キャンバス C4 実装仕様 — コードオブジェクト / AI 経路 / SVG インポート

C1〜C3 の続き。表現力の「逃げ道」を塞ぐ最終フェーズ。

## 1. コードオブジェクト（シーンモデル + 生成 + UI）

シーンモデルで表現できない任意の TikZ 断片をキャンバスに置けるようにする。

### モデル（`scene.ts` 拡張・後方互換）

```ts
| { id: string; type: "code"; tikz: string; transform: Transform }
```

- `tikz` は `\begin{tikzpicture}` を**含まない**素の TikZ 文（複数行可。`\draw ...;` 等）。
- validateScene: `tikz` は string、transform は既存検証。SymbolDef.objects 内にも置ける
  （pic 定義の中に任意コードを含められるのは TikZ 的に自然）。

### TikZ 生成（`tikz-generate.ts`）

- transform が identity → `tikz` をインデントだけ揃えてそのまま出力。
- 非 identity → `\begin{scope}[...変換キー...]` で包む（group と同じキー生成）。
- `tikz` 内に `\usetikzlibrary` 由来の機能が要る場合はユーザー責任（requires 推定はしない）。
  ただし文字列に `-{Stealth` / `{Stealth}-` 等 arrows.meta 記法が含まれるかの**素朴な検出**で
  requires に `arrows.meta` を足すのは可（誤検出しても無害）。

### UI（`canvas-ui.ts`）

- ツールに「コード」追加: クリック位置に code オブジェクトを作成し、複数行 textarea の
  ポップオーバーで TikZ 文を編集（再編集は select ツールでダブルクリック）。
- 近似描画は不可能なので、**プレースホルダ表示**: 破線枠 + `</>` ラベル
  （bounds は transform 原点に固定サイズ 10×10）。C2 の Live コンパイルが ON なら
  実描画がビットマップに現れる（これが本来の見た目）。
- 操作: 移動/回転/リサイズは transform 更新（instance と同じ扱い）。

## 2. AI 経路 — スケッチ/画像 → TikZ

「フリーハンドで描きたい・手元の画像を TikZ にしたい」の受け皿。既存 texize ブリッジを使う。

- 下部バーに「**AI で TikZ 化**」ボタン: ファイル選択（image/*）または
  **現在のキャンバスの近似 SVG を PNG 化したもの**（確認ダイアログで選択:
  「画像ファイルを選ぶ / 今のキャンバスを下絵にする」→ 実装は `confirm` でよい）を
  `tex64Texize.snippet({ imageBase64 })` へ渡す。
- 返ってきた TeX 断片を textarea プレビューで見せ、「コードオブジェクトとして配置」
  ボタンで code オブジェクト（identity transform、位置はアートボード中央）として追加。
  tikzpicture 環境が含まれていたら中身だけ剥がして入れる（`\begin{tikzpicture}...\end` の
  外側を除去する素朴な文字列処理。純関数 `stripTikzWrapper(tex: string): string` を
  `code-import.ts` に置きテスト対象に）。
- texize が使えない環境ではボタン disabled。

## 3. SVG インポート

Illustrator 等から SVG を持ち込み、シーンオブジェクトへ変換する。

### 新規 `web-src/app/pro-canvas/svg-import.ts`

```ts
export const importSvg = (svgText: string, targetWidth: number): { objects: SceneObject[]; warnings: string[] } | null
```

- DOMParser で解析（renderer 専用モジュール。canvas-ui からのみ import。テストは
  パス変換の純関数部分を分離して行う — 下記）。
- 対応要素: `rect` `circle` `ellipse` `line` `polyline` `polygon` `path` `g`（transform 付き）
  `text`（内容を node に）。それ以外（gradient, image, clipPath 等）は skip して warnings に
  名前を積む。
- `path` の d 属性は M/L/H/V/C/S/Q/T/Z（大文字小文字）を cubic/line セグメントへ変換。
  Q/T は cubic 昇格、S は制御点反射、A（円弧）は**未対応で skip + warning**。
  この d パーサは**純関数** `parseSvgPathData(d: string): { start: Vec; segments: PathSeg[]; closed: boolean } | null`
  として export（DOM 非依存・テスト対象）。
- 座標系変換: SVG は y 下向き → シーンは y 上向き。全体 bbox を取り、
  `targetWidth`（既定: アートボード幅の 80%）に収まるよう一様スケールし、アートボード
  中央に配置。fill/stroke/stroke-width は StyleProps へマップ（`fill="none"` → null、
  色は hex 化。named color は黒に fallback して warning）。
- `g` の transform（translate/scale/rotate/matrix）は**子座標へ焼き込み**（matrix は
  分解せず各点に直接適用。回転を含む matrix は path/線分には焼き込めるが rect/ellipse は
  グループ化 + Transform 近似でよい。シンプル優先、warnings に注記）。

### UI

- 下部バー「**SVG 取り込み**」: `<input type="file" accept=".svg">` → importSvg →
  objects をグループ 1 個にまとめてシーンに追加・選択状態に。warnings があれば
  ステータスに件数 + 先頭 1 件。

## 4. テスト

- `tests/pro-canvas-code-object.test.mjs`: code オブジェクトの TikZ 生成
  （identity = そのまま / transform = scope 包み / arrows.meta 素朴検出）、
  validateScene が code を通す、codec round-trip。
- `tests/pro-canvas-code-import.test.mjs`: stripTikzWrapper（tikzpicture あり/なし/
  オプション付き begin）。
- `tests/pro-canvas-svg-path.test.mjs`: parseSvgPathData — M/L/Z の三角形、C カーブ、
  Q→cubic 昇格、H/V、相対コマンド(m l c)、A を含む d は null でなく警告付き skip
  （セグメント落ちで続行）。

## 制約

- C1〜C3 の規約踏襲。依存追加なし（SVG パースはブラウザ DOMParser + 自前 d パーサ）。
- 旧シーン JSON の出力不変（既存テスト維持）。
- `.sty` エクスポート・シンボル等 C3 の API は変更しない（code を SymbolDef.objects に
  許可する validateScene 変更のみ）。
