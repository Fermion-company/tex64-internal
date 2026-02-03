# tex64 移行障壁の解消プラン（VS Code / LaTeX Workshop）

対象: `docs/latex-workshop-gap-analysis.md` の「P0（移行の障壁のみ）」に残した項目。

このプランでは「執筆（書く/直す/コンパイルして確認する）」の移行障壁だけを扱い、
word count と自動ビルドは対象外とする。

## 0) ステータスまとめ（コード確認ベース）

凡例:
- PARTIAL: 一部のみ実装/不足
- TODO: ほぼ未実装

| 項目 | 状態 | 現状の根拠（主な関連ファイル） |
| --- | --- | --- |
| Root file discovery（TeX magic / active file からの解決） | PARTIAL | ワークスペース単位の自動推測+手動固定はあるが、`%!TEX root = ...` 等は未対応（`electron/services/workspace.cjs`） |
| Recipes/Tools（ビルドの柔軟性） | TODO | `latexmk` の固定呼び出しのみで、ユーザー定義の build プロファイルが無い（`electron/services/build.cjs`） |
| Intellisense: パス補完（input/include/graphics） | TODO | `\\ref`/`\\cite` はあるがパス補完が無い（`web-src/app/monaco-completion.ts`） |
| プロジェクト全体 Structure/Outline | PARTIAL | インデックスは全体生成しているが Outline UI は「現在ファイル」に寄っている（`electron/services/indexer.cjs`, `web-src/app/outline-ui.ts`） |
| Lint（ChkTeX 等） | TODO | lint 実行/markers/Issues 取り込みが無い（該当 service/IPC が無い） |
| Hover（ref/cite/graphics） | TODO | Monaco hover provider が無い（`web-src/app/monaco-setup.ts`） |
| Snippets（環境雛形） | TODO | Monaco completion に snippet が無い（`web-src/app/monaco-completion.ts`） |
| clean（補助ファイル掃除） | TODO | `latexmk -c/-C` 相当の導線が無い |
| PDF 強化（outline/marker 等） | PARTIAL | pdf.js ビューアはあるが outline/thumbnails/forward marker が無い（`Resources/web/pdf-viewer.js`） |

## 1) 仕様方針（実装前に固める）

- 「自動確定は禁止」方針に合わせ、破壊的操作や一括変更は必ず確認ステップを入れる。
- 重い処理（build / index）は非同期で、UIブロック・ログ洪水を避ける（Issues に集約）。
- 外部コマンドやビルドの流儀差は、設定で明示できるようにする（暗黙の魔法を増やしすぎない）。

## 2) 実装プラン（MVP → 仕上げ）

### 2-1) Root file discovery（PARTIAL → DONE）

目的:
- アクティブファイルから “正しい root” を解決し、build/intellisense/structure の前提を揃える（VS Code で当たり前の挙動）。

MVP:
- [ ] TeX magic comment（例: `%!TEX root = ../main.tex`）の解析
- [ ] build は「現在ファイル→root 解決→その root を main にして実行」を基本にする
- [ ] UI に “root の現在値” と “推定根拠（manual/auto/magic）” を表示（誤検出の不安を減らす）

仕上げ:
- [ ] `subfiles` 等の流儀のサポート（必要なら）
- [ ] include 依存（`\\input/\\include`）の解析を indexer/structure と共有

完了条件:
- サブファイルを開いて build しても、期待する root がビルドされる。

### 2-2) Recipes/Tools（TODO → DONE）

狙い:
- `latexmk` 固定だけだと “流儀差” を吸収できない（biber/latexmkrc/outdir/特殊エンジン等）。LaTeX Workshop の recipe/tool 概念に近い逃げ道が必要。

MVP:
- [ ] `.tex64/settings.json`（または別ファイル）に build プロファイルを定義できるようにする
  - 例: `command`, `args`, `env`, `cwd`, `timeoutMs`
- [ ] UI から “現在のプロファイル” を選択できる
- [ ] 失敗時は Issues に “実行したコマンド” と “終了コード” を必ず残す（再現性のため）

仕上げ:
- [ ] LaTeX Workshop 互換に寄せた placeholder 展開（root / outDir / jobname 等）
- [ ] `latexmk` 以外の toolchain（必要最小限で）

完了条件:
- 典型的な「プロジェクトの流儀差」を GUI だけで吸収できる。

### 2-3) Intellisense: パス補完（TODO → DONE）

現状:
- `\\ref{` / `\\cite{` の補完はインデックスから供給。
- `\\input{}` / `\\include{}` / `\\includegraphics{}` のパス補完は無い。

MVP:
- [ ] `\\input{` / `\\include{` の “パス補完”
  - 現在ファイルのディレクトリ基準で相対パス提示（`sections/intro` 等）
- [ ] `\\includegraphics{` の “画像パス補完”（拡張子候補、サブフォルダ対応）

完了条件:
- include/input/graphics のパス補完が実用レベルで動く。

### 2-4) プロジェクト全体 Structure/Outline（PARTIAL → DONE）

現状:
- indexer は全 `.tex/.bib` を走査して sections を収集。
- Outline UI は “現在ファイルのみ” に寄っている。

MVP:
- [ ] Outline に “現在ファイル / プロジェクト” 切り替えを追加
- [ ] “プロジェクト” の場合は `sections` をファイル単位でまとめて表示し、クリックで該当箇所へジャンプ

仕上げ:
- [ ] `\\input/\\include` を解析してツリー化（chapter → include 先）し、実プロジェクト構造に寄せる

完了条件:
- include を多用するプロジェクトで “全体の見取り図” として機能する。

### 2-5) Lint（ChkTeX/LaCheck）（TODO → DONE）

MVP:
- [ ] Electron service 追加（例: `electron/services/lint.cjs`）で外部コマンドを実行し、結果を `IssueItem` に変換
- [ ] IPC 追加（例: `lint:run` / `lint:result`）と UI 反映（Issues に出す）
- [ ] 実行タイミング: 手動ボタン（まずは確実に）＋任意で onSave

仕上げ:
- [ ] Monaco markers にも反映（Problems 的に下線）
- [ ] 実行環境チェックに `chktex`/`lacheck` を追加（未導入時の導線）

完了条件:
- lint 結果が Issues（できれば markers）に出て、該当行へジャンプできる。

### 2-6) Hover（TODO → DONE）

MVP:
- [ ] `\\ref{}` hover: 定義ファイル/行 + クリックでジャンプ
- [ ] `\\cite{}` hover: 定義ファイル/行（まずは位置だけ）
- [ ] `\\includegraphics{}` hover: 画像パスの存在確認（余力でプレビュー）

完了条件:
- “調べるための移動” が減り、参照の確認がその場でできる。

### 2-7) Snippets / Editing helpers（TODO → DONE）

MVP:
- [ ] figure/table/align/itemize のスニペット（最小セット）
- [ ] `\\begin{...}` → `\\end{...}` 補助（close environment 相当）

完了条件:
- 雛形入力の体感が VS Code と大きくズレない。

### 2-8) clean（TODO → DONE）

MVP:
- [ ] `latexmk -c`（必要なら `-C`）を実行する handler/service を追加
- [ ] UI から実行（確認付き）

完了条件:
- “ビルドが壊れたときの復旧ボタン” がある。

### 2-9) PDF 強化（PARTIAL → DONE）

MVP:
- [ ] forward sync のマーカー表示（PDF 上で “どこに飛んだか” を視覚化）
- [ ] outline/thumbnails のどちらかを追加（長文ナビを改善）

完了条件:
- PDF 側のナビ/フィードバックが執筆用途で十分になる。

## 3) ドキュメント更新（実装と同時に行う）

- [ ] `README.md` の「現行仕様（要点）」の該当箇所を更新（SyncTeX/Build/Outline 等）
- [ ] `implementation.md` の各セクションも実装に合わせて更新（“できること” の単一ソースとして維持）
