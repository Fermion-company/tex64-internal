# prism-import-20261031

Prism（OpenAI のクラウド LaTeX、2027-01-01 終了）の「Export all projects」zip を
TeX64 に読み込む経路（ファイル > Prism から読み込む…、ランチャー／ファイルツリーへの
.zip ドロップ）の確認用。実物の書き出し zip は手元にないので、構造を模した合成 zip を置く。

## 中身

| ファイル | 内容 |
| --- | --- |
| `prism-export-sample.zip` | 2 プロジェクト入りの合成書き出し。zip 直下に `prism-export-sample/` の包みフォルダが 1 つある（読み込み時はこの包みを外して展開する） |
| `fixture-src/prism-export-sample/quantum-notes/` | 英語論文。pdflatex + bibtex（`\bibliographystyle{plain}`）、`figures/ellipse.pdf`（standalone 製）。`main.pdf` は **式 (3) と `\cite{dirac1958}` を足す前の原稿** から組んだ「Prism の最終 PDF」。読み込み後の比較で式番号 2→3、引用 3→5 の相違が出る |
| `fixture-src/prism-export-sample/nihongo-report/` | 日本語レポート。`ltjsarticle` + `luatexja-fontspec`（lualatex）、`conversations/2026-10-12-heat-equation.json`（チャットログ）。`report.pdf` は現行原稿と同じなので比較は「一致」 |
| `prism-import-dialog-diff.png` | 読み込みダイアログ（quantum-notes の比較結果まで進んだ状態、日本語 UI、評価 r1 反映後） |
| `prism-import-dialog-notex.png` | .tex の無い zip を読んだときの「判定」失敗の表示 |
| `prism-import-dialog-failure.png` | nihongo-report を pdflatex で組んだときの失敗表示（`luatexja-core.sty:79` の原因 1 行と「詳細を見る」） |

zip の作り直し: `fixture-src/` で `zip -r -X ../prism-export-sample.zip prism-export-sample`。
`quantum-notes/main.pdf` は `main.tex` から `\subsection{Spectrum}` の段落と `~\cite{dirac1958}` を外した
一時ファイルを pdflatex → bibtex → pdflatex ×2 で組んだもの。`nihongo-report/report.pdf` は lualatex ×2。

## 判定の確認（`node -e`）

`electron/services/prism-import.cjs` の純関数に対して確かめた内容:

- `findProjects`: 包みフォルダ 1 段の下の 2 プロジェクトを見つける。zip 直下に `.tex` がある単一プロジェクト、`export/projects/<name>/` の 2 段包み、`__MACOSX/` の無視。
- `normalizeZipPath`: `../`、絶対パスを拒否。
- `analyzeProject`: quantum-notes → `main.tex`（`figures/ellipse.tex` も `\documentclass` を持つが `main` が勝つ）、pdflatex、bibtex、`main.pdf`。nihongo-report → `report.tex`、lualatex（`luatexja-fontspec`）、文献なし、`conversations/*.json` 1 件。
- `detectEngine`: `xeCJK` → xelatex、`jsarticle` + `uplatex,dvipdfmx` → uplatex、`fontspec` のみ → xelatex、その他 → pdflatex。
- `detectBibTool`: `biblatex[backend=bibtex]` → bibtex、`biblatex` のみ → biber、`\bibliographystyle` → bibtex。
- `conversationToMarkdown`: `messages[]` 形式と ChatGPT 風 `mapping{}` 形式を `notes/prism-conversations/<name>.md` に書く。
- `readPdfOutline` / `comparePdfOutlines`: タイトル・節見出し・式番号・引用・ページ数。

## 実機の確認（2026-10-31）

worktree から `TEX64_AI_MODE_ENABLED=0` で起動し、ファイル > Prism から読み込む… → zip を選ぶ →
展開先を選ぶ → ダイアログが 展開 → 判定 2 → 環境 MacTeX / TeX Live 2026 → ビルド → 比較 まで自動で進む。
nihongo-report は「一致」、プロジェクトを quantum-notes に切り替えると再ビルドのうえ
「式番号 Prism: 2 / TeX64: 3」「引用 Prism: 3 / TeX64: 5」「一致: タイトル、節見出しの順序、ページ数」。
「このプロジェクトを開く」で quantum-notes がワークスペースとして開き、`.tex64/settings.json` に
`rootFile: main.tex` が入っている。Prism の PDF はビルドが上書きする前に `main.prism.pdf` へ写してある。

未確認: `.zip` のドラッグ＆ドロップ（OS のファイルドラッグを自動操作できなかった）、
TeX 未導入機でのオンボーディングへの受け渡しと `resume`、managed light 環境での不足パッケージ自動導入。

## 評価 r1（2026-10-31）の反映後の再実走

Playwright `_electron` で `dialog.showOpenDialog` を差し替えて確認（ドライバはこのフォルダには置かない）:
壊れた zip →「zip として読めません。」、無い zip →「zip ファイルが見つかりません。」、.tex 無し → 判定の行に「zip に .tex ファイルがありません。」。
展開 `8/8`・判定 `2 プロジェクト` の進行が `start` の応答前から出る。quantum-notes で文献ツールを「なし」にすると
引用 3 件 → 0 件・節見出し 5 件 → 4 件（References 消失）に変わる。組版中に閉じてすぐ読み直しても「Build is already running」にならない。
エンジンは `.tex64/settings.json` の `buildProfiles[prism-import].extraArgs`（`-pdf -bibtex` など）に入り、全体の `tex64.compileEngine` は変えない。

## 評価 r2（2026-10-31）の反映

エンジンはビルドプロファイルの正規の項目 `engine` に保存する（設定 > ビルドのプロファイル欄に「Engine」セレクトを追加、
有効なプロファイルが engine を持つときは Compilation Engine の表示をそれに固定）。「詳細を見る」はプロジェクトが開いて
いなければ先に開いてから Issues タブへ渡す。失敗の原因は `.log` / 転写の `file:line:` 診断（79 桁折り返しを結合）から
先頭 1 件を出す。展開中の件数は `start` 応答前から更新、ビルド中は「ビルド中… Ns」、プロジェクト切替時は結果欄の高さを保つ。
