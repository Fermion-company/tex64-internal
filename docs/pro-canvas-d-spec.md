# Pro 作図キャンバス D 実装仕様 — プロジェクト連動（プリアンブル / スタイル / 二重罫）

C1〜C4 の続き。キャンバスを「ユーザー自身のパッケージのデザインシステムの中」で動かす。
設計は Codex との事前協議済み（2026-08-13）。要点: root 検出は既存
`WorkspaceManager.rootInfo()` を再利用、read IPC は `workspace.readFile()` に委譲、
tikzset 走査はブレースカウント、**D2 の外部スタイルは `scene.styles` に混ぜない**。

実装は 2 ランに分割:

- **Run A（配線 + 純ロジック + テスト）**: read-text IPC、プリアンブル抽出、tikzset
  スキャナ、StyleProps の double、tikz-generate / sty-export の double 出力
- **Run B（UI）**: プリアンブルトグル、プロジェクトスタイル一覧、数値入力、SVG 近似の double

## D1: プロジェクトのプリアンブルでコンパイル

### main 側（Run A）

- `electron/main.cjs` に IPC `tex64:files:read-text`（payload `{ path }`）:
  `workspace.readFile(path)`（`electron/services/workspace.cjs` — 既存の
  `resolvePath` ガードを内蔵）に委譲し、`{ ok: true, text }` / `{ ok: false, error }` を返す。
  **サイズ上限 2MiB**（超過は error）。UTF-8 decode。
- `electron/preload.cjs`: `filesApi.readText`。`web-src/app/types.ts` の `FilesBridge` に
  `readText?` を追加。

### renderer 純ロジック（Run A）: 新規 `web-src/app/pro-canvas/project-context.ts`

DOM 非依存・テスト対象。

```ts
export const extractPreamble = (source: string): string | null
// \documentclass 行（オプション含む、行全体）を除き、その直後から
// \begin{document} の直前までを返す。\documentclass か \begin{document} が
// 無ければ null。コメント行はそのまま残す（フィルタしない — verbatim 方針）。

export const scanTikzsetStyles = (source: string): string[]
// \tikzset{...} ブロック（ブレースカウントで本体を特定）内と、素の
// `<name>/.style={...}` 出現から、スタイル名を収集して重複排除で返す。
// v1 で含める: `<name>/.style=`。除外: `.style n args` / `.style args` /
// `.code` / `.append style`（後者はベース `.style` が同一走査内に無い場合のみ除外、
// あれば名前は既に収集済みなので何もしない）。
// 名前は TikZ キー名として妥当なもの（/^[A-Za-z][A-Za-z0-9 _-]*$/ を trim）のみ。
```

### UI（Run B、`canvas-ui.ts`）

- ツールバー Live の隣に **「Doc」トグル**（`data-action="doc-preamble"`、
  localStorage `tex64.proCanvas.docPreamble`、既定 OFF）。
- ON のとき `buildStandaloneDoc` に第2引数 `{ preamble?: string }` を渡す
  （`standalone.ts` を拡張: preamble があれば `\usepackage{tikz}` / `\usetikzlibrary`
  行の**後ろ**にそのまま挿入。tikz の二重ロードは `\usepackage` の再読み込み無視で
  無害 — verbatim 方針）。
- プリアンブルの取得はキャンバス open 時に 1 回だけ（キャッシュ）:
  `deps.getRootFilePath()`（main-init から `workspaceController.getRootFilePath` を
  渡す。null なら Doc トグル disabled + title で理由表示）→ `tex64Files.readText`
  → `extractPreamble`。取得失敗/こ null は Doc トグル disabled。
- **フォールバック**: Doc ON でコンパイル失敗（diagnostics/エラー）したら、ステータスに
  エラーを出すだけでなく「Doc プリアンブルなしで再試行」を自動で 1 回行い、成功したら
  ステータスに「プリアンブル起因のエラーの可能性」と表示（トグルは OFF にしない）。

## D2: プロジェクト `\tikzset` スタイルの取り込み

- キャンバス open 時（Run B）: プリアンブル（D1 で取得済みテキスト）+
  `getWorkspaceFiles()` のうち `.sty` ファイル（**ワークスペース直下と 1 階層下まで**、
  最大 20 ファイル）を readText して `scanTikzsetStyles` に通し、名前一覧を作る。
- インスペクタの Named styles セクションに **「Project styles」サブリスト**を追加:
  各行は名前 + 「適用」ボタンのみ（編集・削除なし）。適用は `object.style.ref = name`。
- **`scene.styles` には追加しない**（.sty エクスポートと picture オプションの
  `/.style` 定義に混入させない）。`tikz-generate.ts` は ref をそのまま出す既存挙動の
  ままで正しい（変更不要）。
- SVG 近似では未知 ref は既定スタイル描画になるが、それで良い（実際の見た目は
  Doc トグル ON の Live コンパイルで出る — これが D1×D2 の合わせ技）。

## D3: 二重罫 + 数値入力

### モデル/生成（Run A）

- `StyleProps` に `doubleDistancePt?: number`（0 または未定義 = 二重罫なし）。
  `scene.ts` の DEFAULT_STYLE に `doubleDistancePt: 0`、`validateScene` に
  非負数チェックを追加。
- `tikz-generate.ts` / `sty-export.ts` の styleKeys: `doubleDistancePt > 0` のとき
  `double` と `double distance=Xpt` を出力（`double distance` は 0.6pt が TikZ 既定
  だが、明示指定で統一する）。
- 旧シーンの出力はバイト不変（既存テスト維持）。

### UI（Run B）

- インスペクタに「二重罫」number input（`doubleDistancePt`、0 でオフ）。
- SVG 近似: doubleDistancePt > 0 のオブジェクトは、パス/図形を 2 回描く —
  外側: 線幅 `2*lineWidth + distance` で draw 色、内側: 線幅 `distance` で
  紙色 `#ffffff`。（fill がある場合は fill を先に、その上に二重ストローク。）
- **数値入力**: 選択オブジェクトの X / Y / W / H を number input で編集
  （bounds ベース: 現 bounds → 入力値の新 bounds へ `resizeObject`/`moveObject` で写像。
  instance/code/group は transform 移動 + スケール。repeat はパスを写像）。
  X/Y は bounds の左下（y-up）。W/H は 0.01 未満を拒否。

## テスト（Run A）

- `tests/pro-canvas-project-context.test.mjs`:
  - extractPreamble: 通常文書 / \documentclass なし → null / \begin{document} なし → null /
    オプション付き documentclass / プリアンブル内の % コメント温存
  - scanTikzsetStyles: \tikzset ブロック内の複数定義 / ネストしたブレース入り本体 /
    `.style n args` と `.code` の除外 / 複数行本体 / 素の `name/.style=` / 重複排除
- `tests/pro-canvas-double.test.mjs`: doubleDistancePt → `double, double distance=1.2pt`
  が styleKeys に出る（named style 定義側とオブジェクト側の両方）、0/未定義では出ない、
  validateScene が負値を拒否、buildStyFile にも出る
- `tests/pro-canvas-standalone.test.mjs` に追記: preamble 付き buildStandaloneDoc が
  `\usepackage{tikz}` の後にプリアンブルを挿入すること
- read-text IPC はハンドラ薄皮のため単体テスト不要（workspace.readFile 既存挙動に委譲）。

## 制約

- C1〜C4 の規約踏襲。既存テスト無改変で green。
- `scene.styles` と D2 の外部スタイルの分離は厳守（.sty エクスポート汚染禁止）。
- main `.cjs` 変更（IPC 追加）→ Electron 再起動が必要（報告に明記）。
