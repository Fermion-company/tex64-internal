# tex64 ⇄ VS Code LaTeX Workshop 差分分析（移行観点）

目的: VS Code の LaTeX Workshop から tex64 へ移行する際に「困る点」を先に洗い出し、実装を埋める優先度を付ける。

注意: ここでは **LaTeX Workshop が提供する機能**にフォーカスします（VS Code 本体の Git/拡張/タスク/キー設定などは別問題）。

## 参照（web）

- LaTeX Workshop: README（機能カテゴリ）: https://github.com/James-Yu/LaTeX-Workshop
- Wiki: Compile: https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile
- Wiki: View: https://github.com/James-Yu/LaTeX-Workshop/wiki/View
- Wiki: Intellisense: https://github.com/James-Yu/LaTeX-Workshop/wiki/Intellisense
- Wiki: Linters: https://github.com/James-Yu/LaTeX-Workshop/wiki/Linters
- Wiki: Formatting: https://github.com/James-Yu/LaTeX-Workshop/wiki/Formatting
- Wiki: Hover: https://github.com/James-Yu/LaTeX-Workshop/wiki/Hover
- Wiki: Snippets: https://github.com/James-Yu/LaTeX-Workshop/wiki/Snippets
- Wiki: ExtraFeatures: https://github.com/James-Yu/LaTeX-Workshop/wiki/ExtraFeatures

## tex64 の現状（ローカル確認の要点）

ユーザー操作ベースの一覧は `implementation.md` を単一ソースとし、差分の根拠は主に以下です。

- ビルド: `electron/services/build.cjs`, `electron/handlers/build.cjs`
- Root file 検出: `electron/services/workspace.cjs`
- インデックス: `electron/services/indexer.cjs`
- 補完: `web-src/app/monaco-completion.ts`, `web-src/app/monaco-setup.ts`
- PDF: `Resources/web/pdf-viewer.js`, `electron/services/pdf.cjs`
- Outline UI: `web-src/app/outline-ui.ts`

## 差分一覧（LaTeX Workshop → tex64）

このドキュメントで扱うのは「執筆（書く/直す/コンパイルして確認する）」において、
VS Code（LaTeX Workshop）からの移行で **障壁になりうる不足**だけです。

除外するもの（移行の障壁ではない/tex64 の方針で不要）:
- word count（`texcount`）: 執筆フローの必須要件ではないため入れない
- 自動ビルド: tex64 は自動保存が前提で、ビルドは明示操作で十分（勝手に走る方が不快になりやすい）

表記:
- PARTIAL: 一部はあるが不足
- TODO: ほぼ未実装

### 1) Compile / Build

- PARTIAL: Root file discovery
  - 現状: ワークスペース単位の自動推測+手動固定
  - 不足: `%!TEX root = ...` 等のマジックコメントや、アクティブファイルから root を解決する挙動
- TODO: Recipes/Tools（コマンド/引数/環境変数/プレースホルダのカスタム）
  - 例: `-shell-escape`、outdir、biber/bibtex の切替、プロジェクト固有の `latexmkrc` など

移行上の痛点（優先度高）:
- サブファイル（章ファイル等）を開いて執筆→ビルド、の導線で root を外すと手戻りが大きい
- プロジェクト流儀（shell-escape/outdir/biber 等）を吸収できないと「そもそもコンパイルできない」が起きる

### 2) View / PDF / SyncTeX

- PARTIAL: SyncTeX forward
  - 現状: build 成功時の自動 forward はある
  - 不足: 手動 forward ボタン、PDF 上の視覚フィードバック（マーカー）
- PARTIAL: SyncTeX reverse
  - 現状: PDF 上 Ctrl/Cmd+Click → ソースへジャンプ
  - 不足: 候補が複数ある場合の UI、ジャンプ先のペイン選択など
- TODO: PDF 表示の強化（outline/thumbnails、dark/invert など）

移行上の痛点（優先度高）:
- PDF 側のナビ（outline/サムネ）が弱いと、長文で迷子になりやすい
- forward の “どこに飛んだか” が見えないと、執筆の確認ループが遅くなる

### 3) Intellisense（補完）

- TODO: パス補完（`\\input/\\include/\\includegraphics` 等）
  - `\\input{}` / `\\include{}` は “現在ファイル基準の相対パス” が最重要
  - `\\includegraphics{}` は画像拡張子/候補ファイルの提示があると移行が滑らか

移行上の痛点（優先度高）:
- 参照先ファイル/画像を探すためにエクスプローラと往復する回数が増える

### 4) Structure / Outline（ナビゲーション）

- PARTIAL: Structure/Outline（プロジェクト全体+cursor follow が弱い）
  - 現状: “現在ファイルのみ” の表示が中心
  - 不足: include を跨いだ全体の構造を眺めてジャンプできない

### 5) Hover / Preview（その場で確認）

- TODO: `\\ref{}` hover（定義位置・近傍テキスト）
- TODO: `\\cite{}` hover（定義位置・bib の最低限情報）
- TODO: `\\includegraphics{}` hover（画像プレビュー）

移行上の痛点（優先度高）:
- 参照の中身確認でファイル移動が増えると、執筆テンポが落ちる（“調べる”の往復）

### 6) Linters / Diagnostics（早いフィードバック）

- TODO: ChkTeX / LaCheck 等の lint 実行（手動 or 任意で onSave）
- TODO: Monaco markers への反映（下線/Problems 的な表示）
- TODO: 重複ラベル検知など（最低限の品質チェック）

移行上の痛点（優先度高）:
- 「ビルドまで気付けない」タイプのミスが増えると、手戻りが大きい

### 7) Snippets / Editing helpers（書く速度）

- TODO: 環境スニペット（figure/table/align/itemize など最小セット）
- TODO: `\\begin{...}` 補助（close environment、wrap selection など）

移行上の痛点（優先度高）:
- 雛形入力が遅くなると、体感で “VS Code から劣化した” になりやすい

### 8) clean（詰まりの復旧）

- TODO: `latexmk -c/-C` 相当の clean（確認付き）

移行上の痛点（優先度高）:
- ビルドが壊れたときに “復旧の定番手順” が無いと、移行先として不安が残る

## 移行優先度（提案）

### P0（移行の障壁のみ）

1. Root file discovery（TeX magic comment + active file から root 解決）
2. Recipes/Tools（ビルドの柔軟性。プロジェクト流儀を吸収）
3. Intellisense: パス補完（`\\input/\\include/\\includegraphics`）
4. Structure/Outline: プロジェクト全体の構造表示 + ジャンプ
5. Lint（まずは Issues 表示、余力で markers）
6. Hover（まずは ref/cite の “定義位置”）
7. Snippets（最小セット）
8. clean（確認付き）
9. PDF（outline/thumbnails と forward マーカー）

実装規模の目安（主観 / 既存コード前提）:

| 項目 | 規模 | 主な変更場所（目安） | 依存 |
| --- | --- | --- | --- |
| Root file discovery（TeX magic） | M | `electron/services/workspace.cjs` | index/structure と連携すると効く |
| Recipes/Tools | M | `electron/services/build.cjs`, `electron/services/user-settings.cjs` | UI の設定項目 |
| パス補完（input/include/graphics） | S〜M | `web-src/app/monaco-completion.ts` | workspace files / index |
| プロジェクト Outline 強化 | M | `electron/services/indexer.cjs`, `web-src/app/outline-ui.ts` | include 解析を入れるかで変わる |
| Lint（ChkTeX 等） | M | `electron/services/lint.cjs`（新規）, `web-src/app/monaco-setup.ts` | 外部コマンド |
| Hover | S〜M | `web-src/app/monaco-setup.ts` | index / 画像 / bib |
| Snippets | S | `web-src/app/monaco-completion.ts` | Monaco snippet |
| clean | S | `electron/services/build.cjs` or `electron/services/clean.cjs`（新規） | 外部コマンド |
| PDF 強化 | M | `Resources/web/pdf-viewer.js` | UI/見た目は `Resources/web/pdf-viewer.*` も |

## tex64 側の実装ガイド（差分を埋めるときの置き場）

- 外部コマンド系（build toolchain）は `electron/services/*` + `electron/handlers/*` に寄せ、結果は Issues に集約する。
- エディタ連携（completion/hover/snippets/markers）は `web-src/app/monaco-setup.ts` に入口を置く（既存の completion の流れに合わせる）。
- Root file / 依存解析は `electron/services/workspace.cjs` と `electron/services/indexer.cjs` を分離し、UI からは “root の現在値” と “推定根拠” を見せるのが安全（誤検出の不安を減らす）。
